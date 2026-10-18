// Fixed, read-only telemetry helper. Never accepts paths or commands from callers.
export function remoteResourceProbe() {
  const fs = require("fs"), os = require("os"), path = require("path").posix;
  const read = (file) => { try { return fs.readFileSync(file, "utf8").slice(0, 32768); } catch { return ""; } };
  const cpu = read("/proc/stat").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  const mem = read("/proc/meminfo"), getMem = (name) => Number(new RegExp("^" + name + ":\\s+(\\d+)", "m").exec(mem)?.[1] || 0) * 1024;
  let cpuCores = os.cpus().length || 1, totalMemoryBytes = getMem("MemTotal") || os.totalmem();
  let memoryAvailableBytes = getMem("MemAvailable") || getMem("MemFree"), scope = "host", cgroupCpuUsageUs;
  const group = /^0::([^\n]+)$/m.exec(read("/proc/self/cgroup"));
  if (group && !group[1].split("/").includes("..")) {
    let directory = path.join("/sys/fs/cgroup", group[1]);
    for (let depth = 0; depth < 16 && directory.startsWith("/sys/fs/cgroup"); depth++) {
      const quota = read(path.join(directory, "cpu.max")).trim().split(/\s+/).map(Number);
      if (quota[0] > 0 && quota[1] > 0 && quota[0] / quota[1] < cpuCores) {
        cpuCores = quota[0] / quota[1]; scope = "cgroup";
        cgroupCpuUsageUs = Number(/^usage_usec\s+(\d+)/m.exec(read(path.join(directory, "cpu.stat")))?.[1]);
      }
      const limit = Number(read(path.join(directory, "memory.max")).trim()), used = Number(read(path.join(directory, "memory.current")).trim());
      if (limit > 0 && limit < totalMemoryBytes && Number.isFinite(used)) { totalMemoryBytes = limit; memoryAvailableBytes = Math.min(memoryAvailableBytes, Math.max(0, limit - used)); }
      if (directory === "/sys/fs/cgroup") break;
      directory = path.dirname(directory);
    }
  }
  return { ticksTotal: cpu.reduce((a, b) => a + b, 0), ticksIdle: (cpu[3] || 0) + (cpu[4] || 0), ticksIoWait: cpu[4] || 0,
    cpuCores, totalMemoryBytes, memoryAvailableBytes, load1: os.loadavg()[0], scope, cgroupCpuUsageUs };
}

export class RemoteResourceSampler {
  constructor({ runSSH, script, report, now = Date.now }) { this.runSSH = runSSH; this.script = script; this.report = report; this.now = now; this.previous = null; this.inFlight = false; }
  async sample() {
    if (this.inFlight) return;
    this.inFlight = true; this.lastAttemptAt = this.now();
    try {
      const result = await this.runSSH("node", { stdin: this.script, timeoutMs: 4000, priority: "control", resourceIgnore: true });
      if (result.exitCode !== 0 || result.stdoutTruncated) return;
      const data = JSON.parse(result.stdout.trim());
      const now = this.now(), previous = this.previous;
      this.previous = { ...data, at: now };
      const total = previous ? data.ticksTotal - previous.ticksTotal : 0;
      let busy = total > 0 ? 1 - (data.ticksIdle - previous.ticksIdle) / total : 0.5;
      if (previous?.scope === "cgroup" && data.scope === "cgroup" && data.cgroupCpuUsageUs >= previous.cgroupCpuUsageUs && now > previous.at) busy = (data.cgroupCpuUsageUs - previous.cgroupCpuUsageUs) / ((now - previous.at) * 1000 * data.cpuCores);
      this.report({ cpuCores: data.cpuCores, totalMemoryBytes: data.totalMemoryBytes, memoryAvailableBytes: data.memoryAvailableBytes,
        cpuBusyRatio: Math.max(0, Math.min(1, busy)), ioWaitRatio: total > 0 ? Math.max(0, Math.min(1, (data.ticksIoWait - previous.ticksIoWait) / total)) : 0,
        load1: data.load1, scope: data.scope });
    } catch { /* Last sample ages out; missing metrics never mean an idle host. */ }
    finally { this.inFlight = false; }
  }
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const projectRoot = path.resolve(pluginRoot, "..", "..");

function installerEnvironment(mockBin, codexHome, dataDir, logPath) {
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_MOCK_LOG: logPath,
    REMOTE_DEBUG_AGENT_DIR: "",
    REMOTE_DEBUG_AGENT_URL: "",
    REMOTE_DEBUG_DATA_DIR: dataDir,
    REMOTE_DEBUG_ENV_PATH: "",
    REMOTE_DEBUG_PROJECT_ROOT: "",
  };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "Path";
  env[pathKey] = `${mockBin}${path.delimiter}${env[pathKey] || ""}`;
  return env;
}

function runInstaller(scriptPath, args, env) {
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return spawnSync(
    powershell,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    {
      cwd: path.dirname(path.dirname(scriptPath)),
      env,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
}

test(
  "install.ps1 supports check-only, repeat installs, migration, and safe conflicts",
  { skip: process.platform !== "win32" },
  async (t) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-installer-"));
    const cloneRoot = path.join(tempRoot, "源码 克隆");
    const fixturePluginRoot = path.join(cloneRoot, "plugins", "remote-debug-agent");
    const fixtureScriptDir = path.join(cloneRoot, "scripts");
    const scriptPath = path.join(fixtureScriptDir, "install.ps1");
    const privateKeyPath = path.join(tempRoot, "密钥 文件", "id_ed25519");
    const mockBin = path.join(tempRoot, "mock bin");
    const codexHome = path.join(tempRoot, "Codex Home");
    const codexLog = path.join(tempRoot, "codex-add.log");
    const dataDir = path.join(tempRoot, "用户 数据");
    const checkOnlyDataDir = path.join(tempRoot, "只检查 数据");

    t.after(async () => {
      await fs.rm(tempRoot, { recursive: true, force: true });
    });

    await fs.mkdir(fixtureScriptDir, { recursive: true });
    await fs.mkdir(path.dirname(privateKeyPath), { recursive: true });
    await fs.mkdir(mockBin, { recursive: true });
    await fs.cp(pluginRoot, fixturePluginRoot, { recursive: true });
    await fs.copyFile(path.join(projectRoot, "scripts", "install.ps1"), scriptPath);
    await fs.copyFile(path.join(projectRoot, ".env.example"), path.join(cloneRoot, ".env.example"));
    await fs.writeFile(privateKeyPath, "test-key\n");
    await fs.writeFile(
      path.join(mockBin, "codex.cmd"),
      [
        "@echo off",
        "if \"%~3\"==\"--help\" (",
        "  echo Commands: add",
        "  exit /b 0",
        ")",
        "if \"%~3\"==\"add\" (",
        "  >>\"%CODEX_MOCK_LOG%\" echo %~4",
        "  exit /b 0",
        ")",
        "exit /b 1",
      ].join("\r\n"),
    );
    const sourceConfig = [
      "REMOTE_DEBUG_HOST=prod.example.com",
      "REMOTE_DEBUG_PORT=22",
      "REMOTE_DEBUG_USER=app",
      `REMOTE_DEBUG_PRIVATE_KEY_PATH=${privateKeyPath}`,
      "REMOTE_DEBUG_AGENT_PORT=4343",
    ].join("\n");
    await fs.writeFile(path.join(cloneRoot, ".env"), sourceConfig);

    const legacyState = path.join(cloneRoot, ".remote-debug");
    const legacyInstance = path.join(legacyState, "instances", "default");
    await fs.mkdir(legacyInstance, { recursive: true });
    await fs.writeFile(path.join(legacyState, "instances.json"), '{"legacy":true}\n');
    await fs.writeFile(path.join(legacyState, "manager-runtime.json"), '{"pid":123}\n');
    await fs.writeFile(path.join(legacyInstance, "memory.json"), '{"memory":"legacy"}\n');
    await fs.writeFile(path.join(legacyInstance, "audit.jsonl"), '{"audit":"legacy"}\n');
    await fs.writeFile(path.join(legacyInstance, "worker.pid"), "123\n");

    const checkOnly = runInstaller(
      scriptPath,
      ["-CheckOnly"],
      installerEnvironment(mockBin, codexHome, checkOnlyDataDir, codexLog),
    );
    assert.equal(checkOnly.status, 0, checkOnly.stderr || checkOnly.stdout);
    await assert.rejects(fs.access(checkOnlyDataDir));

    const env = installerEnvironment(mockBin, codexHome, dataDir, codexLog);
    const firstInstall = runInstaller(scriptPath, [], env);
    assert.equal(firstInstall.status, 0, firstInstall.stderr || firstInstall.stdout);
    assert.equal(await fs.readFile(path.join(dataDir, "config.env"), "utf8"), sourceConfig);
    assert.equal(
      await fs.readFile(path.join(dataDir, ".remote-debug", "instances.json"), "utf8"),
      '{"legacy":true}\n',
    );
    assert.equal(
      await fs.readFile(
        path.join(dataDir, ".remote-debug", "instances", "default", "memory.json"),
        "utf8",
      ),
      '{"memory":"legacy"}\n',
    );
    await assert.rejects(
      fs.access(path.join(dataDir, ".remote-debug", "manager-runtime.json")),
    );
    await assert.rejects(
      fs.access(
        path.join(dataDir, ".remote-debug", "instances", "default", "worker.pid"),
      ),
    );

    await fs.writeFile(
      path.join(dataDir, ".remote-debug", "instances.json"),
      '{"target":true}\n',
    );
    const repeatedInstall = runInstaller(scriptPath, [], env);
    assert.equal(
      repeatedInstall.status,
      0,
      repeatedInstall.stderr || repeatedInstall.stdout,
    );
    assert.equal(
      await fs.readFile(path.join(dataDir, ".remote-debug", "instances.json"), "utf8"),
      '{"target":true}\n',
    );
    assert.equal((await fs.readFile(codexLog, "utf8")).trim().split(/\r?\n/).length, 2);

    const alternateConfig = path.join(tempRoot, "alternate.env");
    await fs.writeFile(
      alternateConfig,
      sourceConfig.replace("prod.example.com", "other.example.com"),
    );
    const conflict = runInstaller(scriptPath, ["-ConfigPath", alternateConfig], env);
    assert.notEqual(conflict.status, 0);
    assert.equal(await fs.readFile(path.join(dataDir, "config.env"), "utf8"), sourceConfig);

    const noConfigClone = path.join(tempRoot, "无配置 克隆");
    const noConfigData = path.join(tempRoot, "无配置 数据");
    await fs.cp(cloneRoot, noConfigClone, { recursive: true });
    await fs.rm(path.join(noConfigClone, ".env"));
    const noConfig = runInstaller(
      path.join(noConfigClone, "scripts", "install.ps1"),
      [],
      installerEnvironment(mockBin, codexHome, noConfigData, codexLog),
    );
    assert.notEqual(noConfig.status, 0);
    assert.equal(
      await fs.readFile(path.join(noConfigData, "config.env"), "utf8"),
      await fs.readFile(path.join(noConfigClone, ".env.example"), "utf8"),
    );

    const manifestPath = path.join(
      noConfigClone,
      "plugins",
      "remote-debug-agent",
      "runtime",
      "agent",
      "runtime-manifest.json",
    );
    await fs.rm(manifestPath);
    const missingRuntime = runInstaller(
      path.join(noConfigClone, "scripts", "install.ps1"),
      ["-CheckOnly"],
      installerEnvironment(
        mockBin,
        codexHome,
        path.join(tempRoot, "缺少运行包 数据"),
        codexLog,
      ),
    );
    assert.notEqual(missingRuntime.status, 0);
    assert.match(
      `${missingRuntime.stdout}\n${missingRuntime.stderr}`,
      /runtime-manifest\.json/,
    );
  },
);

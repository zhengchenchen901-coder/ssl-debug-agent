import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import windowsPrivacy from "../../../plugins/remote-debug-agent/windows-privacy.cjs";
export const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
export const fixtureArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(import.meta.dirname, "windows-privacy-fixture.ps1")];
export function nativeFixture(action, directory, extra = {}) {
  return JSON.parse(execFileSync(powershell, fixtureArgs, { input: JSON.stringify({ action, directory, target: windowsPrivacy.targetFor(directory), ...extra }), encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }));
}
export function windowsFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rda-win-privacy-test-"));
  windowsPrivacy.prepareStore(directory);
  t.after(() => {
    nativeFixture("delete", directory);
    // Only this fixture's exact, freshly created temporary directory.
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("rda-win-privacy-test-")) throw new Error("Unexpected fixture cleanup path");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

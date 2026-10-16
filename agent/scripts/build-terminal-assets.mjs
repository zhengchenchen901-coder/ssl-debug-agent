import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function buildTerminalAssets() {
  const output = path.join(root, "public", "vendor");
  await fs.mkdir(output, { recursive: true });
  const files = [
    ["@xterm/xterm/lib/xterm.js", "xterm.js"],
    ["@xterm/xterm/css/xterm.css", "xterm.css"],
    ["@xterm/xterm/LICENSE", "LICENSE-xterm.txt"],
    ["@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
    ["@xterm/addon-fit/LICENSE", "LICENSE-addon-fit.txt"],
  ];
  for (const [source, destination] of files) {
    await fs.copyFile(path.join(root, "node_modules", source), path.join(output, destination));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildTerminalAssets();

"""Generate the existing dashboard's offline diagnostic view without Node.js."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path)
    args = parser.parse_args()
    plugin = Path(__file__).resolve().parent.parent
    data_dir = args.data_dir or Path(os.environ.get("REMOTE_DEBUG_DATA_DIR") or
        os.environ.get("REMOTE_DEBUG_PROJECT_ROOT") or
        (str(Path(os.environ["LOCALAPPDATA"]) / "RemoteDebugAgent") if os.environ.get("LOCALAPPDATA")
         else str(Path.home() / ".remote-debug-agent")))
    node = shutil.which("node")
    if node:
        probe = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=5)
        version = probe.stdout.strip()
        try:
            major = int(version.lstrip("v").split(".")[0])
        except ValueError:
            major = 0
        if major >= 14:
            env = dict(os.environ, REMOTE_DEBUG_DATA_DIR=str(data_dir.resolve()))
            return subprocess.call([node, str(plugin / "launch.cjs"), "--check"], env=env)
    else:
        version = "未在当前 PATH 找到 Node.js"
    public = plugin / "runtime" / "agent" / "public"
    requirement = json.loads((plugin / "package.json").read_text())["engines"]["node"]
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    runtime_dir = data_dir.resolve() / ".runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    output = runtime_dir / "environment-dashboard.html"
    report_path = runtime_dir / "environment-report.json"
    try:
        previous = json.loads(report_path.read_text()) if report_path.exists() else {}
    except (ValueError, OSError):
        previous = {}
    failures = previous.get("failures", [])[-9:]
    if previous.get("status") == "failed":
        failures.append({key: previous[key] for key in ["checkedAt", "stage", "checks"]})
    report = dict(schemaVersion=1, attemptId=uuid.uuid4().hex, trigger="manual-check", checkedAt=now, updatedAt=now,
        pluginRoot=str(plugin), nodeExecutable=node, nodeRequirement=requirement,
        dataDir=str(data_dir.resolve()), status="failed", stage="environment", dashboardUrl=None,
        offlineDashboard=str(output), failures=failures[-10:], checks=[dict(id="node",
            label="插件启动使用的 Node.js", actual=version, required=requirement, status="fail",
            remedy="安装符合范围的 Node.js，并让插件启动环境的 PATH 指向该版本。随后重新加载插件。")])
    payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    temporary = report_path.with_suffix("." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(report_path)
    snapshot = json.dumps(dict(ok=True, mode="offline", report=report), ensure_ascii=False).replace("<", "\\u003c")
    html = (public / "dashboard.html").read_text(encoding="utf-8")
    html = html.replace('<link rel="stylesheet" href="/dashboard.css" />',
        "<style>" + (public / "dashboard.css").read_text(encoding="utf-8") + "</style>")
    html = html.replace('<script src="/environment-report.js" defer></script>',
        "<script>window.environmentSnapshot=" + snapshot + ";</script><script>" +
        (public / "environment-report.js").read_text(encoding="utf-8") + "</script>")
    html = html.replace('<script src="/dashboard.js" type="module"></script>', "")
    output.write_text(html, encoding="utf-8")
    output.chmod(0o600)
    print("环境检查报告：" + str(output))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

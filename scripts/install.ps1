[CmdletBinding()]
param(
  [Parameter()]
  [string]$ConfigPath = "",

  [Parameter()]
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"

function Resolve-FullPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PathValue,

    [Parameter(Mandatory = $true)]
    [string]$BasePath
  )

  if ([System.IO.Path]::IsPathRooted($PathValue)) {
    return [System.IO.Path]::GetFullPath($PathValue)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $BasePath $PathValue))
}

function Read-EnvFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PathValue
  )

  $values = @{}
  foreach ($line in Get-Content -LiteralPath $PathValue -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }

    $separatorIndex = $trimmed.IndexOf("=")
    if ($separatorIndex -lt 1) {
      continue
    }

    $key = $trimmed.Substring(0, $separatorIndex).Trim()
    $value = $trimmed.Substring($separatorIndex + 1).Trim()
    if ($key -notmatch "^[A-Za-z_][A-Za-z0-9_]*$") {
      continue
    }

    if (
      $value.Length -ge 2 -and
      (
        ($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))
      )
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    } else {
      $value = $value -replace "\s+#.*$", ""
    }
    $values[$key] = $value
  }
  return $values
}

function Copy-IfMissing {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Source,

    [Parameter(Mandatory = $true)]
    [string]$Destination
  )

  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    return
  }
  if (Test-Path -LiteralPath $Destination) {
    Write-Output "保留已有文件: $Destination"
    return
  }

  $destinationDirectory = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination
  Write-Output "已迁移: $Destination"
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "当前安装脚本仅支持 Windows 10/11。"
}

$scriptDirectory = Split-Path -Parent $PSCommandPath
$projectRoot = Split-Path -Parent $scriptDirectory
$pluginRoot = Join-Path $projectRoot "plugins\remote-debug-agent"
$pluginManifestPath = Join-Path $pluginRoot ".codex-plugin\plugin.json"
$runtimeRoot = Join-Path $pluginRoot "runtime\agent"
$runtimeManifestPath = Join-Path $runtimeRoot "runtime-manifest.json"

if ($env:REMOTE_DEBUG_DATA_DIR) {
  $dataRoot = Resolve-FullPath -PathValue $env:REMOTE_DEBUG_DATA_DIR -BasePath $projectRoot
} elseif ($env:REMOTE_DEBUG_PROJECT_ROOT) {
  $dataRoot = Resolve-FullPath -PathValue $env:REMOTE_DEBUG_PROJECT_ROOT -BasePath $projectRoot
} elseif ($env:LOCALAPPDATA) {
  $dataRoot = Join-Path $env:LOCALAPPDATA "RemoteDebugAgent"
} else {
  throw "无法解析 LOCALAPPDATA，请设置 REMOTE_DEBUG_DATA_DIR。"
}

if ($env:REMOTE_DEBUG_ENV_PATH) {
  $targetConfigPath = Resolve-FullPath -PathValue $env:REMOTE_DEBUG_ENV_PATH -BasePath $projectRoot
} else {
  $targetConfigPath = Join-Path $dataRoot "config.env"
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw "未找到 Node.js。请安装 Node 22.18+ 并确保 node 在 PATH 中。"
}
$nodeVersionText = (& node --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch "^v(\d+)\.(\d+)\.(\d+)$") {
  throw "无法识别 Node.js 版本: $nodeVersionText"
}
$nodeMajor = [int]$Matches[1]
$nodeMinor = [int]$Matches[2]
if ($nodeMajor -ne 22 -or $nodeMinor -lt 18) {
  throw "需要 Node 22.18+ 的 22.x 版本，当前版本为 $nodeVersionText。"
}

$codexCommand = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codexCommand) {
  throw "未找到 Codex CLI，无法注册插件 Marketplace。"
}
$marketplaceHelp = (& codex plugin marketplace --help 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $marketplaceHelp -notmatch "\badd\b") {
  throw "当前 Codex CLI 不支持 'codex plugin marketplace add'，请升级 Codex。"
}

if (-not (Test-Path -LiteralPath $runtimeManifestPath -PathType Leaf)) {
  throw "缺少预构建运行清单: $runtimeManifestPath"
}
$runtimeManifest = Get-Content -LiteralPath $runtimeManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($runtimeManifest.version -ne 1 -or -not $runtimeManifest.runtimeId) {
  throw "预构建运行清单格式无效: $runtimeManifestPath"
}
$pluginManifest = Get-Content -LiteralPath $pluginManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($pluginManifest.version -ne $runtimeManifest.pluginVersion) {
  throw "插件版本与预构建运行包版本不一致。"
}
$requiredArtifacts = @(
  [string]$runtimeManifest.server,
  [string]$runtimeManifest.worker,
  "public/dashboard.css",
  "public/dashboard.html",
  "public/dashboard.js"
)
foreach ($requiredArtifact in $requiredArtifacts) {
  if (
    -not $requiredArtifact -or
    -not ($runtimeManifest.hashes.PSObject.Properties.Name -contains $requiredArtifact)
  ) {
    throw "预构建运行清单缺少文件哈希: $requiredArtifact"
  }
}
foreach ($hashProperty in $runtimeManifest.hashes.PSObject.Properties) {
  $artifactPath = Join-Path $runtimeRoot ($hashProperty.Name -replace "/", "\")
  if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
    throw "缺少预构建文件: $artifactPath"
  }
  $actualHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne ([string]$hashProperty.Value).ToLowerInvariant()) {
    throw "预构建文件校验失败: $artifactPath"
  }
}

$sourceConfigPath = ""
if ($ConfigPath) {
  $sourceConfigPath = Resolve-FullPath -PathValue $ConfigPath -BasePath $projectRoot
  if (-not (Test-Path -LiteralPath $sourceConfigPath -PathType Leaf)) {
    throw "指定的配置文件不存在: $sourceConfigPath"
  }
} else {
  $repositoryConfigPath = Join-Path $projectRoot ".env"
  if (Test-Path -LiteralPath $repositoryConfigPath -PathType Leaf) {
    $sourceConfigPath = $repositoryConfigPath
  }
}

$validationConfigPath = $targetConfigPath
if (-not (Test-Path -LiteralPath $targetConfigPath -PathType Leaf)) {
  if ($sourceConfigPath -and (Test-Path -LiteralPath $sourceConfigPath -PathType Leaf)) {
    if ($CheckOnly) {
      $validationConfigPath = $sourceConfigPath
      Write-Output "检查模式使用配置来源: $sourceConfigPath"
    } else {
      New-Item -ItemType Directory -Path (Split-Path -Parent $targetConfigPath) -Force | Out-Null
      Copy-Item -LiteralPath $sourceConfigPath -Destination $targetConfigPath
      Write-Output "已初始化配置: $targetConfigPath"
    }
  } else {
    $examplePath = Join-Path $projectRoot ".env.example"
    if (-not $CheckOnly) {
      New-Item -ItemType Directory -Path (Split-Path -Parent $targetConfigPath) -Force | Out-Null
      Copy-Item -LiteralPath $examplePath -Destination $targetConfigPath
      Write-Output "已生成配置模板: $targetConfigPath"
    }
    throw "请编辑配置文件后重新运行安装脚本: $targetConfigPath"
  }
} elseif ($ConfigPath -and $sourceConfigPath -ne $targetConfigPath) {
  $sourceHash = (Get-FileHash -LiteralPath $sourceConfigPath -Algorithm SHA256).Hash
  $targetHash = (Get-FileHash -LiteralPath $targetConfigPath -Algorithm SHA256).Hash
  if ($sourceHash -ne $targetHash) {
    throw "目标配置已存在且与 -ConfigPath 不一致；为避免覆盖已停止安装: $targetConfigPath"
  }
}

$configuration = Read-EnvFile -PathValue $validationConfigPath
foreach ($requiredKey in @(
  "REMOTE_DEBUG_HOST",
  "REMOTE_DEBUG_USER",
  "REMOTE_DEBUG_PRIVATE_KEY_PATH"
)) {
  if (-not $configuration.ContainsKey($requiredKey) -or -not $configuration[$requiredKey]) {
    throw "配置缺少必填项 $requiredKey：$targetConfigPath"
  }
}

$sshPort = 22
if ($configuration.ContainsKey("REMOTE_DEBUG_PORT") -and $configuration["REMOTE_DEBUG_PORT"]) {
  if (-not [int]::TryParse($configuration["REMOTE_DEBUG_PORT"], [ref]$sshPort)) {
    throw "REMOTE_DEBUG_PORT 必须是有效端口。"
  }
}
if ($sshPort -lt 1 -or $sshPort -gt 65535) {
  throw "REMOTE_DEBUG_PORT 必须在 1-65535 之间。"
}

$privateKeyPath = [string]$configuration["REMOTE_DEBUG_PRIVATE_KEY_PATH"]
if (-not [System.IO.Path]::IsPathRooted($privateKeyPath)) {
  throw "REMOTE_DEBUG_PRIVATE_KEY_PATH 必须是绝对路径: $privateKeyPath"
}
if (-not (Test-Path -LiteralPath $privateKeyPath -PathType Leaf)) {
  throw "SSH 私钥文件不存在: $privateKeyPath"
}

if ($CheckOnly) {
  Write-Output "兼容性检查通过。"
  Write-Output "Node: $nodeVersionText"
  Write-Output "Runtime: $($runtimeManifest.runtimeId)"
  Write-Output "Config: $validationConfigPath"
  Write-Output "Install config target: $targetConfigPath"
  Write-Output "Data: $dataRoot"
  exit 0
}

New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$legacyStateRoot = Join-Path $projectRoot ".remote-debug"
$targetStateRoot = Join-Path $dataRoot ".remote-debug"
Copy-IfMissing `
  -Source (Join-Path $legacyStateRoot "instances.json") `
  -Destination (Join-Path $targetStateRoot "instances.json")
Copy-IfMissing `
  -Source (Join-Path $legacyStateRoot "command-review.json") `
  -Destination (Join-Path $targetStateRoot "command-review.json")

$legacyInstancesRoot = Join-Path $legacyStateRoot "instances"
if (Test-Path -LiteralPath $legacyInstancesRoot -PathType Container) {
  foreach ($instanceDirectory in Get-ChildItem -LiteralPath $legacyInstancesRoot) {
    if (-not $instanceDirectory.PSIsContainer) {
      continue
    }
    foreach ($fileName in @("memory.json", "audit.jsonl")) {
      Copy-IfMissing `
        -Source (Join-Path $instanceDirectory.FullName $fileName) `
        -Destination (Join-Path (Join-Path $targetStateRoot "instances\$($instanceDirectory.Name)") $fileName)
    }
  }
}

Copy-IfMissing `
  -Source (Join-Path $projectRoot "agent\audit\remote-debug-agent.jsonl") `
  -Destination (Join-Path $targetStateRoot "audit\remote-debug-agent.jsonl")
Copy-IfMissing `
  -Source (Join-Path $projectRoot "audit\remote-debug-agent.jsonl") `
  -Destination (Join-Path $targetStateRoot "audit\remote-debug-agent.jsonl")

& codex plugin marketplace add $projectRoot
if ($LASTEXITCODE -ne 0) {
  throw "Codex Marketplace 注册失败，退出码: $LASTEXITCODE"
}

Write-Output ""
Write-Output "Remote Debug Agent $($runtimeManifest.pluginVersion) 安装准备完成。"
Write-Output "请在 Codex Desktop 插件目录中安装或重新启用 remote-debug-agent，随后新建任务。"
Write-Output "配置目录: $targetConfigPath"
Write-Output "数据目录: $dataRoot"

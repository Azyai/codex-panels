# codex-panels 一键安装脚本
# 用法:powershell -ExecutionPolicy Bypass -File install.ps1 [-Force]
param(
    [string]$PanelsHome = "$env:LOCALAPPDATA\codex-panels",
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot

# ---------- 0. 环境检查 ----------
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw '未找到 python(补丁脚本依赖 Python 3)。请先安装 Python。'
}

# ---------- 1. 定位官方 Codex(Microsoft Store 版)----------
$pkg = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
if (-not $pkg) {
    throw '未找到已安装的 OpenAI.Codex(需要 Microsoft Store 版)。请先安装官方 Codex 桌面应用。'
}
$sourceApp = Join-Path $pkg.InstallLocation 'app'
Write-Host "[1/6] 官方 Codex $($pkg.Version): $sourceApp"

# ---------- 2. 复制到可写目录 ----------
$targetApp = Join-Path $PanelsHome 'app'
if ((Test-Path (Join-Path $targetApp 'ChatGPT.exe')) -and -not $Force) {
    Write-Host '[2/6] 副本已存在,跳过复制(重新复制加 -Force)'
} else {
    Write-Host "[2/6] 复制 App 到 $targetApp(约 2.2GB,首次约 1 分钟)"
    robocopy $sourceApp $targetApp /E /MT:16 /R:1 /W:1 /NFL /NDL /NP /NJH /NS /NC | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失败,退出码 $LASTEXITCODE" }
}

# ---------- 3. patch asar:main 入口指向扩展加载器 ----------
Write-Host '[3/6] patch app.asar(注入扩展加载器)'
$asar = Join-Path $targetApp 'resources\app.asar'
if (Test-Path "$asar.orig") {
    python (Join-Path $ProjectRoot 'src\patch\patch-asar.py') $asar --restore | Out-Null
}
python (Join-Path $ProjectRoot 'src\patch\patch-asar.py') $asar (Join-Path $ProjectRoot 'src\desktop\loader.cjs')
if ($LASTEXITCODE -ne 0) { throw 'patch-asar 失败' }

# ---------- 4. patch asar 内 webview:会话列表原生轮询(双向无感同步) ----------
Write-Host '[4/6] patch 桌面端 webview(会话列表 1 秒原生轮询)'
$work = Join-Path $PanelsHome 'patch-work'
New-Item -ItemType Directory -Force -Path $work | Out-Null
python (Join-Path $ProjectRoot 'tools\extract-asar.py') $asar $work --only webview | Out-Null
python (Join-Path $ProjectRoot 'src\patch\patch-webview-poll.py') (Join-Path $work 'webview\assets')
$patched = Get-ChildItem (Join-Path $work 'webview\assets') -Filter '*.js' | Where-Object {
    (Select-String -Path $_.FullName -Pattern '__cpSync' -Quiet)
} | Select-Object -First 1
if ($patched) {
    $internal = 'webview/assets/' + $patched.Name
    python (Join-Path $ProjectRoot 'src\patch\patch-asar-replace.py') $asar $internal $patched.FullName
    if ($LASTEXITCODE -ne 0) { throw 'webview asar 重建失败' }
} else {
    Write-Host '  (webview 未找到可打补丁的文件,跳过——不影响其他功能)'
}

# ---------- 5. patch 二进制完整性哈希 ----------
Write-Host '[5/6] patch ChatGPT.exe 的 asar 完整性哈希'
$exe = Join-Path $targetApp 'ChatGPT.exe'
if (Test-Path "$exe.orig") { Copy-Item "$exe.orig" "$exe" -Force }
python (Join-Path $ProjectRoot 'src\patch\patch-binary-hash.py') $targetApp
if ($LASTEXITCODE -ne 0) { throw 'patch-binary-hash 失败' }

# ---------- 6. 部署运行时 + VS Code 扩展 + 快捷方式 ----------
Write-Host '[6/6] 部署运行时、VS Code 扩展、快捷方式'
$runtimeDir = Join-Path $PanelsHome 'runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
foreach ($f in 'main-runtime.cjs', 'page-preload.cjs', 'chat.cjs') {
    Copy-Item (Join-Path $ProjectRoot "src\desktop\$f") $runtimeDir -Force
}

$extTarget = Join-Path $PanelsHome 'vscode-extensions\codex-panels.codex-chat-0.2.0'
New-Item -ItemType Directory -Force -Path (Join-Path $extTarget 'media') | Out-Null
Copy-Item (Join-Path $ProjectRoot 'src\vscode\package.json') $extTarget -Force
Copy-Item (Join-Path $ProjectRoot 'src\vscode\extension.js') $extTarget -Force
Copy-Item (Join-Path $ProjectRoot 'src\vscode\media\icon.svg') (Join-Path $extTarget 'media') -Force

# 同步扩展到本机 VS Code 扩展目录(官方 Codex 扩展所在位置)
$userExt = Join-Path $env:USERPROFILE '.vscode\extensions'
$officialExt = Get-ChildItem $userExt -Directory -Filter 'openai.chatgpt-*' | Select-Object -First 1
if ($officialExt) {
    # 官方扩展 webview 打会话轮询补丁
    python (Join-Path $ProjectRoot 'src\patch\patch-webview-poll.py') (Join-Path $officialExt.FullName 'webview\assets') 2>$null
    Write-Host "官方扩展 webview 补丁: $($officialExt.Name)"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut("$env:USERPROFILE\Desktop\Codex(面板扩展).lnk")
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $targetApp
$shortcut.Description = 'Codex 桌面版 + codex-panels'
$shortcut.Save()

Write-Host ''
Write-Host '安装完成!桌面快捷方式:「Codex(面板扩展)」;VS Code 需重载窗口一次加载扩展。' -ForegroundColor Green
Write-Host '注意:扩展副本与官方 Codex 共享用户数据,两者不要同时运行。'

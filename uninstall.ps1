# codex-panels 卸载脚本:还原 App 副本的 asar 与 ChatGPT.exe,删除快捷方式。
# 默认保留 App 副本本身(下次 install 可复用);加 -Purge 连同整个目录删除。
param(
    [string]$PanelsHome = "$env:LOCALAPPDATA\codex-panels",
    [switch]$Purge
)
$ErrorActionPreference = 'Stop'

$targetApp = Join-Path $PanelsHome 'app'
$asar = Join-Path $targetApp 'resources\app.asar'
$exe = Join-Path $targetApp 'ChatGPT.exe'

# 结束运行中的扩展版
Get-Process | Where-Object { $_.Path -like "$PanelsHome*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

if (Test-Path "$asar.orig") {
    python (Join-Path $PSScriptRoot 'src\patch\patch-asar.py') $asar --restore
    Write-Host '已还原 app.asar'
}
if (Test-Path "$exe.orig") {
    Move-Item "$exe.orig" $exe -Force
    Write-Host '已还原 ChatGPT.exe'
}

$shortcutPath = "$env:USERPROFILE\Desktop\Codex(面板扩展).lnk"
if (Test-Path $shortcutPath) { Remove-Item $shortcutPath; Write-Host '已删除桌面快捷方式' }

if ($Purge) {
    Remove-Item $PanelsHome -Recurse -Force
    Write-Host "已删除 $PanelsHome(含 App 副本)"
} else {
    Write-Host "保留 $PanelsHome(重新安装时可直接复用;彻底删除请加 -Purge)"
}
Write-Host '卸载完成。'

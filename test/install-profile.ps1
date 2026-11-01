param(
  [Parameter(Mandatory = $true)][string]$Manifest,
  [string]$PluginPath = (Get-Location).Path
)
$ErrorActionPreference = 'Stop'
$rendered = & node (Join-Path $PSScriptRoot 'render-profile.mjs') $Manifest $PluginPath
[System.IO.File]::WriteAllText($Manifest, ($rendered -join "`n"), (New-Object System.Text.UTF8Encoding($false)))
$profileDir = Split-Path -Parent (Split-Path -Parent $Manifest)
$link = Join-Path $profileDir 'node_modules\dsh-plugin-mobile-link'
if (-not (Test-Path $link)) {
  New-Item -ItemType Junction -Path $link -Target $PluginPath | Out-Null
}
Write-Output 'manifest written'

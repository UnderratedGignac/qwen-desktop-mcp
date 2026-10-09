# Builds dist\app.asar from the stock Qwen bundle and deploys the MCP servers to ~\.qwen-mcp.
# Run without admin. Install afterwards with installer\install_qwen_patch.bat (Run as administrator).
param(
  # The untouched stock bundle. app.asar.bak is the original kept by the installer.
  [string]$Stock = "C:\Program Files\Qwen\resources\app.asar.bak"
)
$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path $Stock)) { $Stock = "C:\Program Files\Qwen\resources\app.asar" }
$Work = Join-Path $Repo "dist\work"
if (Test-Path $Work) { Remove-Item -Recurse -Force $Work }
New-Item -ItemType Directory -Force (Join-Path $Repo "dist") | Out-Null

npx -y @electron/asar extract $Stock $Work
node (Join-Path $Repo "scripts\patch-bundle.js") $Work
if ($LASTEXITCODE) { throw "patch failed" }
npx -y @electron/asar pack $Work (Join-Path $Repo "dist\app.asar")
Remove-Item -Recurse -Force $Work

$Servers = Join-Path $env:USERPROFILE ".qwen-mcp"
New-Item -ItemType Directory -Force $Servers | Out-Null
Copy-Item (Join-Path $Repo "servers\*") $Servers -Force
Copy-Item (Join-Path $Repo "dist\app.asar") (Join-Path $Repo "installer\app.asar") -Force
Write-Host "Built dist\app.asar and deployed servers to $Servers"

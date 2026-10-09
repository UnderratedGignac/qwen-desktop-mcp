# Creates shortcuts to run several Qwen accounts side by side, each with its own login.
#   Account 1 uses your existing Qwen profile (already logged in).
#   Every other account gets its own profile folder under %APPDATA%\Qwen-profiles; log in once.
# Usage:
#   powershell -File scripts\qwen-accounts.ps1                        # Account 1..3
#   powershell -File scripts\qwen-accounts.ps1 -Names Work,Personal,Test
#   powershell -File scripts\qwen-accounts.ps1 -Remove                # delete the shortcuts (keeps logins)
param(
  [string[]]$Names = @("Account 1", "Account 2", "Account 3"),
  [switch]$Remove,
  [switch]$NoDesktop
)
$ErrorActionPreference = "Stop"
$Exe = "C:\Program Files\Qwen\Qwen.exe"
$ProfilesRoot = Join-Path $env:APPDATA "Qwen-profiles"
$MenuDir = Join-Path ([Environment]::GetFolderPath("Programs")) "Qwen Accounts"
$Desktop = [Environment]::GetFolderPath("Desktop")

if ($Remove) {
  if (Test-Path $MenuDir) { Get-ChildItem $MenuDir -Filter "Qwen - *.lnk" | ForEach-Object { $_.Delete() } }
  Get-ChildItem $Desktop -Filter "Qwen - *.lnk" -ErrorAction SilentlyContinue | ForEach-Object { $_.Delete() }
  Write-Host "Shortcuts removed. Logins are kept in $ProfilesRoot."
  return
}
if (-not (Test-Path $Exe)) { throw "Qwen not found at $Exe" }
New-Item -ItemType Directory -Force $MenuDir | Out-Null

$shell = New-Object -ComObject WScript.Shell
for ($i = 0; $i -lt $Names.Count; $i++) {
  $name = $Names[$i].Trim()
  if (-not $name -or $name -match '[\\/:*?"<>|]') { throw "Invalid account name: '$name'" }
  $args = "`"--qwen-profile=$name`""
  if ($i -gt 0) {
    $slug = ($name.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
    $dataDir = Join-Path $ProfilesRoot $slug
    New-Item -ItemType Directory -Force $dataDir | Out-Null
    $args = "--user-data-dir=`"$dataDir`" " + $args
  }
  $targets = @($MenuDir)
  if (-not $NoDesktop) { $targets += $Desktop }
  foreach ($dir in $targets) {
    $lnk = $shell.CreateShortcut((Join-Path $dir "Qwen - $name.lnk"))
    $lnk.TargetPath = $Exe
    $lnk.Arguments = $args
    $lnk.WorkingDirectory = $env:USERPROFILE
    $lnk.IconLocation = "$Exe,0"
    $lnk.Description = "Qwen ($name)"
    $lnk.Save()
  }
  Write-Host ("Qwen - {0}: {1}" -f $name, $(if ($i -eq 0) { "your current profile" } else { $dataDir }))
}
Write-Host "Shortcuts are in the Start menu under 'Qwen Accounts'$(if (-not $NoDesktop) { ' and on the Desktop' })."
Write-Host "Open each new account once and log in; after that it stays logged in. All accounts can run at the same time."

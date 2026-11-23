# Collects ONLY the small browser files that can contain the clinic's typed
# patient entries: the autofill database ("Web Data") and the session files.
# Nothing is uploaded and nothing is changed in the browser.
#
# Run COLLECT-TRACES.bat, or:  powershell -ExecutionPolicy Bypass -File collect-traces.ps1

$ErrorActionPreference = 'SilentlyContinue'

$desktop = [Environment]::GetFolderPath('Desktop')
$out = Join-Path $desktop 'clinic-traces'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null

$roots = @(
  @{ Name = 'Chrome'; Path = (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data') },
  @{ Name = 'Edge';   Path = (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data') },
  @{ Name = 'Brave';  Path = (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data') }
)

$copied = 0
$locked = 0

foreach ($root in $roots) {
  if (-not (Test-Path $root.Path)) { continue }

  Get-ChildItem $root.Path -Directory |
    Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' } |
    ForEach-Object {
      $dest = Join-Path $out ($root.Name + '-' + $_.Name)
      New-Item -ItemType Directory -Path $dest -Force | Out-Null

      $web = Join-Path $_.FullName 'Web Data'
      if (Test-Path $web) {
        Copy-Item $web (Join-Path $dest 'Web Data') -Force
        if (Test-Path (Join-Path $dest 'Web Data')) { $copied++ } else { $locked++ }
      }

      $sessions = Join-Path $_.FullName 'Sessions'
      if (Test-Path $sessions) {
        Copy-Item $sessions (Join-Path $dest 'Sessions') -Recurse -Force
      }
    }
}

$zip = $out + '.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zip -Force

Write-Host ''
if ($locked -gt 0) {
  Write-Host 'One or more browsers are open and blocked the copy.' -ForegroundColor Yellow
  Write-Host 'Close Chrome, Edge and Brave completely, then run this again.' -ForegroundColor Yellow
  Write-Host ''
}
if ($copied -eq 0) {
  Write-Host 'No browser data could be copied from this computer.' -ForegroundColor Yellow
} else {
  Write-Host 'Done.' -ForegroundColor Green
  Write-Host ''
  Write-Host 'Send this one file to your developer:' -ForegroundColor Green
  Write-Host $zip
}

Write-Host ''
if (-not $env:CLINIC_NO_OPEN) { Start-Process explorer.exe $out }
if (-not $env:CLINIC_NO_PAUSE) { Read-Host 'Press Enter to close' }

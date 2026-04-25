$ErrorActionPreference = 'Continue'
# yuzu-browser dev launcher (Windows)
# - Visual Studio 2022 Build Tools (MSVC) の vcvars64.bat を取り込んでから tauri dev を起動

$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars)) {
  Write-Error "vcvars64.bat not found: $vcvars"
  exit 1
}

& cmd /c "`"$vcvars`" && set" | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') {
    [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
  }
}

Set-Location -LiteralPath $PSScriptRoot
Write-Host "=== cwd: $(Get-Location)"
Write-Host "=== launching: npm run tauri dev"
npm run tauri dev

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot ".env.local"
if (!(Test-Path $envFile)) {
  throw "Missing .env.local. Copy .env.example to .env.local and add provider keys."
}

$allowedKeys = @("GEMINI_API_KEY", "OPENWEATHER_API_KEY")
$loadedValues = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*(#|$)') { continue }
  if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
    throw "Invalid entry in .env.local."
  }

  $name = $Matches[1]
  if ($allowedKeys -notcontains $name) { continue }
  $value = $Matches[2]
  if ($value.Length -ge 2 -and
      (($value.StartsWith('"') -and $value.EndsWith('"')) -or
       ($value.StartsWith("'") -and $value.EndsWith("'")))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  Set-Item -Path ("Env:" + $name) -Value $value
  $loadedValues[$name] = $value
}

foreach ($name in $allowedKeys) {
  if (!$loadedValues.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($loadedValues[$name])) {
    throw "$name is missing from .env.local."
  }
}

Push-Location $projectRoot
try {
  & vercel dev --listen 8082 @args
  exit $LASTEXITCODE
} finally {
  Pop-Location
}

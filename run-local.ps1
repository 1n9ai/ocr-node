# Run 1n9 OCR on this machine without Docker.
# Needs: Python 3.11+ and Node.js 20+.
#   .\run-local.ps1            # http://127.0.0.1:8083
#   .\run-local.ps1 -Rebuild   # rebuild the web pages after changing frontend/
param(
  [int]$Port = 8083,
  [switch]$Rebuild
)
# Not using ErrorActionPreference=Stop: Windows PowerShell 5.1 treats pip/npm warnings on stderr as errors.
function Check($what) { if ($LASTEXITCODE) { Write-Host "$what failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE } }
Set-Location $PSScriptRoot

if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host "Created .env from .env.example. Fill in LICENSE_KEY / NODE_PASSWORD there, or set things up in the browser."
}
if (-not (Test-Path .venv)) { python -m venv .venv; Check "python -m venv" }
& .\.venv\Scripts\python -m pip install -q --disable-pip-version-check -r requirements.txt; Check "pip install"

if ($Rebuild -or -not (Test-Path frontend\out)) {
  Push-Location frontend
  npm ci --no-audit --no-fund; Check "npm ci"
  npm run build; Check "npm run build"
  Pop-Location
}

$env:NODE_DATA_DIR = Join-Path $PSScriptRoot "data"
$env:NODE_FRONTEND_DIR = Join-Path $PSScriptRoot "frontend\out"
Write-Host "ocr: http://127.0.0.1:$Port   (data: $env:NODE_DATA_DIR)"
& .\.venv\Scripts\python -m uvicorn app:app --host 127.0.0.1 --port $Port

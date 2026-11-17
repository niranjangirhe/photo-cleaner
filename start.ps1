# Opens Photo Cleaner at http://127.0.0.1:8770
Set-Location $PSScriptRoot
if (-not (Test-Path .\.venv\Scripts\python.exe)) { & .\setup.ps1; if ($LASTEXITCODE) { exit 1 } }
& .\.venv\Scripts\python.exe app.py @args

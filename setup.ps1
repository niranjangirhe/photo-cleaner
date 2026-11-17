# One-time setup on Windows: Python packages, then the models (about 5 GB). Safe to run again.
Set-Location $PSScriptRoot
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { Write-Host "Python 3.10 or newer is missing. Install it from python.org"; exit 1 }
if (-not (Test-Path .\.venv\Scripts\python.exe)) { python -m venv .venv }
$py = ".\.venv\Scripts\python.exe"
& $py -m pip install -q --upgrade pip
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  Write-Host "NVIDIA graphics card found: installing PyTorch with CUDA (about 2.5 GB)..."
  & $py -m pip install -q torch --index-url https://download.pytorch.org/whl/cu126
} else {
  Write-Host "No NVIDIA graphics card found: installing the processor-only PyTorch..."
  & $py -m pip install -q torch --index-url https://download.pytorch.org/whl/cpu
}
Write-Host "Installing the other packages..."
& $py -m pip install -q -r requirements.txt
Write-Host "Downloading the models..."
& $py -m cleaner.download --ollama
if ($LASTEXITCODE) { Write-Host "A model download failed. Run setup.ps1 again to retry."; exit 1 }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { Write-Host "Optional: install ffmpeg so short videos can be checked:  winget install Gyan.FFmpeg" }
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { Write-Host "Optional: install Ollama from ollama.com for the AI second opinion, then run setup.ps1 again." }
Write-Host "Setup done. Next: .\start.ps1  (or double-click 'Start Photo Cleaner.bat')"

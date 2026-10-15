param([string]$Distribution = 'Ubuntu-24.04')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $taskRoot 'storage\tmp'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$statePath = Join-Path $runtimeDir 'wsl-keeper.json'
$existing = $null
if (Test-Path -LiteralPath $statePath) {
    try { $existing = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { }
}
if ($existing -and $existing.processId) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($existing.processId)" -ErrorAction SilentlyContinue
    if ($processInfo -and $processInfo.Name -eq 'wsl.exe' -and $processInfo.CommandLine -like '*sleep infinity*' -and $existing.distribution -eq $Distribution) {
        Write-Output 'WSL ya tiene un proceso de continuidad para Radio AI.'
        exit 0
    }
}
# systemd services do not keep a WSL distribution running after its last
# Windows-side session closes. This hidden process belongs to this checkout.
$wslExecutable = Join-Path $env:WINDIR 'System32\wsl.exe'
$keeper = Start-Process -FilePath $wslExecutable -ArgumentList @('-d', $Distribution, '-u', 'radio', '--exec', '/bin/sleep', 'infinity') -WindowStyle Hidden -PassThru
@{ processId = $keeper.Id; distribution = $Distribution; startedAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
Write-Output 'WSL mantiene la emisora activa. Servicios y audio se gestionan con systemd.'

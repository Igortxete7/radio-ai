$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$statePath = Join-Path $taskRoot 'storage\tmp\wsl-keeper.json'
if (!(Test-Path -LiteralPath $statePath)) { Write-Output 'No hay un proceso de continuidad registrado.'; exit 0 }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
if ($state.processId) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.processId)" -ErrorAction SilentlyContinue
    if ($processInfo -and $processInfo.Name -eq 'wsl.exe' -and $processInfo.CommandLine -like '*sleep infinity*' -and $processInfo.CommandLine -like "*$($state.distribution)*") {
        Stop-Process -Id $state.processId
    } else {
        Write-Output 'El PID ya no corresponde al proceso de Radio AI; se conserva el proceso actual.'
    }
}
@{ processId = $null; stoppedAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
Write-Output 'Proceso de continuidad liberado. WSL puede apagarse cuando no queden sesiones.'

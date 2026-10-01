$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$supervisorScript = Join-Path $PSScriptRoot 'supervise-dashboard.ps1'
$taskName = 'AutoLPBotDashboard'
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$launcherSource = Join-Path $PSScriptRoot 'DashboardBackgroundLauncher.cs'
$launcherDirectory = Join-Path $repoRoot 'state\launchers'
$sourceHash = (Get-FileHash -LiteralPath $launcherSource -Algorithm SHA256).Hash.Substring(0, 16)
$launcherExe = Join-Path $launcherDirectory ("DashboardBackgroundLauncher-$sourceHash.exe")
$compilerExe = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compilerExe)) {
  $compilerExe = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $compilerExe)) { throw 'The Windows .NET Framework compiler is unavailable.' }

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  $scriptPathInAction = $existing.Actions | Where-Object { $_.Arguments -and $_.Arguments.Contains($supervisorScript) }
  if (-not $scriptPathInAction) {
    throw "Scheduled task '$taskName' already exists with a different action; it was left unchanged."
  }
}

New-Item -ItemType Directory -Path $launcherDirectory -Force | Out-Null
# Versioned files avoid overwriting a running launcher during upgrades.
if (-not (Test-Path -LiteralPath $launcherExe)) {
  $candidateExe = Join-Path $launcherDirectory ('candidate-{0}.exe' -f [Guid]::NewGuid().ToString('N'))
  & $compilerExe /nologo /target:winexe "/out:$candidateExe" $launcherSource
  if ($LASTEXITCODE -ne 0) { throw 'Background launcher compilation failed.' }
  Move-Item -LiteralPath $candidateExe -Destination $launcherExe
}
$arguments = '"{0}"' -f $supervisorScript
$action = New-ScheduledTaskAction -Execute $launcherExe -Argument $arguments -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 10 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'Keeps the local auto_LP_bot dashboard supervised and restarts it after an unhealthy API or process exit.' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Output "Installed and started $taskName for $currentUser."

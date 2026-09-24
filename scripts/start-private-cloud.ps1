param([switch]$NoDesktop)
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskArgs = @((Join-Path $PSScriptRoot 'start-private-cloud.mjs'))
if ($NoDesktop) { $taskArgs += '--no-desktop' }
& node @taskArgs
exit $LASTEXITCODE

$dir = "symphony_workspaces\.symphony\runs"
$cutoff = [DateTimeOffset]::UtcNow.AddMinutes(-30)

$runs = Get-ChildItem $dir -Directory | ForEach-Object {
  $meta = Join-Path $_.FullName "meta.json"
  if (Test-Path $meta) {
    Get-Content -Raw $meta | ConvertFrom-Json
  }
}

$runs | Where-Object {
  $_.status -eq "running" -and
  $_.role -eq "worker" -and
  [DateTimeOffset]::Parse(($_.activitySnapshot.lastHarnessActivityAt ?? $_.updatedAt)) -gt $cutoff
} | Select-Object issueIdentifier, runId, updatedAt, @{n="lastHarnessActivityAt";e={$_.activitySnapshot.lastHarnessActivityAt}}

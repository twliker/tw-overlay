[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PcAPath,
  [Parameter(Mandatory = $true)]
  [string]$PcBPath,
  [string]$LaterPcAPath = '',
  [string]$LaterPcBPath = '',
  [string]$ExpectedOperationIds = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$issues = [System.Collections.Generic.List[object]]::new()
$warnings = [System.Collections.Generic.List[object]]::new()

function Get-PropertyValue {
  param([object]$InputObject, [string]$Name)
  if ($null -eq $InputObject) { return $null }
  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Get-StringValues {
  param([object]$Values)
  return @(@($Values) | Where-Object { $_ -is [string] -and $_.Length -gt 0 })
}

function Add-Finding {
  param(
    [System.Collections.Generic.List[object]]$Target,
    [string]$Code,
    [string]$Message
  )
  $Target.Add([ordered]@{ code = $Code; message = $Message })
}

function Read-Evidence {
  param([string]$Path, [string]$Role)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Role evidence file was not found."
  }
  try {
    # Keep BOM auto-detection so files redirected by Windows PowerShell (UTF-16 LE)
    # and UTF-8 files written by newer shells are both accepted.
    $evidence = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    throw "$Role evidence file is not valid JSON."
  }
  if ((Get-PropertyValue $evidence 'schemaVersion') -ne 1) {
    throw "$Role evidence schemaVersion is not supported."
  }
  return $evidence
}

function Test-EmptyArray {
  param([object]$Values)
  return @(Get-StringValues $Values).Count -eq 0
}

function Test-SnapshotPair {
  param([object]$PcA, [object]$PcB, [string]$Phase)
  $labelA = Get-PropertyValue $PcA 'deviceLabel'
  $labelB = Get-PropertyValue $PcB 'deviceLabel'
  if ($labelA -ne 'PC-A' -or $labelB -ne 'PC-B') {
    Add-Finding $issues 'device-label' "$Phase evidence must use the PC-A and PC-B labels."
  }

  $profileA = Get-PropertyValue $PcA 'profileState'
  $profileB = Get-PropertyValue $PcB 'profileState'
  if ($profileA -ne 'established' -or $profileB -ne 'established') {
    Add-Finding $issues 'profile-not-established' "$Phase profiles are not both established."
  }

  $generationA = Get-PropertyValue $PcA 'generationId'
  $generationB = Get-PropertyValue $PcB 'generationId'
  if ($generationA -isnot [string] -or $generationA.Length -eq 0 -or $generationA -ne $generationB) {
    Add-Finding $issues 'generation-mismatch' "$Phase generation IDs are empty or do not match."
  }

  $revisionsA = Get-PropertyValue $PcA 'remoteRevisions'
  $revisionsB = Get-PropertyValue $PcB 'remoteRevisions'
  foreach ($kind in @('settings', 'checklist')) {
    $revisionA = Get-PropertyValue $revisionsA $kind
    $revisionB = Get-PropertyValue $revisionsB $kind
    if ($revisionA -isnot [string] -or $revisionA.Length -eq 0 -or $revisionA -ne $revisionB) {
      Add-Finding $issues "$kind-revision-mismatch" "$Phase $kind remote revisions are empty or do not match."
    }
  }

  foreach ($entry in @(
    @{ evidence = $PcA; label = 'PC-A' },
    @{ evidence = $PcB; label = 'PC-B' }
  )) {
    if (-not (Test-EmptyArray (Get-PropertyValue $entry.evidence 'settingsDirtyKeys'))) {
      Add-Finding $issues 'settings-dirty' "$Phase $($entry.label) still has settings dirty keys."
    }
    if (-not (Test-EmptyArray (Get-PropertyValue $entry.evidence 'checklistOutboxIds'))) {
      Add-Finding $issues 'checklist-outbox-pending' "$Phase $($entry.label) still has checklist outbox entries."
    }
    if ($null -ne (Get-PropertyValue $entry.evidence 'shutdownRecovery')) {
      Add-Finding $issues 'shutdown-recovery-pending' "$Phase $($entry.label) still has shutdown recovery state."
    }
  }
}

try {
  if (($LaterPcAPath -and -not $LaterPcBPath) -or ($LaterPcBPath -and -not $LaterPcAPath)) {
    throw 'Later evidence paths for PC-A and PC-B must be provided together.'
  }

  $pcA = Read-Evidence $PcAPath 'PC-A'
  $pcB = Read-Evidence $PcBPath 'PC-B'
  Test-SnapshotPair $pcA $pcB 'Converged'

  $installerA = Get-PropertyValue $pcA 'installerSha256'
  $installerB = Get-PropertyValue $pcB 'installerSha256'
  if ($installerA -is [string] -and $installerA.Length -gt 0 -and
      $installerB -is [string] -and $installerB.Length -gt 0) {
    if ($installerA -ne $installerB) {
      Add-Finding $issues 'installer-hash-mismatch' 'Installer SHA-256 values do not match.'
    }
  } else {
    Add-Finding $warnings 'installer-hash-missing' 'At least one installer SHA-256 is missing; identical builds were not verified.'
  }

  $expectedIds = @($ExpectedOperationIds.Split(',') | ForEach-Object { $_.Trim() } |
    Where-Object { $_.Length -gt 0 } | Select-Object -Unique)
  foreach ($operationId in $expectedIds) {
    foreach ($entry in @(
      @{ evidence = $pcA; label = 'PC-A' },
      @{ evidence = $pcB; label = 'PC-B' }
    )) {
      $confirmed = @(Get-StringValues (Get-PropertyValue $entry.evidence 'confirmedOperationIds'))
      if ($confirmed -notcontains $operationId) {
        Add-Finding $issues 'operation-not-confirmed' "$($entry.label) does not contain expected operation ID: $operationId"
      }
    }
  }

  $laterA = $null
  $laterB = $null
  if ($LaterPcAPath -and $LaterPcBPath) {
    $laterA = Read-Evidence $LaterPcAPath 'Later PC-A'
    $laterB = Read-Evidence $LaterPcBPath 'Later PC-B'
    Test-SnapshotPair $laterA $laterB 'Later'

    foreach ($entry in @(
      @{ before = $pcA; later = $laterA; label = 'PC-A' },
      @{ before = $pcB; later = $laterB; label = 'PC-B' }
    )) {
      if ((Get-PropertyValue $entry.before 'generationId') -ne
          (Get-PropertyValue $entry.later 'generationId')) {
        Add-Finding $issues 'generation-changed' "$($entry.label) generation changed during the idle interval."
      }
      foreach ($kind in @('settings', 'checklist')) {
        $beforeRevision = Get-PropertyValue (Get-PropertyValue $entry.before 'remoteRevisions') $kind
        $laterRevision = Get-PropertyValue (Get-PropertyValue $entry.later 'remoteRevisions') $kind
        if ($beforeRevision -ne $laterRevision) {
          Add-Finding $issues 'unexpected-revision-change' "$($entry.label) $kind revision changed during the idle interval."
        }
      }
    }

    foreach ($operationId in $expectedIds) {
      foreach ($entry in @(
        @{ evidence = $laterA; label = 'Later PC-A' },
        @{ evidence = $laterB; label = 'Later PC-B' }
      )) {
        $confirmed = @(Get-StringValues (Get-PropertyValue $entry.evidence 'confirmedOperationIds'))
        if ($confirmed -notcontains $operationId) {
          Add-Finding $issues 'operation-disappeared' "$($entry.label) lost expected operation ID: $operationId"
        }
      }
    }
  }

  $result = [ordered]@{
    schemaVersion = 1
    passed = $issues.Count -eq 0
    comparedAtUtc = [DateTime]::UtcNow.ToString('o')
    expectedOperationIds = @($expectedIds)
    laterSnapshotChecked = $null -ne $laterA
    issues = @($issues)
    warnings = @($warnings)
  }
  $result | ConvertTo-Json -Depth 6
  if ($issues.Count -gt 0) { exit 1 }
} catch {
  [ordered]@{
    schemaVersion = 1
    passed = $false
    issues = @([ordered]@{ code = 'invalid-input'; message = $_.Exception.Message })
    warnings = @()
  } | ConvertTo-Json -Depth 4
  exit 2
}

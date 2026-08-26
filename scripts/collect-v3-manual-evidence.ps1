[CmdletBinding()]
param(
  [string]$StatePath = (Join-Path $env:APPDATA 'twOverlay\cloud-sync-state.json'),
  [string]$InstallerPath = '',
  [ValidatePattern('^PC-[A-Za-z0-9-]{1,16}$')]
  [string]$DeviceLabel = 'PC-A'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

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

function Get-StringPropertyValues {
  param([object]$Items, [string]$PropertyName)
  $result = foreach ($item in @($Items)) {
    $value = Get-PropertyValue $item $PropertyName
    if ($value -is [string] -and $value.Length -gt 0) { $value }
  }
  return @($result)
}

if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
  throw 'cloud-sync-state.json 파일을 찾을 수 없습니다.'
}

$state = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
$remoteRevisions = Get-PropertyValue $state 'remoteRevisions'
$shutdownRecovery = Get-PropertyValue $state 'shutdownRecovery'
$settingsRecovery = Get-PropertyValue $shutdownRecovery 'settings'
$checklistRecovery = Get-PropertyValue $shutdownRecovery 'checklist'
$restoreResults = foreach ($result in @(Get-PropertyValue $state 'restoreResults')) {
  [ordered]@{
    kind = Get-PropertyValue $result 'kind'
    selected = Get-PropertyValue $result 'selected'
    status = Get-PropertyValue $result 'status'
    revision = Get-PropertyValue $result 'revision'
    lastSyncedAt = Get-PropertyValue $result 'lastSyncedAt'
  }
}

$installerSha256 = $null
if ($InstallerPath) {
  if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    throw '설치 파일을 찾을 수 없습니다.'
  }
  $installerStream = [System.IO.File]::OpenRead($InstallerPath)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha256.ComputeHash($installerStream)
    $installerSha256 = ($hashBytes | ForEach-Object { $_.ToString('X2') }) -join ''
  } finally {
    $sha256.Dispose()
    $installerStream.Dispose()
  }
}

$evidence = [ordered]@{
  schemaVersion = 1
  collectedAtUtc = [DateTime]::UtcNow.ToString('o')
  deviceLabel = $DeviceLabel
  installerSha256 = $installerSha256
  profileState = Get-PropertyValue $state 'profileState'
  generationId = Get-PropertyValue $state 'generationId'
  remoteRevisions = [ordered]@{
    settings = Get-PropertyValue $remoteRevisions 'settings'
    checklist = Get-PropertyValue $remoteRevisions 'checklist'
  }
  settingsDirtyKeys = @(Get-StringValues (Get-PropertyValue $state 'settingsDirtyKeys'))
  checklistOutboxIds = @(Get-StringPropertyValues (Get-PropertyValue $state 'checklistOutbox') 'id')
  confirmedOperationIds = @(Get-StringPropertyValues (Get-PropertyValue $state 'confirmedChecklistOperations') 'id')
  restoreResults = @($restoreResults)
  restorePartial = Get-PropertyValue $state 'restorePartial'
  shutdownRecovery = if ($null -eq $shutdownRecovery) { $null } else {
    [ordered]@{
      createdAt = Get-PropertyValue $shutdownRecovery 'createdAt'
      settings = if ($null -eq $settingsRecovery) { $null } else {
        [ordered]@{
          dirtyKeys = @(Get-StringValues (Get-PropertyValue $settingsRecovery 'dirtyKeys'))
          checksum = Get-PropertyValue $settingsRecovery 'checksum'
          remoteRevision = Get-PropertyValue $settingsRecovery 'remoteRevision'
        }
      }
      checklist = if ($null -eq $checklistRecovery) { $null } else {
        [ordered]@{
          operationIds = @(Get-StringValues (Get-PropertyValue $checklistRecovery 'operationIds'))
          checksum = Get-PropertyValue $checklistRecovery 'checksum'
          remoteRevision = Get-PropertyValue $checklistRecovery 'remoteRevision'
        }
      }
    }
  }
  lastPullAt = Get-PropertyValue $state 'lastPullAt'
}

$evidence | ConvertTo-Json -Depth 8

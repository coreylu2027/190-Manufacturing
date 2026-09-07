param(
  [string]$ToolsDirectory = 'migration-artifacts/tools/pgsql/bin',
  [string]$OutputRoot = 'migration-artifacts/backups'
)
$ErrorActionPreference = 'Stop'
$toolsPath = [IO.Path]::GetFullPath($ToolsDirectory)
$outputPath = [IO.Path]::GetFullPath((Join-Path $OutputRoot (Get-Date -Format 'yyyyMMdd-HHmmss')))
New-Item -ItemType Directory -Path $outputPath | Out-Null
$projectRef = (Get-Content supabase/.temp/project-ref -Raw).Trim()
if ($projectRef -ne 'ltyvookdgibzicplghte') { throw 'Unexpected linked backup project' }
$savedEnv = @{}
try {
  # Keep temporary CLI credentials in memory; never log the generated script.
  $generated = npx supabase db dump --linked --dry-run 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to initialize existing backup credentials' }
  foreach ($line in $generated) {
    if ($line -match '^export (PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE)="([^"\r\n]*)"$') {
      $key = $Matches[1]
      $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
      [Environment]::SetEnvironmentVariable($key, $Matches[2], 'Process')
    }
  }
  if (-not $savedEnv.ContainsKey('PGPASSWORD')) { throw 'CLI backup credentials unavailable' }
  $savedEnv['PGSSLMODE'] = [Environment]::GetEnvironmentVariable('PGSSLMODE', 'Process')
  [Environment]::SetEnvironmentVariable('PGSSLMODE', 'require', 'Process')
  # One consistent database snapshot; schema/data SQL are derived from this archive.
  & "$toolsPath/pg_dump.exe" --role=postgres --format=custom --schema=public --schema=auth --schema=storage --schema=frc190_baserow_stage --schema=supabase_migrations --file="$outputPath/database.dump"
  if ($LASTEXITCODE -ne 0) { throw 'Logical database backup failed' }
  & "$toolsPath/pg_dumpall.exe" --role=postgres --roles-only --no-role-passwords --file="$outputPath/roles.sql"
  if ($LASTEXITCODE -ne 0) { throw 'Role metadata backup failed' }
  & "$toolsPath/pg_restore.exe" --list "$outputPath/database.dump" | Set-Content -LiteralPath "$outputPath/contents.txt"
  if ($LASTEXITCODE -ne 0) { throw 'Backup archive validation failed' }
  & "$toolsPath/pg_restore.exe" --schema-only --file="$outputPath/schema.sql" "$outputPath/database.dump"
  if ($LASTEXITCODE -ne 0) { throw 'Schema extraction failed' }
  & "$toolsPath/pg_restore.exe" --data-only --file="$outputPath/data.sql" "$outputPath/database.dump"
  if ($LASTEXITCODE -ne 0) { throw 'Data extraction failed' }
  $contents = Get-Content -Raw -LiteralPath "$outputPath/contents.txt"
  foreach ($required in @('TABLE DATA auth users','TABLE DATA public quality_control','TABLE DATA public profiles','TABLE DATA public notifications','TABLE DATA frc190_baserow_stage source_rows')) {
    if (-not $contents.Contains($required)) { throw "Missing backup entry: $required" }
  }
  $files = Get-ChildItem -LiteralPath $outputPath -File | ForEach-Object {
    if ($_.Length -eq 0) { throw "Empty backup file: $($_.Name)" }
    @{ name = $_.Name; bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
  }
  $manifest = @{ project_ref = $projectRef; created_at = (Get-Date).ToUniversalTime().ToString('o');
    kind = 'independent PostgreSQL logical backup'; consistent_archive = $true;
    schemas = @('public','auth','storage','frc190_baserow_stage','supabase_migrations');
    restore_test = 'archive listed and schema/data extracted; no restore into production';
    limitations = @('No Storage object bytes; existing Storage was empty at staging', 'No platform configuration, API secrets, or database-role passwords', 'Platform-managed schemas outside the selected schemas are excluded'); files = $files }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$outputPath/manifest.json"
  Write-Output "Independent logical backup verified: $outputPath"
} finally {
  foreach ($key in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnv[$key], 'Process') }
}

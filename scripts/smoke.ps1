$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

npm run build
if ($LASTEXITCODE -ne 0) { throw "Client and Worker build failed" }
npx vitest run --testTimeout=600000
if ($LASTEXITCODE -ne 0) { throw "Vitest failed" }

$server = $null
try {
  $server = Start-Process -FilePath "npx.cmd" -ArgumentList "wrangler", "dev", "--local", "--port", "8787", "--show-interactive-dev-session=false" -PassThru
  $base = "http://127.0.0.1:8787"
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    if ($server.HasExited) { throw "Wrangler exited before becoming ready" }
    if ([DateTime]::UtcNow -ge $deadline) { throw "Wrangler readiness timed out after 30 seconds" }
    Start-Sleep -Milliseconds 200
    try {
      $ready = (Invoke-WebRequest "$base/" -UseBasicParsing).StatusCode -eq 200
    } catch {
      $ready = $false
    }
  } until ($ready)

  $root = Invoke-WebRequest "$base/" -UseBasicParsing
  if ($root.StatusCode -ne 200 -or $root.Content -notmatch '<div id="app"></div>') { throw "React root shell smoke failed" }

  $createdResponse = Invoke-WebRequest "$base/api/pastes" -Method POST -ContentType "application/json" -Body '{"content":"smoke source","title":"smoke.txt","expiration":60}' -UseBasicParsing
  if ($createdResponse.StatusCode -ne 201) { throw "JSON create smoke failed" }
  $created = $createdResponse.Content | ConvertFrom-Json
  if ([string]::IsNullOrEmpty($created.id) -or $created.content -ne "smoke source") { throw "JSON create response smoke failed" }

  $raw = curl.exe -sS "$base/raw/$($created.id)"
  if ($raw -cne "smoke source") { throw "Raw representation smoke failed" }

  $resource = Invoke-WebRequest "$base/api/pastes/$($created.id)" -UseBasicParsing
  $etag = [string]$resource.Headers.ETag
  if ($resource.StatusCode -ne 200 -or $etag -notmatch '^"sha256-[A-Za-z0-9_-]{43}"$') { throw "Strong ETag smoke failed" }
  $notModified = Invoke-WebRequest "$base/api/pastes/$($created.id)" -Headers @{ "If-None-Match" = $etag } -SkipHttpErrorCheck -UseBasicParsing
  if (
    $notModified.StatusCode -ne 304 -or
    $notModified.Headers.ETag -ne $etag -or
    $notModified.Headers.'Cache-Control' -ne "no-store" -or
    $notModified.RawContentLength -ne 0 -or
    $notModified.Headers.'Content-Type'
  ) { throw "Conditional ETag smoke failed" }

  $settingsResponse = Invoke-WebRequest "$base/api/pastes/$($created.id)/settings" -Method PATCH -ContentType "application/json" -Body (ConvertTo-Json @{ title = "updated smoke"; format = "markdown"; version = $created.version } -Compress) -UseBasicParsing
  $settingsResult = $settingsResponse.Content | ConvertFrom-Json
  if ($settingsResponse.StatusCode -ne 200 -or $settingsResult.paste.title -ne "updated smoke" -or $settingsResult.paste.format -ne "markdown") { throw "Settings update smoke failed" }
  $settings = Invoke-RestMethod "$base/api/pastes/$($created.id)/settings"
  if ($settings.title -ne "updated smoke" -or $settings.format -ne "markdown") { throw "Settings round-trip smoke failed" }

  $contentResponse = Invoke-WebRequest "$base/api/pastes/$($created.id)" -Method PATCH -ContentType "application/json" -Body (ConvertTo-Json @{ content = "history source"; version = $settingsResult.paste.version } -Compress) -UseBasicParsing
  $contentResult = $contentResponse.Content | ConvertFrom-Json
  $history = Invoke-RestMethod "$base/api/pastes/$($created.id)/history"
  if ($history.currentVersion -ne $contentResult.paste.version -or $history.revisions.Count -lt 1) { throw "History list smoke failed" }
  $snapshot = Invoke-RestMethod "$base/api/pastes/$($created.id)/history/$($history.revisions[0].revision)"
  if ($snapshot.content -ne "smoke source") { throw "History snapshot smoke failed" }

  $password = "a+b %25"
  $passwordResponse = Invoke-WebRequest "$base/api/pastes/$($created.id)/password" -Method PUT -ContentType "application/json" -Body (ConvertTo-Json @{ newPassword = $password; version = $contentResult.paste.version } -Compress) -UseBasicParsing
  $passwordResult = $passwordResponse.Content | ConvertFrom-Json
  $encodedPassword = [uri]::EscapeDataString($password)
  $protectedResource = Invoke-WebRequest "$base/api/pastes/$($created.id)?password=$encodedPassword" -UseBasicParsing
  if ($passwordResult.paste.protected -ne $true -or $protectedResource.StatusCode -ne 200) { throw "Password round-trip smoke failed" }

  $onceResponse = Invoke-WebRequest "$base/api/pastes" -Method POST -ContentType "application/json" -Body '{"content":"once","password":"a+b %25","viewOnce":true,"expiration":60}' -UseBasicParsing
  $once = $onceResponse.Content | ConvertFrom-Json
  $first = Invoke-WebRequest "$base/raw/$($once.id)?password=$encodedPassword" -UseBasicParsing
  if ($first.StatusCode -ne 200 -or $first.Content -cne "once") { throw "View-once first read smoke failed" }
  $second = Invoke-WebRequest "$base/raw/$($once.id)?password=$encodedPassword" -SkipHttpErrorCheck -UseBasicParsing
  if ($second.StatusCode -ne 404) { throw "View-once second read smoke failed" }

  $htmlContent = "exact <em>HTML</em>"
  $htmlResponse = Invoke-WebRequest "$base/api/pastes" -Method POST -ContentType "application/json" -Body (ConvertTo-Json @{ content = $htmlContent; format = "markdown"; expiration = 60 } -Compress) -UseBasicParsing
  $html = $htmlResponse.Content | ConvertFrom-Json
  $htmlRepresentation = Invoke-WebRequest "$base/html/$($html.id)" -UseBasicParsing
  if ($htmlRepresentation.Content -cne $htmlContent -or $htmlRepresentation.Headers.'Content-Security-Policy') { throw "HTML representation smoke failed" }

  $trace = curl.exe -sS -X POST "$base/ip-trace" -H "X-Smoke: yes" --data-binary "trace" | ConvertFrom-Json
  if ($trace.data -ne "trace" -or $trace.headers.'x-smoke' -ne "yes") { throw "ip-trace smoke failed" }

  foreach ($path in @("$base/api", "$base/delete/$($created.id)")) {
    $missing = Invoke-WebRequest $path -SkipHttpErrorCheck -UseBasicParsing
    if ($missing.StatusCode -ne 404) { throw "Legacy 404 smoke failed for $path" }
  }
} finally {
  if ($null -ne $server -and -not $server.HasExited) {
    taskkill.exe /PID $server.Id /T /F | Out-Null
  }

  $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $cleanupDeadline)

  if (@(Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue).Count -ne 0) {
    throw "Wrangler port 8787 remained open after cleanup"
  }
}

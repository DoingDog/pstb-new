$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-HttpResponse {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Uri,
    [string]$Method = "GET",
    [string]$ContentType,
    [hashtable]$Headers,
    [string]$Body,
    [int]$TimeoutMilliseconds = 30000
  )

  $request = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($Uri)
  $request.Method = $Method
  $request.Timeout = $TimeoutMilliseconds
  $request.ReadWriteTimeout = $TimeoutMilliseconds
  if ($null -ne $ContentType) { $request.ContentType = $ContentType }
  if ($null -ne $Headers) {
    foreach ($header in $Headers.GetEnumerator()) {
      $request.Headers[[string]$header.Key] = [string]$header.Value
    }
  }
  if ($null -ne $Body) {
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $request.ContentLength = $bodyBytes.Length
    $requestStream = $request.GetRequestStream()
    try {
      $requestStream.Write($bodyBytes, 0, $bodyBytes.Length)
    } finally {
      $requestStream.Dispose()
    }
  }

  try {
    $response = [System.Net.HttpWebResponse]$request.GetResponse()
  } catch [System.Net.WebException] {
    if ($null -eq $_.Exception.Response) { throw }
    $response = [System.Net.HttpWebResponse]$_.Exception.Response
  }

  try {
    $content = ""
    $responseStream = $response.GetResponseStream()
    if ($null -ne $responseStream) {
      $reader = [System.IO.StreamReader]::new($responseStream, [System.Text.Encoding]::UTF8, $true)
      try {
        $content = $reader.ReadToEnd()
      } finally {
        $reader.Dispose()
      }
    }
    [pscustomobject]@{
      StatusCode = [int]$response.StatusCode
      Headers = $response.Headers
      Content = $content
    }
  } finally {
    $response.Close()
  }
}

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
    $remainingMilliseconds = [Math]::Floor(($deadline - [DateTime]::UtcNow).TotalMilliseconds)
    if ($remainingMilliseconds -le 0) { throw "Wrangler readiness timed out after 30 seconds" }
    $timeoutMilliseconds = [int][Math]::Min(1000, $remainingMilliseconds)
    try {
      $ready = (Invoke-HttpResponse "$base/" -TimeoutMilliseconds $timeoutMilliseconds).StatusCode -eq 200
    } catch {
      $ready = $false
    }
    if (-not $ready) { Start-Sleep -Milliseconds 200 }
  } until ($ready)

  $root = Invoke-HttpResponse "$base/"
  if ($root.StatusCode -ne 200 -or $root.Content -notmatch '<div id="app"></div>') { throw "React root shell smoke failed" }

  $createdResponse = Invoke-HttpResponse "$base/api/pastes" -Method POST -ContentType "application/json" -Body '{"content":"smoke source","title":"smoke.txt","expiration":60}'
  if ($createdResponse.StatusCode -ne 201) { throw "JSON create smoke failed" }
  $created = $createdResponse.Content | ConvertFrom-Json
  if ([string]::IsNullOrEmpty($created.id) -or $created.content -ne "smoke source") { throw "JSON create response smoke failed" }

  $raw = curl.exe -sS "$base/raw/$($created.id)"
  if ($raw -cne "smoke source") { throw "Raw representation smoke failed" }

  $resource = Invoke-HttpResponse "$base/api/pastes/$($created.id)"
  $etag = [string]$resource.Headers.ETag
  if ($resource.StatusCode -ne 200 -or $etag -notmatch '^"sha256-[A-Za-z0-9_-]{43}"$') { throw "Strong ETag smoke failed" }
  $notModified = Invoke-HttpResponse "$base/api/pastes/$($created.id)" -Headers @{ "If-None-Match" = $etag }
  if (
    $notModified.StatusCode -ne 304 -or
    $notModified.Headers.ETag -ne $etag -or
    $notModified.Headers.'Cache-Control' -ne "no-store" -or
    $null -ne $notModified.Headers["Content-Length"] -or
    $null -ne $notModified.Headers["Content-Type"] -or
    $null -ne $notModified.Headers["Trailer"] -or
    $notModified.Content.Length -ne 0
  ) { throw "Conditional ETag smoke failed" }

  $settingsResponse = Invoke-HttpResponse "$base/api/pastes/$($created.id)/settings" -Method PATCH -ContentType "application/json" -Body (ConvertTo-Json @{ title = "updated smoke"; format = "markdown"; version = $created.version } -Compress)
  $settingsResult = $settingsResponse.Content | ConvertFrom-Json
  if ($settingsResponse.StatusCode -ne 200 -or $settingsResult.paste.title -ne "updated smoke" -or $settingsResult.paste.format -ne "markdown") { throw "Settings update smoke failed" }
  $settings = (Invoke-HttpResponse "$base/api/pastes/$($created.id)/settings").Content | ConvertFrom-Json
  if ($settings.title -ne "updated smoke" -or $settings.format -ne "markdown") { throw "Settings round-trip smoke failed" }

  $contentResponse = Invoke-HttpResponse "$base/api/pastes/$($created.id)" -Method PATCH -ContentType "application/json" -Body (ConvertTo-Json @{ content = "history source"; version = $settingsResult.paste.version } -Compress)
  $contentResult = $contentResponse.Content | ConvertFrom-Json
  $history = (Invoke-HttpResponse "$base/api/pastes/$($created.id)/history").Content | ConvertFrom-Json
  if ($history.currentVersion -ne $contentResult.paste.version -or $history.revisions.Count -lt 1) { throw "History list smoke failed" }
  $snapshot = (Invoke-HttpResponse "$base/api/pastes/$($created.id)/history/$($history.revisions[0].revision)").Content | ConvertFrom-Json
  if ($snapshot.content -ne "smoke source") { throw "History snapshot smoke failed" }

  $password = "a+b %25"
  $passwordResponse = Invoke-HttpResponse "$base/api/pastes/$($created.id)/password" -Method PUT -ContentType "application/json" -Body (ConvertTo-Json @{ newPassword = $password; version = $contentResult.paste.version } -Compress)
  $passwordResult = $passwordResponse.Content | ConvertFrom-Json
  $encodedPassword = [uri]::EscapeDataString($password)
  $protectedResource = Invoke-HttpResponse "$base/api/pastes/$($created.id)?password=$encodedPassword"
  if ($passwordResult.paste.protected -ne $true -or $protectedResource.StatusCode -ne 200) { throw "Password round-trip smoke failed" }

  $onceResponse = Invoke-HttpResponse "$base/api/pastes" -Method POST -ContentType "application/json" -Body '{"content":"once","password":"a+b %25","viewOnce":true,"expiration":60}'
  $once = $onceResponse.Content | ConvertFrom-Json
  $first = Invoke-HttpResponse "$base/raw/$($once.id)?password=$encodedPassword"
  if ($first.StatusCode -ne 200 -or $first.Content -cne "once") { throw "View-once first read smoke failed" }
  $second = Invoke-HttpResponse "$base/raw/$($once.id)?password=$encodedPassword"
  if ($second.StatusCode -ne 404) { throw "View-once second read smoke failed" }

  $htmlContent = "exact <em>HTML</em>"
  $htmlResponse = Invoke-HttpResponse "$base/api/pastes" -Method POST -ContentType "application/json" -Body (ConvertTo-Json @{ content = $htmlContent; format = "markdown"; expiration = 60 } -Compress)
  $html = $htmlResponse.Content | ConvertFrom-Json
  $htmlRepresentation = Invoke-HttpResponse "$base/html/$($html.id)"
  if ($htmlRepresentation.Content -cne $htmlContent -or $htmlRepresentation.Headers.'Content-Security-Policy') { throw "HTML representation smoke failed" }

  $trace = curl.exe -sS -X POST "$base/ip-trace" -H "X-Smoke: yes" --data-binary "trace" | ConvertFrom-Json
  if ($trace.data -ne "trace" -or $trace.headers.'x-smoke' -ne "yes") { throw "ip-trace smoke failed" }

  foreach ($path in @("$base/api", "$base/delete/$($created.id)")) {
    $missing = Invoke-HttpResponse $path
    if ($missing.StatusCode -ne 404) { throw "Legacy 404 smoke failed for $path" }
  }
} finally {
  if ($null -ne $server) {
    taskkill.exe /PID $server.Id /T /F 2>$null | Out-Null
  }

  $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
      Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    if ($listeners.Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $cleanupDeadline)

  if (@(Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue).Count -ne 0) {
    throw "Wrangler port 8787 remained open after cleanup"
  }
}

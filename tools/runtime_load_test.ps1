param(
    [int]$Duration = 10,
    [int]$Warmup = 2,
    [int]$Concurrency = 128,
    [int]$Connections = 4,
    [int]$Payload = 256,
    [int]$Delay = 0,
    [ValidateSet("node", "rust")]
    [string]$Client = "node",
    [switch]$RequireBackpressure,
    [switch]$Release
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$RuntimeProfile = if ($Release) { "release" } else { "debug" }
$RuntimeExe = Join-Path $Root "target\$RuntimeProfile\ets_runtime.exe"
$ClientScript = Join-Path $Root "dist\runtime_load_test.cjs"
$RustClient = Join-Path $Root "target\$RuntimeProfile\runtime_load.exe"
$Stdout = Join-Path $Root "tmp_runtime_load_stdout.log"
$Stderr = Join-Path $Root "tmp_runtime_load_stderr.log"
Remove-Item -LiteralPath $Stdout, $Stderr -Force -ErrorAction SilentlyContinue

$process = Start-Process `
    -FilePath $RuntimeExe `
    -ArgumentList "configs/local/bench.json" `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $Stdout `
    -RedirectStandardError $Stderr `
    -WindowStyle Hidden `
    -PassThru

try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        $tcpClient = [Net.Sockets.TcpClient]::new()
        try {
            $connect = $tcpClient.ConnectAsync("127.0.0.1", 7400)
            if ($connect.Wait(200) -and $tcpClient.Connected) {
                break
            }
        }
        catch {
        }
        finally {
            $tcpClient.Dispose()
        }
        Start-Sleep -Milliseconds 50
    }

    $loadArgs = @(
        "--duration", $Duration,
        "--warmup", $Warmup,
        "--concurrency", $Concurrency,
        "--connections", $Connections,
        "--payload", $Payload,
        "--delay", $Delay
    )
    if ($Client -eq "rust") {
        & $RustClient @loadArgs
    }
    else {
        & node $ClientScript @loadArgs
    }
    if ($LASTEXITCODE -ne 0) {
        throw "runtime load test failed with exit code $LASTEXITCODE"
    }
    $metricsWaitMs = if ($RequireBackpressure) { 2500 } else { 500 }
    Start-Sleep -Milliseconds $metricsWaitMs
}
finally {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }
    $process.WaitForExit()
}

$metricLines = Get-Content $Stdout |
    Select-String -Pattern "\[metrics:bench\]|\[metrics:inner_transport\]" |
    ForEach-Object { $_.Line }
$metricLines | ForEach-Object { Write-Host $_ }

if ($RequireBackpressure) {
    $benchMetrics = $metricLines | Where-Object { $_ -match "\[metrics:bench\]" }
    $maxQueue = 0
    $backpressure = 0
    $slowDisconnects = 0
    foreach ($line in $benchMetrics) {
        if ($line -match "rust_max_queue=(\d+)") {
            $maxQueue = [Math]::Max($maxQueue, [int]$Matches[1])
        }
        if ($line -match "backpressure=(\d+)") {
            $backpressure = [Math]::Max($backpressure, [int]$Matches[1])
        }
        if ($line -match "slow_disconnects=(\d+)") {
            $slowDisconnects = [Math]::Max($slowDisconnects, [int]$Matches[1])
        }
    }
    if ($backpressure -le 0) {
        throw "expected backpressure to activate"
    }
    if ($maxQueue -gt 4096) {
        throw "Rust ingress queue exceeded capacity: $maxQueue"
    }
    if ($slowDisconnects -ne 0) {
        throw "healthy localhost clients were disconnected: $slowDisconnects"
    }
    Write-Host "backpressure acceptance passed: max_queue=$maxQueue waits=$backpressure"
}
if ((Get-Item $Stderr).Length -gt 0) {
    Write-Host "server stderr:"
    Get-Content $Stderr
}

param(
    [ValidateSet("all", "split", "both")]
    [string]$Mode = "both",
    [string]$Players = "10,50,100",
    [string]$MoveRates = "10,0",
    [int]$Duration = 5,
    [int]$Warmup = 2,
    [int]$SetupConcurrency = 16,
    [string]$Payloads = "64,256,1024,4096,16384",
    [int]$BaselineConcurrency = 512,
    [int]$BaselineConnections = 8,
    [switch]$SkipBaseline,
    [switch]$SkipGameplay,
    [switch]$DebugRuntime
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Profile = if ($DebugRuntime) { "debug" } else { "release" }
$RuntimeExe = Join-Path $Root "target\$Profile\TiangZ.exe"
$RuntimeLoadExe = Join-Path $Root "target\$Profile\runtime_load.exe"
$GameClient = Join-Path $Root "dist\full_chain_load_test.cjs"
$ResultDir = Join-Path $Root "perf\results"
$RunId = Get-Date -Format "yyyyMMdd_HHmmss"
$LogDir = Join-Path $ResultDir "logs\$RunId"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

foreach ($file in $RuntimeExe, $RuntimeLoadExe, $GameClient) {
    if (-not (Test-Path $file)) { throw "required artifact not found: $file" }
}

$playerCounts = @($Players.Split(",") | ForEach-Object { [int]$_.Trim() })
$movementRates = @($MoveRates.Split(",") | ForEach-Object { [double]$_.Trim() })
$payloadSizes = @($Payloads.Split(",") | ForEach-Object { [int]$_.Trim() })
$baselineResults = [System.Collections.ArrayList]::new()
$gameplayResults = [System.Collections.ArrayList]::new()
$RawResultPath = Join-Path $ResultDir "full_chain_${RunId}_raw.jsonl"

function Wait-TcpPort {
    param([int]$Port, [int]$TimeoutMs = 15000)
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        $client = [Net.Sockets.TcpClient]::new()
        try {
            $connect = $client.ConnectAsync("127.0.0.1", $Port)
            if ($connect.Wait(200) -and $client.Connected) { return }
        }
        catch {}
        finally { $client.Dispose() }
        Start-Sleep -Milliseconds 50
    }
    throw "timed out waiting for 127.0.0.1:$Port"
}

function Start-Runtime {
    param([string]$Config, [string]$Name)
    $stdout = Join-Path $LogDir "${Name}_stdout.log"
    $stderr = Join-Path $LogDir "${Name}_stderr.log"
    $process = Start-Process `
        -FilePath $RuntimeExe `
        -ArgumentList $Config `
        -WorkingDirectory $Root `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -WindowStyle Hidden `
        -PassThru
    return [pscustomobject]@{ Process = $process; Stdout = $stdout; Stderr = $stderr }
}

function Stop-Runtimes {
    param([object[]]$Handles)
    foreach ($handle in $Handles) {
        if (-not $handle.Process.HasExited) { Stop-Process -Id $handle.Process.Id -Force }
        $handle.Process.WaitForExit()
    }
}

function Invoke-Baseline {
    Write-Host "[full-chain] framework RPC payload baseline"
    $handle = Start-Runtime "configs/local/bench.json" "baseline"
    try {
        Wait-TcpPort 7400
        foreach ($payload in $payloadSizes) {
            $arguments = @(
                "--duration", $Duration,
                "--warmup", $Warmup,
                "--connections", $BaselineConnections,
                "--concurrency", $BaselineConcurrency,
                "--payload", $payload,
                "--delay", 0
            )
            $output = @(& $RuntimeLoadExe @arguments 2>&1 | ForEach-Object { $_.ToString() })
            $output | ForEach-Object { Write-Host $_ }
            if ($LASTEXITCODE -ne 0) { throw "baseline client failed for ${payload}B" }
            $summary = $output | Where-Object { $_ -match "requests=(\d+) req/s=([0-9.]+) errors=(\d+)" } | Select-Object -Last 1
            $latency = $output | Where-Object { $_ -match "latency_ms p50=([0-9.]+) p95=([0-9.]+) p99=([0-9.]+) max=([0-9.]+)" } | Select-Object -Last 1
            if (-not $summary -or -not $latency) { throw "failed to parse baseline output" }
            $summary -match "requests=(\d+) req/s=([0-9.]+) errors=(\d+)" | Out-Null
            $requests = [int64]$Matches[1]
            $rps = [double]$Matches[2]
            $errors = [int]$Matches[3]
            $latency -match "latency_ms p50=([0-9.]+) p95=([0-9.]+) p99=([0-9.]+) max=([0-9.]+)" | Out-Null
            $result = [pscustomobject]@{
                payloadBytes = $payload
                requests = $requests
                requestsPerSecond = $rps
                errors = $errors
                p50Ms = [double]$Matches[1]
                p95Ms = [double]$Matches[2]
                p99Ms = [double]$Matches[3]
                maxMs = [double]$Matches[4]
            }
            [void]$baselineResults.Add($result)
            Add-Content -LiteralPath $RawResultPath -Value (([pscustomobject]@{ type = "baseline"; value = $result }) | ConvertTo-Json -Compress)
        }
    }
    finally { Stop-Runtimes @($handle) }
}

function Invoke-GameplayCase {
    param([string]$Deployment, [int]$PlayerCount, [double]$MoveRate)
    $workload = if ($MoveRate -gt 0) { "${MoveRate}hz" } else { "saturation" }
    Write-Host "[full-chain] deployment=$Deployment players=$PlayerCount workload=$workload"
    $handles = @()
    try {
        if ($Deployment -eq "all") {
            $handles += Start-Runtime "configs/local/all.json" "${Deployment}_${PlayerCount}_${workload}_all"
        }
        else {
            foreach ($name in "log", "mgr", "login1", "login2", "gate1", "map1") {
                $handles += Start-Runtime "configs/local/$name.json" "${Deployment}_${PlayerCount}_${workload}_$name"
            }
        }
        foreach ($port in 7000, 7001, 7002, 7100, 7201, 7301) { Wait-TcpPort $port }
        $output = @(& node $GameClient `
            --players $PlayerCount `
            --setup-concurrency $SetupConcurrency `
            --duration $Duration `
            --warmup $Warmup `
            --move-rate $MoveRate `
            --label $Deployment 2>&1 | ForEach-Object { $_.ToString() })
        $output | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { throw "gameplay client failed: $Deployment/$PlayerCount" }
        $jsonLine = $output | Where-Object { $_ -like "RESULT_JSON *" } | Select-Object -Last 1
        if (-not $jsonLine) { throw "gameplay client did not return RESULT_JSON" }
        $result = $jsonLine.Substring("RESULT_JSON ".Length) | ConvertFrom-Json
        $result | Add-Member -NotePropertyName logDirectory -NotePropertyValue $LogDir
        [void]$gameplayResults.Add($result)
        Add-Content -LiteralPath $RawResultPath -Value (([pscustomobject]@{ type = "gameplay"; value = $result }) | ConvertTo-Json -Depth 8 -Compress)
    }
    finally { Stop-Runtimes $handles }
}

if (-not $SkipBaseline) { Invoke-Baseline }
if (-not $SkipGameplay) {
    $deployments = if ($Mode -eq "both") { @("all", "split") } else { @($Mode) }
    foreach ($deployment in $deployments) {
        foreach ($playerCount in $playerCounts) {
            foreach ($moveRate in $movementRates) {
                Invoke-GameplayCase $deployment $playerCount $moveRate
            }
        }
    }
}

$cpu = try { (Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name).Trim() } catch { "unknown" }
$memory = try { [Math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1) } catch { 0 }
$report = [ordered]@{
    generatedAt = (Get-Date).ToString("o")
    runId = $RunId
    profile = $Profile
    machine = [ordered]@{ cpu = $cpu; memoryGB = $memory; os = [Environment]::OSVersion.VersionString }
    parameters = [ordered]@{
        durationSeconds = $Duration
        warmupSeconds = $Warmup
        setupConcurrency = $SetupConcurrency
        baselineConcurrency = $BaselineConcurrency
        baselineConnections = $BaselineConnections
        moveRates = $movementRates
    }
    baseline = $baselineResults.ToArray()
    gameplay = $gameplayResults.ToArray()
}

$json = $report | ConvertTo-Json -Depth 8
$jsonPath = Join-Path $ResultDir "full_chain_$RunId.json"
$latestJsonPath = Join-Path $ResultDir "full_chain_latest.json"
[System.IO.File]::WriteAllText($jsonPath, $json, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($latestJsonPath, $json, [System.Text.UTF8Encoding]::new($false))

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add("# 全链路性能测试报告")
$lines.Add("")
$lines.Add("- 时间：$($report.generatedAt)")
$lines.Add("- Profile：$Profile")
$lines.Add("- CPU：$cpu")
$lines.Add("- 内存：${memory}GB")
$lines.Add("- 正式测试：${Duration}s；预热：${Warmup}s")
$lines.Add("")
if ($baselineResults.Count -gt 0) {
    $lines.Add("## 框架 RPC 基线")
    $lines.Add("")
    $lines.Add("| Payload | req/s | p50 ms | p95 ms | p99 ms | errors |")
    $lines.Add("|---:|---:|---:|---:|---:|---:|")
    foreach ($item in $baselineResults) {
        $lines.Add("| $($item.payloadBytes)B | $([Math]::Round($item.requestsPerSecond)) | $($item.p50Ms) | $($item.p95Ms) | $($item.p99Ms) | $($item.errors) |")
    }
    $lines.Add("")
}
$lines.Add("## 真实游戏链路")
$lines.Add("")
$lines.Add("| 部署 | 负载 | 玩家 | 登录 users/s | 登录 p95 ms | move/s | AOI push/s | move p50 ms | p95 ms | p99 ms | stalled |")
$lines.Add("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
foreach ($item in $gameplayResults) {
    $lines.Add("| $($item.label) | $($item.workload) | $($item.players) | $([Math]::Round($item.setup.perSecond, 1)) | $([Math]::Round($item.setup.p95Ms, 2)) | $([Math]::Round($item.movement.perSecond, 1)) | $([Math]::Round($item.movement.pushesPerSecond, 1)) | $([Math]::Round($item.movement.p50Ms, 2)) | $([Math]::Round($item.movement.p95Ms, 2)) | $([Math]::Round($item.movement.p99Ms, 2)) | $($item.movement.errors) |")
}
$lines.Add("")
$lines.Add("说明：move/s 是客户端发送移动到收到自身权威移动 Push 的闭环吞吐；AOI push/s 包括同地图所有玩家收到的 EntityMove Push。")
$lines.Add("")
$lines.Add("## 结果判读")
$lines.Add("")
$lines.Add("- all：一个操作系统进程、一个 V8、多个 EntryScene，本地 Scene 调用不经过 TCP。")
$lines.Add("- split：六个操作系统进程，跨 Scene 调用经过内部 TCP 和 rpcId 多路复用。")
$lines.Add("- 当前 Demo 对同地图玩家执行全量广播，N 个玩家每次移动会产生 N 条 Push；该结果包含 O(N^2) 业务放大，不等于纯框架消息上限。")
$lines.Add("- stalled 表示玩家在截止时间内没有收到自身权威移动；延迟分位数只统计已完成闭环，必须与 stalled 一起判断。")
$lines.Add("- 这是单轮短时本机样本，不应直接作为生产 SLA；容量验收应增加长时间、多轮中位数和独立压测机。")
$stalledCases = @($gameplayResults | Where-Object { $_.movement.errors -gt 0 })
if ($stalledCases.Count -gt 0) {
    $firstStalled = $stalledCases[0]
    $lines.Add("- 本轮首次出现停滞：$($firstStalled.label) / $($firstStalled.workload) / $($firstStalled.players) 玩家，stalled=$($firstStalled.movement.errors)。请结合对应 Runtime 日志的 inner_transport overloads 定位。")
}
$markdown = $lines -join "`n"
$markdownPath = Join-Path $ResultDir "full_chain_$RunId.md"
$latestMarkdownPath = Join-Path $ResultDir "full_chain_latest.md"
[System.IO.File]::WriteAllText($markdownPath, $markdown, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($latestMarkdownPath, $markdown, [System.Text.UTF8Encoding]::new($false))

Write-Host "[full-chain] report: $markdownPath"
Write-Host $markdown

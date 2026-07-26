param(
    [ValidateSet("all", "split", "both")]
    [string]$Mode = "both"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http
$Root = Split-Path $PSScriptRoot -Parent
$RuntimeExe = Join-Path $Root "target\debug\TiangZ.exe"
$SmokeClient = Join-Path $Root "dist\smoke_client.cjs"

if (-not (Test-Path $RuntimeExe)) {
    throw "runtime binary not found: $RuntimeExe"
}
if (-not (Test-Path $SmokeClient)) {
    throw "smoke client not found: $SmokeClient"
}

function Wait-TcpPort {
    param([int]$Port, [int]$TimeoutMs = 10000)

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        $client = [Net.Sockets.TcpClient]::new()
        try {
            $connect = $client.ConnectAsync("127.0.0.1", $Port)
            if ($connect.Wait(200) -and $client.Connected) {
                return
            }
        }
        catch {
        }
        finally {
            $client.Dispose()
        }
        Start-Sleep -Milliseconds 50
    }
    throw "timed out waiting for 127.0.0.1:$Port"
}

function Wait-HealthReady {
    param([int]$Port, [int]$TimeoutMs = 10000)

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    $client = [Net.Http.HttpClient]::new()
    try {
        while ([DateTime]::UtcNow -lt $deadline) {
            try {
                $response = $client.GetAsync("http://127.0.0.1:$Port/ready").GetAwaiter().GetResult()
                if ([int]$response.StatusCode -eq 200) {
                    $response.Dispose()
                    return
                }
                $response.Dispose()
            }
            catch {
            }
            Start-Sleep -Milliseconds 50
        }
    }
    finally {
        $client.Dispose()
    }
    throw "timed out waiting for http://127.0.0.1:$Port/ready"
}

function Start-RuntimeProcess {
    param([string]$Config, [string]$LogName)

    $stdout = Join-Path $Root "tmp_smoke_${LogName}_stdout.log"
    $stderr = Join-Path $Root "tmp_smoke_${LogName}_stderr.log"
    Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
    return Start-Process `
        -FilePath $RuntimeExe `
        -ArgumentList $Config `
        -WorkingDirectory $Root `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -WindowStyle Hidden `
        -PassThru
}

function Stop-RuntimeProcesses {
    param([System.Diagnostics.Process[]]$Processes)

    foreach ($process in $Processes) {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force
        }
        $process.WaitForExit()
    }
}

function Invoke-SmokeClient {
    & node $SmokeClient
    if ($LASTEXITCODE -ne 0) {
        throw "smoke client failed with exit code $LASTEXITCODE"
    }
}

function Invoke-AllInOneSmoke {
    Write-Host "[smoke] all-in-one"
    $processes = @()
    $succeeded = $false
    try {
        $processes += Start-RuntimeProcess "configs/local/all.json" "all"
        foreach ($port in 7000, 7001, 7002, 7201, 7301) {
            Wait-TcpPort $port
        }
        Wait-HealthReady 7600
        Invoke-SmokeClient
        $succeeded = $true
    }
    finally {
        Stop-RuntimeProcesses $processes
        if ($succeeded) {
            Remove-Item (Join-Path $Root "tmp_smoke_all_*.log") -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-SplitSmoke {
    Write-Host "[smoke] split-process"
    $processes = @()
    $succeeded = $false
    $configs = @("mgr", "login1", "login2", "gate1", "map1")
    try {
        foreach ($name in $configs) {
            $processes += Start-RuntimeProcess "configs/local/$name.json" "split_$name"
        }
        foreach ($port in 7000, 7001, 7002, 7201, 7301) {
            Wait-TcpPort $port
        }
        Invoke-SmokeClient
        $succeeded = $true
    }
    finally {
        Stop-RuntimeProcesses $processes
        if ($succeeded) {
            Remove-Item (Join-Path $Root "tmp_smoke_split_*.log") -Force -ErrorAction SilentlyContinue
        }
    }
}

Push-Location $Root
try {
    if ($Mode -eq "all" -or $Mode -eq "both") {
        Invoke-AllInOneSmoke
    }
    if ($Mode -eq "split" -or $Mode -eq "both") {
        Invoke-SplitSmoke
    }
    Write-Host "[smoke] runtime smoke passed"
}
finally {
    Pop-Location
}

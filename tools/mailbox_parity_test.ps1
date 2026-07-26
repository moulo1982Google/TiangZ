param(
    [ValidateSet("all", "split", "both")]
    [string]$Mode = "both"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$RuntimeExe = Join-Path $Root "target\debug\TiangZ.exe"
$Client = Join-Path $Root "dist\mailbox_parity_test.cjs"

function Wait-TcpPort {
    param([int]$Port, [int]$TimeoutMs = 10000)
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        $tcp = [Net.Sockets.TcpClient]::new()
        try {
            $connect = $tcp.ConnectAsync("127.0.0.1", $Port)
            if ($connect.Wait(200) -and $tcp.Connected) { return }
        }
        catch {
        }
        finally {
            $tcp.Dispose()
        }
        Start-Sleep -Milliseconds 50
    }
    throw "timed out waiting for 127.0.0.1:$Port"
}

function Start-Runtime {
    param([string]$Config, [string]$Name)
    $stdout = Join-Path $Root "tmp_mailbox_${Name}_stdout.log"
    $stderr = Join-Path $Root "tmp_mailbox_${Name}_stderr.log"
    Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath $RuntimeExe -ArgumentList $Config `
        -WorkingDirectory $Root -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
}

function Stop-Runtimes {
    param([System.Diagnostics.Process[]]$Processes)
    foreach ($process in $Processes) {
        if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
        $process.WaitForExit()
    }
}

function Invoke-Case {
    param([string]$Name, [string[]]$Configs)
    Write-Host "[mailbox-parity] $Name"
    $processes = @()
    try {
        foreach ($config in $Configs) {
            $processes += Start-Runtime $config "$Name-$([IO.Path]::GetFileNameWithoutExtension($config))"
        }
        Wait-TcpPort 7400
        Wait-TcpPort 7410
        & node $Client
        if ($LASTEXITCODE -ne 0) {
            throw "mailbox parity client failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Stop-Runtimes $processes
    }
}

Push-Location $Root
try {
    if ($Mode -eq "all" -or $Mode -eq "both") {
        Invoke-Case "all-in-one" @("configs/tests/mailbox_parity_all.json")
    }
    if ($Mode -eq "split" -or $Mode -eq "both") {
        Invoke-Case "split-process" @(
            "configs/tests/mailbox_parity_bench.json",
            "configs/tests/mailbox_parity_caller.json"
        )
    }
    Write-Host "[mailbox-parity] all cases passed"
}
finally {
    Pop-Location
}

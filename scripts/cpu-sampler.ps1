param(
    [Parameter(Mandatory = $true)]
    [int]$RootPid,
    [int]$IntervalMs = 1000
)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-Result([object]$Value) {
    $json = ConvertTo-Json -InputObject $Value -Compress -Depth 4
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Get-ProcessTreeIds([int]$Root) {
    $ids = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$ids.Add($Root)

    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction SilentlyContinue)
    $changed = $true
    $guard = 0
    while ($changed -and $guard -lt 20) {
        $guard++
        $changed = $false
        foreach ($process in $all) {
            $childId = [int]$process.ProcessId
            $parentId = [int]$process.ParentProcessId
            if ($childId -eq 0) { continue }
            if ($ids.Contains($parentId) -and -not $ids.Contains($childId)) {
                [void]$ids.Add($childId)
                $changed = $true
            }
        }
    }
    return @($ids)
}

$treeIds = @($RootPid)
$iteration = 0

while ($true) {
    $rootProcess = Get-Process -Id $RootPid -ErrorAction SilentlyContinue
    if ($null -eq $rootProcess) {
        Write-Result @{
            rootPid    = $RootPid
            cpuSeconds = 0
            processes  = 0
            alive      = $false
            at         = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
        break
    }

    if ($iteration -gt 0 -and ($iteration % 5) -eq 0) {
        $treeIds = Get-ProcessTreeIds $RootPid
    }

    $totalCpu = 0.0
    $aliveProcesses = 0
    foreach ($processIdValue in $treeIds) {
        $child = Get-Process -Id $processIdValue -ErrorAction SilentlyContinue
        if ($null -ne $child) {
            try {
                $totalCpu += $child.TotalProcessorTime.TotalSeconds
                $aliveProcesses++
            } catch {
            }
        }
    }

    Write-Result @{
        rootPid    = $RootPid
        cpuSeconds = [Math]::Round($totalCpu, 3)
        processes  = $aliveProcesses
        alive      = $true
        at         = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }

    $iteration++
    [System.Threading.Thread]::Sleep($IntervalMs)
}

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('get-foreground', 'minimize', 'restore', 'focus', 'find', 'open-url')]
    [string]$Action,
    [string]$Handle = '',
    [string]$Title = '',
    [string]$ProcessName = '',
    [string]$Url = '',
    [ValidateSet('auto', 'edge', 'chrome', 'brave', 'firefox', 'default')]
    [string]$Browser = 'auto'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class DSDoomWin32
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    public static List<IntPtr> Windows()
    {
        var list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }

    public static string Title(IntPtr h)
    {
        int length = GetWindowTextLength(h);
        if (length <= 0) return string.Empty;
        var builder = new StringBuilder(length + 1);
        GetWindowText(h, builder, builder.Capacity);
        return builder.ToString();
    }

    public static uint ProcessId(IntPtr h)
    {
        uint processId;
        GetWindowThreadProcessId(h, out processId);
        return processId;
    }

    public static bool Focus(IntPtr h, bool altTap)
    {
        if (h == IntPtr.Zero || !IsWindow(h)) return false;
        if (IsIconic(h)) ShowWindow(h, 9);

        IntPtr foreground = GetForegroundWindow();
        uint foregroundPid;
        uint foregroundThread = GetWindowThreadProcessId(foreground, out foregroundPid);
        uint currentThread = GetCurrentThreadId();
        bool attached = false;
        if (foregroundThread != 0 && foregroundThread != currentThread)
        {
            attached = AttachThreadInput(currentThread, foregroundThread, true);
        }

        if (altTap)
        {
            // Windows refuses SetForegroundWindow unless the calling process owns
            // the foreground lock. A synthetic Alt tap releases that lock.
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            System.Threading.Thread.Sleep(45);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
        }

        BringWindowToTop(h);
        bool focused = SetForegroundWindow(h);

        if (attached)
        {
            AttachThreadInput(currentThread, foregroundThread, false);
        }
        return focused;
    }
}
'@

function Write-Result([object]$Value) {
    $json = ConvertTo-Json -InputObject $Value -Compress -Depth 6
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Get-WindowInfo([IntPtr]$WindowHandle) {
    $processIdValue = [DSDoomWin32]::ProcessId($WindowHandle)
    $processNameValue = ''
    if ($processIdValue -ne 0) {
        try {
            $processNameValue = (Get-Process -Id ([int]$processIdValue) -ErrorAction Stop).ProcessName
        } catch {
        }
    }
    [PSCustomObject]@{
        id          = $WindowHandle.ToInt64().ToString([System.Globalization.CultureInfo]::InvariantCulture)
        title       = [DSDoomWin32]::Title($WindowHandle)
        processName = $processNameValue
        pid         = [int]$processIdValue
    }
}

function Test-UsableWindow([IntPtr]$WindowHandle) {
    if ($WindowHandle -eq [IntPtr]::Zero) { return $false }
    if (-not [DSDoomWin32]::IsWindowVisible($WindowHandle)) { return $false }
    return $true
}

function Get-MatchingWindows {
    $wantedProcess = $ProcessName.Trim().ToLowerInvariant()
    if ($wantedProcess.EndsWith('.exe')) {
        $wantedProcess = $wantedProcess.Substring(0, $wantedProcess.Length - 4)
    }
    $wantedTitle = $Title.Trim().ToLowerInvariant()

    $result = New-Object System.Collections.ArrayList
    if ($wantedProcess -eq '' -and $wantedTitle -eq '') {
        return @($result)
    }

    foreach ($windowHandle in [DSDoomWin32]::Windows()) {
        if (-not (Test-UsableWindow $windowHandle)) { continue }
        $info = Get-WindowInfo $windowHandle
        if ($info.pid -eq 0) { continue }
        if ([string]::IsNullOrWhiteSpace($info.title)) { continue }
        if ($wantedProcess -ne '' -and $info.processName.ToLowerInvariant() -ne $wantedProcess) { continue }
        if ($wantedTitle -ne '' -and -not $info.title.ToLowerInvariant().Contains($wantedTitle)) { continue }
        [void]$result.Add($info)
    }
    return @($result)
}

function Resolve-BrowserExe([string]$Choice) {
    $programFiles = [Environment]::GetFolderPath('ProgramFiles')
    $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($programFilesX86)) { $programFilesX86 = ${env:ProgramFiles(x86)} }

    $candidates = @()
    switch ($Choice) {
        'edge' {
            $candidates = @(
                (Join-Path $programFilesX86 'Microsoft\Edge\Application\msedge.exe'),
                (Join-Path $programFiles 'Microsoft\Edge\Application\msedge.exe')
            )
        }
        'chrome' {
            $candidates = @(
                (Join-Path $programFiles 'Google\Chrome\Application\chrome.exe'),
                (Join-Path $programFilesX86 'Google\Chrome\Application\chrome.exe'),
                (Join-Path $localAppData 'Google\Chrome\Application\chrome.exe')
            )
        }
        'brave' {
            $candidates = @(
                (Join-Path $programFiles 'BraveSoftware\Brave-Browser\Application\brave.exe'),
                (Join-Path $programFilesX86 'BraveSoftware\Brave-Browser\Application\brave.exe'),
                (Join-Path $localAppData 'BraveSoftware\Brave-Browser\Application\brave.exe')
            )
        }
        'firefox' {
            $candidates = @(
                (Join-Path $programFiles 'Mozilla Firefox\firefox.exe'),
                (Join-Path $programFilesX86 'Mozilla Firefox\firefox.exe')
            )
        }
    }

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

function Get-DefaultBrowserKey {
    try {
        $choice = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -ErrorAction Stop
        $progId = [string]$choice.ProgId
        if ($progId -match 'ChromeHTML') { return 'chrome' }
        if ($progId -match 'MSEdge') { return 'edge' }
        if ($progId -match 'Brave') { return 'brave' }
        if ($progId -match 'Firefox') { return 'firefox' }
    } catch {
    }
    return $null
}

function Get-BrowserWindowIds([string[]]$ProcessNames) {
    $ids = @{}
    foreach ($windowHandle in [DSDoomWin32]::Windows()) {
        if (-not (Test-UsableWindow $windowHandle)) { continue }
        $info = Get-WindowInfo $windowHandle
        if ($info.pid -eq 0) { continue }
        if ($ProcessNames -contains $info.processName.ToLowerInvariant()) {
            $ids[$info.id] = $true
        }
    }
    return $ids
}

function Invoke-OpenUrl {
    $knownBrowsers = @('msedge', 'chrome', 'brave', 'firefox', 'opera', 'vivaldi', 'arc', 'iexplore')
    $resolvedChoice = $Browser
    if ($resolvedChoice -eq 'auto') {
        $resolvedChoice = Get-DefaultBrowserKey
        if (-not $resolvedChoice) { $resolvedChoice = 'edge' }
    }

    $exe = $null
    if ($resolvedChoice -ne 'default') {
        $exe = Resolve-BrowserExe $resolvedChoice
        if (-not $exe) {
            $fallback = Resolve-BrowserExe 'edge'
            if (-not $fallback) { $fallback = Resolve-BrowserExe 'chrome' }
            $exe = $fallback
        }
    }

    $expectedProcess = $null
    if ($exe) {
        $expectedProcess = [System.IO.Path]::GetFileNameWithoutExtension($exe).ToLowerInvariant()
        if (-not $knownBrowsers.Contains($expectedProcess)) {
            $knownBrowsers += $expectedProcess
        }
    }

    $before = Get-BrowserWindowIds $knownBrowsers

    if ($exe) {
        if ($expectedProcess -eq 'firefox') {
            Start-Process -FilePath $exe -ArgumentList @('-new-window', $Url) | Out-Null
        } else {
            Start-Process -FilePath $exe -ArgumentList @('--new-window', $Url) | Out-Null
        }
    } else {
        Start-Process $Url | Out-Null
    }

    $deadline = (Get-Date).AddSeconds(8)
    $found = $null
    $candidate = $null
    $candidateId = ''
    # Require the same window on two consecutive polls. A freshly launched
    # browser can expose a transient top-level window that it destroys moments
    # later; returning that handle makes the later minimize fail with
    # "invalid window handle".
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 150
        $current = $null
        foreach ($windowHandle in [DSDoomWin32]::Windows()) {
            if (-not (Test-UsableWindow $windowHandle)) { continue }
            $info = Get-WindowInfo $windowHandle
            if ($info.pid -eq 0) { continue }
            if ($before.ContainsKey($info.id)) { continue }
            $processNameValue = $info.processName.ToLowerInvariant()
            if ($expectedProcess) {
                if ($processNameValue -ne $expectedProcess) { continue }
            } elseif (-not $knownBrowsers.Contains($processNameValue)) {
                continue
            }
            if ([string]::IsNullOrWhiteSpace($info.title)) { continue }
            $current = $info
            break
        }

        if ($null -eq $current) {
            $candidate = $null
            $candidateId = ''
            continue
        }
        if ($candidateId -eq $current.id) {
            $found = $current
            break
        }
        $candidate = $current
        $candidateId = $current.id
    }

    # Stable window preferred; fall back to the last candidate so a browser
    # that keeps swapping windows does not abort the session entirely.
    if (-not $found -and $candidate) { $found = $candidate }

    return $found
}

try {
    switch ($Action) {
        'get-foreground' {
            $windowHandle = [DSDoomWin32]::GetForegroundWindow()
            if (-not (Test-UsableWindow $windowHandle)) {
                Write-Result @{ ok = $false; error = 'no foreground window' }
            } else {
                Write-Result @{ ok = $true; window = (Get-WindowInfo $windowHandle) }
            }
        }
        'find' {
            Write-Result @{ ok = $true; windows = @(Get-MatchingWindows) }
        }
        'minimize' {
            $windowHandle = [IntPtr]([Int64]$Handle)
            if (-not [DSDoomWin32]::IsWindow($windowHandle)) {
                Write-Result @{ ok = $false; error = 'invalid window handle' }
            } else {
                [void][DSDoomWin32]::ShowWindow($windowHandle, 6)
                Write-Result @{ ok = $true }
            }
        }
        'restore' {
            $windowHandle = [IntPtr]([Int64]$Handle)
            if (-not [DSDoomWin32]::IsWindow($windowHandle)) {
                Write-Result @{ ok = $false; error = 'invalid window handle' }
            } else {
                [void][DSDoomWin32]::ShowWindow($windowHandle, 9)
                Write-Result @{ ok = $true }
            }
        }
        'focus' {
            $windowHandle = [IntPtr]([Int64]$Handle)
            if (-not [DSDoomWin32]::IsWindow($windowHandle)) {
                Write-Result @{ ok = $false; error = 'invalid window handle' }
            } else {
                $focused = [DSDoomWin32]::Focus($windowHandle, $true)
                if (-not $focused) {
                    Start-Sleep -Milliseconds 120
                    $focused = [DSDoomWin32]::Focus($windowHandle, $true)
                }
                Write-Result @{ ok = $true; focused = $focused }
            }
        }
        'open-url' {
            $windowInfo = Invoke-OpenUrl
            if ($windowInfo) {
                Write-Result @{ ok = $true; window = $windowInfo }
            } else {
                Write-Result @{ ok = $false; error = 'browser window was not detected' }
            }
        }
        default {
            Write-Result @{ ok = $false; error = "unknown action: $Action" }
        }
    }
} catch {
    Write-Result @{ ok = $false; error = $_.Exception.Message }
    exit 0
}

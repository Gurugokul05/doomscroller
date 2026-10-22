param(
    [int]$ParentPid = 0,
    [string]$HotkeyKey = 'D',
    [int]$IntervalMs = 15
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class DSDoomKeys
{
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

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
}
'@

$specialKeys = @{
    'ENTER'     = 0x0D
    'SPACE'     = 0x20
    'TAB'       = 0x09
    'ESC'       = 0x1B
    'BACKSPACE' = 0x08
}
for ($index = 0; $index -lt 26; $index++) {
    $specialKeys[[string][char](65 + $index)] = 65 + $index
}
for ($index = 0; $index -lt 10; $index++) {
    $specialKeys[[string][char](48 + $index)] = 48 + $index
}
for ($index = 1; $index -le 12; $index++) {
    $specialKeys["F$index"] = 111 + $index
}

$requested = ([string]$HotkeyKey).Trim().ToUpperInvariant()
if ($requested.StartsWith('VK_')) { $requested = $requested.Substring(3) }
if (-not $specialKeys.ContainsKey($requested)) { $requested = 'D' }

$watch = @{ 'ENTER' = 0x0D }
if (-not $watch.ContainsKey($requested)) { $watch[$requested] = $specialKeys[$requested] }

function Write-Result([object]$Value) {
    $json = ConvertTo-Json -InputObject $Value -Compress -Depth 4
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

Write-Result @{ type = 'ready'; keys = @($watch.Keys) }

$down = @{}
$iteration = 0

while ($true) {
    foreach ($keyName in @($watch.Keys)) {
        $virtualKey = $watch[$keyName]
        $isDown = (([DSDoomKeys]::GetAsyncKeyState($virtualKey)) -band 0x8000) -ne 0

        if ($isDown -and -not $down.ContainsKey($keyName)) {
            $down[$keyName] = $true

            $ctrl = (([DSDoomKeys]::GetAsyncKeyState(0x11)) -band 0x8000) -ne 0
            $alt = (([DSDoomKeys]::GetAsyncKeyState(0x12)) -band 0x8000) -ne 0
            $shift = (([DSDoomKeys]::GetAsyncKeyState(0x10)) -band 0x8000) -ne 0

            $windowHandle = [DSDoomKeys]::GetForegroundWindow()
            $windowTitle = ''
            $processNameValue = ''
            $processIdValue = 0

            if ($windowHandle -ne [IntPtr]::Zero) {
                $windowTitle = [DSDoomKeys]::Title($windowHandle)
                $processIdValue = [int][DSDoomKeys]::ProcessId($windowHandle)
                if ($processIdValue -ne 0) {
                    try {
                        $processNameValue = (Get-Process -Id $processIdValue -ErrorAction Stop).ProcessName
                    } catch {
                    }
                }
            }

            Write-Result @{
                type    = 'key'
                key     = $keyName
                ctrl    = $ctrl
                alt     = $alt
                shift   = $shift
                hwnd    = $windowHandle.ToInt64().ToString([System.Globalization.CultureInfo]::InvariantCulture)
                title   = $windowTitle
                process = $processNameValue
                pid     = $processIdValue
                at      = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            }
        } elseif (-not $isDown -and $down.ContainsKey($keyName)) {
            $down.Remove($keyName)
        }
    }

    $iteration++
    if ($ParentPid -gt 0 -and ($iteration % 100 -eq 0)) {
        try {
            $null = Get-Process -Id $ParentPid -ErrorAction Stop
        } catch {
            break
        }
    }

    [System.Threading.Thread]::Sleep($IntervalMs)
}

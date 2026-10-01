# dsh-serial-debugger — persistent serial bridge over stdio.
#
# Runs on Windows PowerShell 5.1+ / .NET Framework, where System.IO.Ports ships
# in the box. This avoids any native Node addon: the DSH host half spawns one of
# these per plugin instance and talks newline-delimited JSON in both directions.
#
#   stdin   commands: {"op":"open"|"close"|"write"|"list"|"ping"|"shutdown", ...}
#   stdout    events: {"type":"ready"|"ports"|"opened"|"closed"|"data"|"error"|"pong", ...}
#
# A single runspace polls both streams in one loop: the stdin Task is waited on
# with a short timeout (never blocking) and the serial input buffer is drained on
# every pass. No threads, no runspaces, no PowerShell eventing.

$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true

$script:serial = $null

function Write-Event {
    param([hashtable]$Payload)
    try {
        $stdout.WriteLine((ConvertTo-Json -InputObject $Payload -Compress -Depth 8))
    } catch {
        # Never let a reporting failure take the bridge down.
    }
}

function Write-RawEvent {
    param([string]$Json)
    try {
        $stdout.WriteLine($Json)
    } catch {
        # Never let a reporting failure take the bridge down.
    }
}

function Write-BridgeError {
    param([string]$Message, [string]$Op)
    Write-Event @{ type = 'error'; op = $Op; message = $Message }
}

# ConvertTo-Json collapses an empty array to `{}` and a one-element array to a
# bare scalar, so a list must be serialized explicitly to stay a JSON array in
# every case. Note `@($null).Count` is 1 in Windows PowerShell, so the null case
# needs its own guard or an empty list serializes as `[null]`.
function ConvertTo-JsonArrayOf {
    param($Items)
    if ($null -eq $Items) { return '[]' }
    $list = @($Items)
    if ($list.Count -eq 0) { return '[]' }
    $json = ConvertTo-Json -InputObject $list -Compress -Depth 4
    if ($json.TrimStart().StartsWith('[')) { return $json }
    return "[$json]"
}

function Write-PortsEvent {
    param([string]$Type)
    Write-RawEvent ('{"type":"' + $Type + '","ports":' + (ConvertTo-JsonArrayOf -Items (Get-AvailablePorts)) + '}')
}

# Friendly device names keyed by port, from the PnP device tree. `GetPortNames()`
# alone yields bare "COM3", while the device a reader is looking for is named by
# its adapter ("USB-SERIAL CH340"), which matters as soon as two adapters are
# attached. Best effort: a host without the CIM cmdlets still lists the ports.
function Get-PortDescriptions {
    $map = @{}
    try {
        # The `-match` and its `$Matches` read must sit in ONE script block:
        # `$Matches` is set in the scope that ran the match, so splitting the
        # filter and the extraction across Where-Object/ForEach-Object loses it.
        Get-CimInstance -ClassName Win32_PnPEntity -ErrorAction Stop |
            ForEach-Object {
                if ($_.Name -match '\((COM\d+)\)') {
                    $port = $Matches[1]
                    $label = ($_.Name -replace '\s*\(COM\d+\)\s*$', '').Trim()
                    if ($label.Length -gt 0) { $map[$port] = $label }
                }
            }
    } catch {
        # No CIM available: descriptions stay empty.
    }
    return $map
}

function Get-AvailablePorts {
    $names = @()
    try {
        $names = @([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object)
    } catch {
        return @()
    }
    if ($names.Count -eq 0) { return @() }
    $descriptions = Get-PortDescriptions
    $ports = @()
    foreach ($name in $names) {
        $description = ''
        if ($descriptions.ContainsKey($name)) { $description = [string]$descriptions[$name] }
        $ports += [pscustomobject]@{ name = $name; description = $description }
    }
    return $ports
}

function Close-SerialPort {
    if ($null -eq $script:serial) { return }
    try { if ($script:serial.IsOpen) { $script:serial.Close() } } catch { }
    try { $script:serial.Dispose() } catch { }
    $script:serial = $null
}

function Open-SerialPort {
    param($Command)

    Close-SerialPort

    $name = [string]$Command.port
    if ([string]::IsNullOrWhiteSpace($name)) {
        Write-BridgeError -Op 'open' -Message 'no port name supplied'
        return
    }

    $baud = 115200
    if ($null -ne $Command.baudRate) { $baud = [int]$Command.baudRate }

    $dataBits = 8
    if ($null -ne $Command.dataBits) { $dataBits = [int]$Command.dataBits }

    $parityName = 'None'
    if ($null -ne $Command.parity -and "$($Command.parity)" -ne '') { $parityName = [string]$Command.parity }

    $stopBitsName = 'One'
    if ($null -ne $Command.stopBits -and "$($Command.stopBits)" -ne '') { $stopBitsName = [string]$Command.stopBits }

    $handshakeName = 'None'
    if ($null -ne $Command.handshake -and "$($Command.handshake)" -ne '') { $handshakeName = [string]$Command.handshake }

    try {
        $parity = [System.Enum]::Parse([System.IO.Ports.Parity], $parityName, $true)
        $stopBits = [System.Enum]::Parse([System.IO.Ports.StopBits], $stopBitsName, $true)
        $handshake = [System.Enum]::Parse([System.IO.Ports.Handshake], $handshakeName, $true)

        $port = New-Object System.IO.Ports.SerialPort
        $port.PortName = $name
        $port.BaudRate = $baud
        $port.DataBits = $dataBits
        $port.Parity = $parity
        $port.StopBits = $stopBits
        $port.Handshake = $handshake
        $port.ReadTimeout = 500
        $port.WriteTimeout = 3000
        # Keep the modem lines asserted by default so devices that need DTR/RTS
        # (most USB-UART bridges) are usable without extra configuration.
        if ($null -ne $Command.dtr) { $port.DtrEnable = [bool]$Command.dtr } else { $port.DtrEnable = $true }
        if ($null -ne $Command.rts) { $port.RtsEnable = [bool]$Command.rts } else { $port.RtsEnable = $true }

        $port.Open()
        $script:serial = $port

        Write-Event @{
            type      = 'opened'
            port      = $name
            baudRate  = $baud
            dataBits  = $dataBits
            parity    = "$parity"
            stopBits  = "$stopBits"
            handshake = "$handshake"
        }
    } catch {
        $script:serial = $null
        Write-BridgeError -Op 'open' -Message $_.Exception.Message
    }
}

function Write-SerialBytes {
    param($Command)

    if ($null -eq $script:serial -or -not $script:serial.IsOpen) {
        Write-BridgeError -Op 'write' -Message 'the port is not open'
        return
    }

    $payload = [string]$Command.base64
    if ([string]::IsNullOrEmpty($payload)) {
        Write-BridgeError -Op 'write' -Message 'no payload supplied'
        return
    }

    try {
        $bytes = [Convert]::FromBase64String($payload)
        $script:serial.Write($bytes, 0, $bytes.Length)
        Write-Event @{ type = 'written'; count = $bytes.Length }
    } catch {
        Write-BridgeError -Op 'write' -Message $_.Exception.Message
    }
}

function Invoke-BridgeCommand {
    param([string]$Line)

    $command = $null
    try {
        $command = ConvertFrom-Json -InputObject $Line
    } catch {
        Write-BridgeError -Op 'parse' -Message "invalid JSON: $($_.Exception.Message)"
        return $true
    }

    if ($null -eq $command -or $null -eq $command.op) {
        Write-BridgeError -Op 'parse' -Message 'command has no "op" field'
        return $true
    }

    switch ([string]$command.op) {
        'open'     { Open-SerialPort -Command $command }
        'write'    { Write-SerialBytes -Command $command }
        'close'    { Close-SerialPort; Write-Event @{ type = 'closed' } }
        'list'     { Write-PortsEvent -Type 'ports' }
        'ping'     { Write-Event @{ type = 'pong' } }
        'shutdown' { return $false }
        default    { Write-BridgeError -Op ([string]$command.op) -Message "unknown op: $($command.op)" }
    }
    return $true
}

# ── main loop ────────────────────────────────────────────────────────────────

$stdinStream = [Console]::OpenStandardInput()
$buffer = New-Object byte[] 16384
$pending = $null
$carry = ''

Write-RawEvent ('{"type":"ready","pid":' + $PID + ',"ports":' + (ConvertTo-JsonArrayOf -Items (Get-AvailablePorts)) + '}')

$running = $true
while ($running) {
    try {
        if ($null -eq $pending) {
            $pending = $stdinStream.ReadAsync($buffer, 0, $buffer.Length)
        }

        if ($pending.Wait(15)) {
            $count = $pending.Result
            $pending = $null
            if ($count -le 0) { break }  # stdin closed: the host is gone.
            $carry += $utf8.GetString($buffer, 0, $count)
            while ($true) {
                $index = $carry.IndexOf("`n")
                if ($index -lt 0) { break }
                $line = $carry.Substring(0, $index).Trim()
                $carry = $carry.Substring($index + 1)
                if ($line.Length -gt 0) {
                    if (-not (Invoke-BridgeCommand -Line $line)) { $running = $false; break }
                }
            }
        }

        if ($null -ne $script:serial -and $script:serial.IsOpen) {
            $available = $script:serial.BytesToRead
            if ($available -gt 0) {
                $chunk = New-Object byte[] $available
                $read = $script:serial.Read($chunk, 0, $available)
                if ($read -gt 0) {
                    Write-Event @{
                        type   = 'data'
                        base64 = [Convert]::ToBase64String($chunk, 0, $read)
                        at     = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                    }
                }
            }
        }
    } catch {
        Write-BridgeError -Op 'loop' -Message $_.Exception.Message
        Start-Sleep -Milliseconds 50
    }
}

Close-SerialPort
Write-Event @{ type = 'bye' }
try { $stdout.Flush() } catch { }

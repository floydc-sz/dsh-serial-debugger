# Test double for lib/serial-helper.ps1.
#
# Speaks the identical NDJSON protocol but needs no hardware: it enumerates two
# synthetic ports, greets a newly opened port with a fixed banner, and echoes
# every written payload back as received data. That lets the no-hardware tests
# exercise the whole data path (encoding, log, incremental reads, TX echo)
# without a COM port. Selected through DSH_SERIAL_HELPER.

$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true

$script:open = $false
# Banner payloads are BASE64 (the wire field is `base64`, not hex):
#   'qlUBAg==' decodes to AA 55 01 02
#   'SGVsbG8K' decodes to "Hello\n"
$script:banner = @(
    'qlUBAg==',
    'SGVsbG8K'
)

function Write-Event {
    param([hashtable]$Payload)
    $stdout.WriteLine((ConvertTo-Json -InputObject $Payload -Compress -Depth 8))
}

function Write-Ports {
    # Same shape as the real bridge: one `{ name, description }` record per port.
    $stdout.WriteLine('{"type":"ports","ports":[{"name":"COMFAKE1","description":"Loopback A"},{"name":"COMFAKE2","description":"Loopback B"}]}')
}

function Write-Data {
    param([string]$Base64)
    Write-Event @{ type = 'data'; base64 = $Base64; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
}

$stdinStream = [Console]::OpenStandardInput()
$buffer = New-Object byte[] 16384
$pending = $null
$carry = ''

$stdout.WriteLine('{"type":"ready","pid":' + $PID + ',"ports":[{"name":"COMFAKE1","description":"Loopback A"},{"name":"COMFAKE2","description":"Loopback B"}]}')

$running = $true
while ($running) {
    if ($null -eq $pending) { $pending = $stdinStream.ReadAsync($buffer, 0, $buffer.Length) }

    if ($pending.Wait(15)) {
        $count = $pending.Result
        $pending = $null
        if ($count -le 0) { break }
        $carry += $utf8.GetString($buffer, 0, $count)
        while ($true) {
            $index = $carry.IndexOf("`n")
            if ($index -lt 0) { break }
            $line = $carry.Substring(0, $index).Trim()
            $carry = $carry.Substring($index + 1)
            if ($line -eq '') { continue }

            try { $command = ConvertFrom-Json -InputObject $line }
            catch { Write-Event @{ type = 'error'; op = 'parse'; message = 'invalid JSON' }; continue }

            switch ([string]$command.op) {
                'list' { Write-Ports }
                'ping' { Write-Event @{ type = 'pong' } }
                'open' {
                    $script:open = $true
                    Write-Event @{
                        type = 'opened'; port = [string]$command.port; baudRate = [int]$command.baudRate
                        dataBits = [int]$command.dataBits; parity = [string]$command.parity
                        stopBits = [string]$command.stopBits; handshake = [string]$command.handshake
                    }
                    # Greet the newly opened port with the fixed banner, split across
                    # two events to mimic real chunked arrival.
                    foreach ($payload in $script:banner) { Write-Data -Base64 $payload }
                }
                'write' {
                    if (-not $script:open) { Write-Event @{ type = 'error'; op = 'write'; message = 'the port is not open' }; continue }
                    $bytes = [Convert]::FromBase64String([string]$command.base64)
                    Write-Event @{ type = 'written'; count = $bytes.Length }
                    # Loopback device: what was written comes straight back as RX.
                    Write-Data -Base64 ([string]$command.base64)
                }
                'close' { $script:open = $false; Write-Event @{ type = 'closed' } }
                'shutdown' { $running = $false }
                default { Write-Event @{ type = 'error'; op = [string]$command.op; message = 'unknown op' } }
            }
        }
    }
}

Write-Event @{ type = 'bye' }
try { $stdout.Flush() } catch { }

<#
Gedara print server (Phase 7g) - run on this PC, in the VS Code terminal, from the gedara-handoff folder:

    powershell -ExecutionPolicy Bypass -File devices/print-server/install.ps1

It (1) finds the Raspberry Pi, (2) gives this PC its own SSH key for the Pi (you type the Pi password
once, into the SSH prompt; the key is made here and never shown), (3) copies setup.sh + status.sh to
the Pi and runs setup.sh (printing software, queues, firewall, updates), (4) adds the printer
"EPSON L3110 (Gedara Pi)" to Windows with the Epson driver you already have, through a Standard
TCP/IP port to the Pi (port 9100), and (5) prints test pages. Run it again any time to update the Pi.

    -Status                 show the Pi's status screen (status.sh)
    -RemoveWindowsPrinter   take "EPSON L3110 (Gedara Pi)" off this PC again
    -Reflashed              the Pi's SD card was written again (forget its old identity)
    -PiHost <name|IP>       if the Pi isn't called gedara-print
Nothing secret is stored in the repo or printed. The SSH key lives in %USERPROFILE%\.ssh\gedara_print_ed25519.
#>
param(
  [string]$PiHost = '',
  [string]$User = '',
  [switch]$Status,
  [switch]$RemoveWindowsPrinter,
  [switch]$Reflashed,
  # Used when the script restarts itself as administrator for the Windows printer part.
  [switch]$WindowsPrinterOnly,
  [string]$PiIp = ''
)
$ErrorActionPreference = 'Stop'

$PrinterName = 'EPSON L3110 (Gedara Pi)'
$PortPrefix = 'GedaraPi_'
$SshDir = Join-Path $env:USERPROFILE '.ssh'
$Key = Join-Path $SshDir 'gedara_print_ed25519'
$KnownHosts = Join-Path $SshDir 'gedara_print_known_hosts'
$Saved = Join-Path $SshDir 'gedara_print.json'   # user name, host name, IP - nothing secret

function Step([string]$t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Ok([string]$t) { Write-Host "   OK  $t" -ForegroundColor Green }
function Note([string]$t) { Write-Host "   $t" -ForegroundColor Yellow }
function Fail([string]$t) {
  Write-Host ''
  Write-Host "PROBLEM: $t" -ForegroundColor Red
  if ($WindowsPrinterOnly) { Read-Host 'Press Enter to close this window' | Out-Null }
  exit 1
}
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ── Windows printer (needs administrator) ─────────────────────────────────────
function Remove-GedaraPrinter {
  if (Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue) { Remove-Printer -Name $PrinterName }
  Start-Sleep -Seconds 2
  Get-PrinterPort | Where-Object { $_.Name -like "$PortPrefix*" } | ForEach-Object {
    try { Remove-PrinterPort -Name $_.Name } catch { Note "port $($_.Name) is still in use; Windows removes it after a restart" }
  }
}

function Add-GedaraPrinter([string]$ip) {
  $driver = Get-PrinterDriver | Where-Object { $_.Name -like '*L3110*' } | Select-Object -First 1
  if (-not $driver) {
    Fail "the Epson L3110 driver isn't on this PC. Install it from epson.com (L3110 > Drivers), then run this again."
  }
  Remove-GedaraPrinter
  $port = "$PortPrefix$ip"
  Add-PrinterPort -Name $port -PrinterHostAddress $ip -PortNumber 9100
  Add-Printer -Name $PrinterName -DriverName $driver.Name -PortName $port
  Ok "added '$PrinterName' (driver: $($driver.Name), port: $ip`:9100)"
  try {
    Get-CimInstance Win32_Printer -Filter "Name='$PrinterName'" | Invoke-CimMethod -MethodName SetDefaultPrinter | Out-Null
    Ok 'it is now the default printer'
  } catch { Note 'could not make it the default printer (Settings > Printers & scanners)' }
}

if ($WindowsPrinterOnly) {
  Step 'Windows printer'
  if ($RemoveWindowsPrinter) { Remove-GedaraPrinter; Ok "removed '$PrinterName'" }
  else { Add-GedaraPrinter $PiIp }
  Read-Host 'Done. Press Enter to close this window' | Out-Null
  exit 0
}

function Invoke-AsAdmin([string]$extra) {
  if (Test-Admin) { return $true }
  Note 'Windows asks for permission to add a printer: click Yes.'
  $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -WindowsPrinterOnly $extra"
  $p = Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait -PassThru
  return ($p.ExitCode -eq 0)
}

if ($RemoveWindowsPrinter) {
  if (Test-Admin) { Remove-GedaraPrinter; Ok "removed '$PrinterName'" }
  elseif (-not (Invoke-AsAdmin '-RemoveWindowsPrinter')) { Fail 'the printer was not removed' }
  exit 0
}

# ── The Pi ────────────────────────────────────────────────────────────────────
foreach ($tool in 'ssh', 'scp', 'ssh-keygen') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Fail "$tool is missing. Windows Settings > Apps > Optional features > Add a feature > 'OpenSSH Client' > Install, then run this again."
  }
}
New-Item -ItemType Directory -Force $SshDir | Out-Null

$cfg = $null
if (Test-Path $Saved) { $cfg = Get-Content $Saved -Raw | ConvertFrom-Json }
if (-not $PiHost) { if ($cfg) { $PiHost = $cfg.host } else { $PiHost = 'gedara-print.local' } }
if (-not $User) {
  if ($cfg) { $User = $cfg.user }
  else { $User = (Read-Host 'Your user name on the Pi (the one you typed in Raspberry Pi Imager)').Trim() }
}
if (-not $User) { Fail 'no user name given' }
$firstRun = -not $cfg

if ($Reflashed -and (Test-Path $KnownHosts)) { Remove-Item $KnownHosts; Ok "forgot the Pi's old identity" }

Step "1/5 Finding the Pi ($PiHost)"
$ip = $null
if ($PiHost -match '^\d+\.\d+\.\d+\.\d+$') { $ip = $PiHost }
else {
  try { $ip = ([System.Net.Dns]::GetHostAddresses($PiHost) | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | Select-Object -First 1).IPAddressToString } catch { $ip = $null }
  if (-not $ip -and $cfg -and $cfg.ip) { $ip = $cfg.ip; Note "the name didn't answer; trying the last address $ip" }
}
if (-not $ip) {
  Note "This PC can't find '$PiHost' by name. Open your router's page, find the device called gedara-print, and type its address."
  $ip = (Read-Host 'The Pi''s IP address (e.g. 192.168.1.50)').Trim()
}
if (-not ($ip -match '^\d+\.\d+\.\d+\.\d+$')) { Fail "'$ip' is not an IP address" }
if (-not (Test-Connection -ComputerName $ip -Count 2 -Quiet)) { Fail "the Pi at $ip doesn't answer. Is it powered, and on the network cable / Wi-Fi? Wait 3 minutes after power-on." }
Ok "the Pi answers at $ip"

# The Pi's identity is remembered under the name "gedara-print", not under its IP: if the address
# changes, ssh still checks it is the same Pi and refuses another device (-Reflashed forgets it).
$sshOpts = @('-o', "UserKnownHostsFile=$KnownHosts", '-o', 'HostKeyAlias=gedara-print', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10')
$sshKeyOpts = @('-i', $Key, '-o', 'IdentitiesOnly=yes') + $sshOpts
$target = "$User@$ip"

Step '2/5 This PC''s key for the Pi'
# Can this PC log in with its key alone? (Windows PowerShell 5.1 turns a hidden error stream into a
# script-stopping error while ErrorActionPreference is Stop, so relax it just for this probe.)
function Test-KeyLogin {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & ssh @sshKeyOpts -o BatchMode=yes $target 'true' 2>$null | Out-Null } finally { $ErrorActionPreference = $old }
  return $LASTEXITCODE
}
if (-not (Test-Path $Key)) {
  & ssh-keygen -q -t ed25519 -N '""' -C "gedara-print-from-$env:COMPUTERNAME" -f $Key
  if ($LASTEXITCODE -ne 0) { Fail 'ssh-keygen could not make the key' }
  Ok 'made a new key (kept in your .ssh folder, never shown)'
}
if ((Test-KeyLogin) -ne 0) {
  Note 'Type the Pi password you chose in Raspberry Pi Imager when asked (the letters stay invisible).'
  $pub = Get-Content "$Key.pub" -Raw
  $pub | & ssh @sshOpts $target "umask 077; mkdir -p ~/.ssh; tr -d '\r' > ~/.ssh/gedara.pub; grep -qxFf ~/.ssh/gedara.pub ~/.ssh/authorized_keys 2>/dev/null || cat ~/.ssh/gedara.pub >> ~/.ssh/authorized_keys"
  if ($LASTEXITCODE -ne 0) {
    Fail "could not log in as '$User' on the Pi. Wrong user name or password? If you wrote the SD card again, run with -Reflashed."
  }
  if ((Test-KeyLogin) -ne 0) { Fail 'the key was copied but the Pi still asks for a password' }
}
Ok 'this PC can reach the Pi without a password from now on'
@{ user = $User; host = $PiHost; ip = $ip } | ConvertTo-Json | Set-Content -Path $Saved -Encoding ascii

if ($Status) {
  & ssh @sshKeyOpts -t $target 'sudo bash /opt/gedara-print/status.sh'
  exit $LASTEXITCODE
}

Step '3/5 Copying the setup to the Pi'
$tmp = Join-Path $env:TEMP 'gedara-print'
New-Item -ItemType Directory -Force $tmp | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding $false
foreach ($f in 'setup.sh', 'status.sh') {
  $text = [IO.File]::ReadAllText((Join-Path $PSScriptRoot $f)) -replace "`r`n", "`n"
  [IO.File]::WriteAllText((Join-Path $tmp $f), $text, $utf8)
}
& scp @sshKeyOpts -q (Join-Path $tmp 'setup.sh') (Join-Path $tmp 'status.sh') "${target}:/tmp/"
if ($LASTEXITCODE -ne 0) { Fail 'copying to the Pi failed' }
Ok 'setup.sh and status.sh are on the Pi'

Step '4/5 Setting up the Pi (first time on a Pi 2: 10-20 minutes; it says when to move the USB cable)'
$testPage = '0'
if ($firstRun) { $testPage = '1' }
else {
  $answer = Read-Host 'Print a test page from the Pi at the end? (y/N)'
  if ($answer -match '^[yY]') { $testPage = '1' }
}
& ssh @sshKeyOpts -t $target "sudo install -d /opt/gedara-print && sudo install -m 755 /tmp/setup.sh /tmp/status.sh /opt/gedara-print/ && sudo TEST_PAGE=$testPage bash /opt/gedara-print/setup.sh"
if ($LASTEXITCODE -ne 0) {
  Note 'setup.sh reported a problem (see the lines above). Phones may not print yet; the PC printer is added anyway.'
}

Step '5/5 The printer on this PC'
if (Test-Admin) { Add-GedaraPrinter $ip }
elseif (-not (Invoke-AsAdmin "-PiIp $ip")) { Fail 'the Windows printer was not added (run this again and click Yes)' }

$answer = Read-Host "Print a Windows test page on '$PrinterName'? (Y/n)"
if ($answer -notmatch '^[nN]') {
  Get-CimInstance Win32_Printer -Filter "Name='$PrinterName'" | Invoke-CimMethod -MethodName PrintTestPage | Out-Null
  Ok 'Windows test page sent'
}

Write-Host ''
Write-Host "All done. On this PC choose '$PrinterName' in any Print window." -ForegroundColor Green
Write-Host "Phones and the iPad: 'Epson L3110 (Gedara)' appears in their Print screen."
Write-Host 'Tip: reserve the address' $ip 'for gedara-print in your router (docs/print-server/setup.md, Stage D).'

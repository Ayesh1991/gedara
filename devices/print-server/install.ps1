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
    -ThisPcOnly [-PiIp <IP>] another PC (e.g. the laptop): only add the printer there (this file alone is enough)
    -Music [-Server gedara-staging]  also set up the music speaker (Phase 7h, docs/media-player): MPD,
                            the agent, the "Gedara Music" folder; shows the 8-digit pairing code
    -MusicFolder            only the "Gedara Music" folder on this PC (e.g. the laptop; this file is enough)
Nothing secret is stored in the repo or printed. The SSH key lives in %USERPROFILE%\.ssh\gedara_print_ed25519.
#>
param(
  [string]$PiHost = '',
  [string]$User = '',
  [switch]$Status,
  [switch]$RemoveWindowsPrinter,
  [switch]$Reflashed,
  [switch]$ThisPcOnly,
  [switch]$Music,
  [switch]$MusicFolder,
  [ValidateSet('gedara', 'gedara-staging')]
  [string]$Server = 'gedara',
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
    Fail ("the Epson L3110 driver isn't on this PC. Install it from epson.com (L3110 > Drivers > Printer Driver); " +
          "if the installer insists on a USB connection, plug the printer into this PC just for the install, " +
          "then put the cable back on the Pi. Then run this again.")
  }
  Remove-GedaraPrinter
  $port = "$PortPrefix$ip"
  Add-PrinterPort -Name $port -PrinterHostAddress $ip -PortNumber 9100
  Add-Printer -Name $PrinterName -DriverName $driver.Name -PortName $port
  Ok "added '$PrinterName' (driver: $($driver.Name), port: $ip`:9100)"
  # Sri Lanka uses A4 (Gedara's label sheets too); the Epson driver starts on Letter.
  try { Set-PrintConfiguration -PrinterName $PrinterName -PaperSize A4; Ok 'paper size A4' }
  catch { Note 'could not set A4: Printing preferences > Document Size > A4' }
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

# Another PC (the laptop): the Pi is already set up, so only add the Windows printer. Needs just this
# one file and the Epson L3110 driver on that PC.
if ($ThisPcOnly) {
  if (-not $PiIp) {
    $name = $PiHost
    if (-not $name) { $name = 'gedara-print.local' }
    try { $PiIp = ([System.Net.Dns]::GetHostAddresses($name) | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | Select-Object -First 1).IPAddressToString } catch { $PiIp = '' }
    if ($PiIp) { Ok "found the Pi at $PiIp" }
    else { $PiIp = (Read-Host 'The Pi''s IP address (the one install.ps1 showed on the desktop, e.g. 192.168.1.50)').Trim() }
  }
  if (-not ($PiIp -match '^\d+\.\d+\.\d+\.\d+$')) { Fail "'$PiIp' is not an IP address" }
  Step 'The printer on this PC'
  if (Test-Admin) { Add-GedaraPrinter $PiIp }
  elseif (-not (Invoke-AsAdmin "-PiIp $PiIp")) { Fail 'the Windows printer was not added (run this again and click Yes)' }
  Write-Host ''
  Write-Host "Done. Choose '$PrinterName' in any Print window." -ForegroundColor Green
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

# The music folder's password is read from the Pi straight into Windows' Credential Manager: never
# shown, never typed. (cmdkey takes it as an argument for that moment on this PC only.)
function Add-MusicFolder([string]$ip) {
  Step 'The "Gedara Music" folder on this PC'
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $pw = (& ssh @sshKeyOpts -o BatchMode=yes $target 'sudo cat /etc/gedara-media/samba-password' 2>$null | Out-String).Trim() }
  finally { $ErrorActionPreference = $old }
  if (-not $pw) { Fail 'the Pi has no music folder yet: run install.ps1 -Music on the main PC first' }
  & cmdkey "/add:$ip" '/user:music' "/pass:$pw" | Out-Null
  $pw = $null
  $share = "\\$ip\Gedara Music"
  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Gedara Music.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $share
  $s.Description = 'Drop songs here: they appear in Gedara Music'
  $s.Save()
  Ok "the folder $share is ready, with a 'Gedara Music' shortcut on the desktop"
  Start-Process explorer.exe $share
}

if ($Status) {
  & ssh @sshKeyOpts -t $target 'sudo bash /opt/gedara-print/status.sh'
  exit $LASTEXITCODE
}

if ($MusicFolder) {
  Add-MusicFolder $ip
  exit 0
}

if ($Music) {
  Step 'Music 1/3 Copying the music speaker to the Pi'
  $musicDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'media-player'
  $tmp = Join-Path $env:TEMP 'gedara-media'
  New-Item -ItemType Directory -Force $tmp | Out-Null
  $utf8 = New-Object System.Text.UTF8Encoding $false
  foreach ($f in 'setup-media.sh', 'gedara_media_agent.py') {
    $text = [IO.File]::ReadAllText((Join-Path $musicDir $f)) -replace "`r`n", "`n"
    [IO.File]::WriteAllText((Join-Path $tmp $f), $text, $utf8)
  }
  & scp @sshKeyOpts -q (Join-Path $tmp 'setup-media.sh') (Join-Path $tmp 'gedara_media_agent.py') "${target}:/tmp/"
  if ($LASTEXITCODE -ne 0) { Fail 'copying to the Pi failed' }
  Ok 'setup-media.sh and the agent are on the Pi'

  Step "Music 2/3 Setting up the speaker (5-10 minutes; server: $Server)"
  & ssh @sshKeyOpts -t $target "sudo install -d /opt/gedara-media && sudo install -m 755 /tmp/setup-media.sh /tmp/gedara_media_agent.py /opt/gedara-media/ && sudo MEDIA_SERVER=$Server bash /opt/gedara-media/setup-media.sh"
  if ($LASTEXITCODE -ne 0) { Note 'setup-media.sh reported a problem (see the lines above).' }

  Step 'Music 3/3 Pairing with Gedara'
  Note 'In Gedara: Settings > Devices > Music speakers > Add speaker, then type the code below.'
  & ssh @sshKeyOpts -t $target 'sudo gedara-media pair && sudo chown gedara-media:gedara-media /etc/gedara-media/key && sudo chmod 600 /etc/gedara-media/key && sudo systemctl restart gedara-media-agent'
  if ($LASTEXITCODE -ne 0) { Fail 'the speaker is not paired yet: run this again for a new code' }
  Ok 'the speaker is paired and running'
  Add-MusicFolder $ip
  Write-Host ''
  Write-Host 'Music is ready: open Gedara > Music.' -ForegroundColor Green
  exit 0
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

#!/usr/bin/env bash
# Gedara print server (Phase 7g) - runs ON the Raspberry Pi as root. install.ps1 (on the PC) copies it
# over and starts it. Safe to run again: it updates the system and puts every setting back.
#
# What it makes (docs/print-server/README.md):
#   CUPS queue L3110      Epson L3110 with Epson's open ESC/P-R driver, shared on the home network;
#                         phones and the iPad print to it (AirPrint / IPP Everywhere, found by mDNS)
#   CUPS queue L3110_raw  not shared; takes ready-made data from the PC's own Epson driver untouched
#   TCP port 9100         the PC's "Standard TCP/IP" printer port -> lp -> L3110_raw (systemd socket)
#   ufw                   SSH, printing and mDNS from the home network only
#   avahi                 publishes the Pi's IPv4 address only (the firewall allows home IPv4 ranges)
#   automatic updates; CUPS restarted by systemd if it ever stops
#
#   sudo bash setup.sh            set up / update
#   sudo TEST_PAGE=1 bash setup.sh   ... and print a test page at the end
set -uo pipefail

QUEUE=L3110
RAW=L3110_raw
NICE_NAME="Epson L3110 (Gedara)"
LOG=/var/log/gedara-print-setup.log
PROBLEMS=()

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mOK\033[0m  %s\n' "$*"; }
warn() { printf '   \033[33m!!\033[0m  %s\n' "$*"; PROBLEMS+=("$*"); }
die()  { printf '\n\033[31mPROBLEM: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run me with sudo (install.ps1 does this for you)"
exec > >(tee -a "$LOG") 2>&1
echo "---- $(date -Is) setup.sh on $(hostname)"
export DEBIAN_FRONTEND=noninteractive

# ── 1. Software ───────────────────────────────────────────────────────────────
say "1/7 Installing the printing software (first time on a Pi 2: 10-20 minutes)"
apt-get update -q || die "apt-get update failed - is the Pi on the internet?"
apt-get -y -q -o Dpkg::Options::=--force-confold full-upgrade || warn "system update did not finish (printing may still work)"
apt-get -y -q install cups cups-filters avahi-daemon printer-driver-escpr unattended-upgrades ufw \
  || die "could not install the printing software"
ok "cups, cups-filters, avahi, Epson ESC/P-R driver, automatic updates, firewall"

# cups-browsed would add queues for every network printer it sees; this Pi only serves its own.
if systemctl list-unit-files cups-browsed.service >/dev/null 2>&1; then
  systemctl disable --now cups-browsed >/dev/null 2>&1 && ok "cups-browsed off (no extra queues)"
fi

# ── 2. CUPS settings ──────────────────────────────────────────────────────────
say "2/7 CUPS: share on the home network only"
# Printing is shared; administration stays on the Pi itself (setup.sh over SSH does it).
cupsctl --share-printers --no-remote-admin --no-remote-any --no-user-cancel-any \
  PreserveJobFiles=No PreserveJobHistory=86400 MaxJobs=200 || die "cupsctl failed"
# cupsctl normally switches "Listen localhost:631" to "Port 631"; make sure.
if ! grep -qE '^(Port 631|Listen (\*|0\.0\.0\.0):631)' /etc/cups/cupsd.conf; then
  sed -i 's/^Listen localhost:631/Port 631/' /etc/cups/cupsd.conf
fi
mkdir -p /etc/systemd/system/cups.service.d
cat > /etc/systemd/system/cups.service.d/gedara.conf <<'EOF'
# Gedara print server: if CUPS ever stops, start it again.
[Service]
Restart=on-failure
RestartSec=5
EOF
# Publish IPv4 addresses only: the firewall below allows the home network's IPv4 ranges, and a
# phone that picked the Pi's internet-wide IPv6 address would be refused now and then.
sed -i -E 's/^#?use-ipv6=.*/use-ipv6=no/; s/^#?publish-aaaa-on-ipv4=.*/publish-aaaa-on-ipv4=no/' /etc/avahi/avahi-daemon.conf
systemctl daemon-reload
systemctl enable --now cups avahi-daemon >/dev/null 2>&1
systemctl restart cups avahi-daemon
ok "shared to the local network, job files not kept, history 1 day, restarts by itself"

# ── 3. The printer on USB ─────────────────────────────────────────────────────
say "3/7 Looking for the Epson L3110 on USB"
find_uri() { lpinfo --include-schemes usb -v 2>/dev/null | awk '/usb:\/\/EPSON\/L3110/ {print $2; exit}'; }
URI=$(find_uri)
if [ -z "$URI" ]; then
  echo
  echo "   >>> Now move the printer's USB cable from the PC to the Raspberry Pi"
  echo "   >>> (any of the Pi's 4 USB ports) and switch the printer on."
  echo "   >>> Waiting up to 10 minutes..."
  for _ in $(seq 1 120); do
    sleep 5
    URI=$(find_uri)
    [ -n "$URI" ] && break
  done
fi
[ -n "$URI" ] || die "the Pi can't see the Epson L3110 on USB. Check the cable and that the printer is on, then run install.ps1 again."
ok "found: ${URI%%\?*}"

# ── 4. Driver for phone prints ────────────────────────────────────────────────
say "4/7 Choosing the driver for phone and iPad prints"
find_model() { lpinfo -m 2>/dev/null | grep -i 'L3110' | grep -iv 'gutenprint.*simple' | head -n1 | awk '{print $1}'; }
MODEL=$(lpinfo -m 2>/dev/null | grep -i 'L3110' | grep -i 'escpr' | head -n1 | awk '{print $1}')
if [ -z "$MODEL" ]; then
  echo "   The Epson ESC/P-R driver doesn't list the L3110 - trying Gutenprint."
  apt-get -y -q install printer-driver-gutenprint >/dev/null 2>&1 || true
  MODEL=$(find_model)
fi
if [ -n "$MODEL" ]; then ok "driver: $MODEL"; else warn "no Linux driver lists the L3110: phones can't print yet (the PC still can)"; fi

# ── 5. Queues ─────────────────────────────────────────────────────────────────
say "5/7 Creating the printer queues"
if [ -n "$MODEL" ]; then
  lpadmin -p "$QUEUE" -E -v "$URI" -m "$MODEL" -D "$NICE_NAME" -L "Gedara print server ($(hostname))" \
    -o printer-is-shared=true -o printer-error-policy=retry-job -o PageSize=A4 \
    && lpadmin -d "$QUEUE" && ok "$QUEUE: shared, A4, waits and retries if the printer is off" \
    || warn "could not create the $QUEUE queue"
fi
# Raw queues are deprecated in CUPS but still work in 2.4; this one is only for the PC (port 9100).
lpadmin -p "$RAW" -E -v "$URI" -m raw -D "Epson L3110 - PC only (raw)" \
  -o printer-is-shared=false -o printer-error-policy=retry-job 2>/dev/null \
  && ok "$RAW: not shared, for the PC through port 9100" \
  || warn "could not create the $RAW queue"

# ── 6. Port 9100 for the PC ───────────────────────────────────────────────────
say "6/7 Port 9100 for the PC (Windows 'Standard TCP/IP' printer port)"
cat > /etc/systemd/system/gedara-raw9100.socket <<'EOF'
# Gedara print server: the PC's Epson driver sends ready-made print data to port 9100;
# each connection becomes one job in the CUPS queue L3110_raw (queued, retried, then USB).
[Unit]
Description=Gedara print server - raw port 9100 for the PC

[Socket]
ListenStream=9100
Accept=yes
MaxConnections=4

[Install]
WantedBy=sockets.target
EOF
cat > /etc/systemd/system/gedara-raw9100@.service <<'EOF'
[Unit]
Description=Gedara print server - one print job from the PC

[Service]
ExecStart=/usr/bin/lp -d L3110_raw -t "From the PC" -
StandardInput=socket
StandardOutput=journal
StandardError=journal
User=nobody
TimeoutStartSec=0
RuntimeMaxSec=900
EOF
systemctl daemon-reload
systemctl enable --now gedara-raw9100.socket >/dev/null 2>&1 && ok "listening on 9100" || warn "port 9100 did not start"

# ── 7. Firewall and automatic updates ─────────────────────────────────────────
say "7/7 Firewall (home network only) and automatic security updates"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 fe80::/10 fc00::/7; do
  ufw allow from "$net" to any port 22 proto tcp >/dev/null    # SSH (install.ps1 updates)
  ufw allow from "$net" to any port 631 proto tcp >/dev/null   # IPP printing (phones, iPad)
  ufw allow from "$net" to any port 9100 proto tcp >/dev/null  # the PC
  ufw allow from "$net" to any port 5353 proto udp >/dev/null  # mDNS: the printer finds its name
done
ufw --force enable >/dev/null && ok "firewall on: SSH, printing and mDNS from the home network only" \
  || warn "the firewall did not start"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
# 32-bit Raspberry Pi OS comes from the Raspbian archive, which the Debian-only default doesn't cover.
cat > /etc/apt/apt.conf.d/51gedara-unattended <<'EOF'
// Gedara print server: also take updates from the Raspbian and Raspberry Pi archives.
Unattended-Upgrade::Origins-Pattern {
  "origin=Raspbian,codename=${distro_codename},label=Raspbian";
  "origin=Raspberry Pi Foundation,codename=${distro_codename},label=Raspberry Pi Foundation";
};
EOF
ok "updates install by themselves every day"

# ── Test page and summary ─────────────────────────────────────────────────────
if [ "${TEST_PAGE:-0}" = 1 ] && [ -n "$MODEL" ]; then
  lp -d "$QUEUE" -t "Gedara test page" /usr/share/cups/data/testprint >/dev/null && ok "test page sent"
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "------------------------------------------------------------------"
echo " Gedara print server on $(hostname) ($IP)"
lpstat -p "$QUEUE" "$RAW" 2>/dev/null | sed 's/^/   /'
if [ ${#PROBLEMS[@]} -eq 0 ]; then
  echo " RESULT: OK"
else
  echo " RESULT: PROBLEM"
  for p in "${PROBLEMS[@]}"; do echo "   - $p"; done
fi
echo "------------------------------------------------------------------"
echo "GEDARA_PI_IP=$IP"
[ ${#PROBLEMS[@]} -eq 0 ]

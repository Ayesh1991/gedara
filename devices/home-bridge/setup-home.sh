#!/bin/bash
# Gedara Home Assistant bridge (Phase 8, docs/home-assistant) — sets up gedara-home on the Gedara Pi
# (the one that shares the printer and plays music). install.ps1 -Home copies this file with
# gedara_home_bridge.py, runs it, then asks for Home Assistant's address and token (on the Pi,
# hidden) and shows the pairing code. Safe to run again.
#
#   software   python3-websocket (Home Assistant's websocket API)
#   bridge     gedara-home.service, its own user, locked down; `gedara-home pair|setup-ha|check-ha|status`
#   secrets    /etc/gedara-home/key (the bridge's key for Gedara) and ha-token (Home Assistant's),
#              readable by root and the service only, never printed
#   network    outbound only: HTTPS to Gedara, the home network to Home Assistant (no port opened)
#
#   sudo HOME_SERVER=gedara|gedara-staging bash setup-home.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB=/usr/local/lib/gedara-home
LOG=/var/log/gedara-home-setup.log
PROBLEMS=()

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mOK\033[0m  %s\n' "$*"; }
warn() { printf '   \033[33m!!\033[0m  %s\n' "$*"; PROBLEMS+=("$*"); }
die() { printf '\n\033[31mPROBLEM: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run me with sudo (install.ps1 does this for you)"
[ -f "$HERE/gedara_home_bridge.py" ] || die "gedara_home_bridge.py must be next to this script"
exec > >(tee -a "$LOG") 2>&1
echo "---- $(date -Is) setup-home.sh on $(hostname)"
export DEBIAN_FRONTEND=noninteractive

# ── 1. Software ───────────────────────────────────────────────────────────────
say "1/3 Installing the bridge's software"
# Wait for the Pi's own automatic updates (up to 10 min) and finish an install that was cut off.
for _ in $(seq 120); do fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1 || break; sleep 5; done
dpkg --configure -a || warn "could not finish an earlier install (dpkg --configure -a)"
apt-get -o DPkg::Lock::Timeout=600 update -q >/dev/null || die "apt-get update failed - is the Pi on the internet?"
apt-get -o DPkg::Lock::Timeout=600 -y -q install python3-websocket >/dev/null || die "could not install python3-websocket"
ok "python3-websocket"

# ── 2. User, folders, the bridge ──────────────────────────────────────────────
say "2/3 The bridge"
id gedara-home >/dev/null 2>&1 || useradd --system --home /var/lib/gedara-home --shell /usr/sbin/nologin gedara-home
install -d -o gedara-home -g gedara-home -m 0750 /var/lib/gedara-home
install -d -o root -g gedara-home -m 0750 /etc/gedara-home
case "${HOME_SERVER:-gedara}" in
  gedara|gedara-staging) echo "${HOME_SERVER:-gedara}" > /etc/gedara-home/server ;;
  *) die "HOME_SERVER must be gedara or gedara-staging" ;;
esac
chmod 0640 /etc/gedara-home/server && chgrp gedara-home /etc/gedara-home/server
for f in ha-url ha-token; do
  [ -f "/etc/gedara-home/$f" ] && chown root:gedara-home "/etc/gedara-home/$f" && chmod 0640 "/etc/gedara-home/$f"
done
[ -f /etc/gedara-home/key ] && chown gedara-home:gedara-home /etc/gedara-home/key && chmod 0600 /etc/gedara-home/key
install -d -m 0755 "$LIB"
install -m 0644 "$HERE/gedara_home_bridge.py" "$LIB/gedara_home_bridge.py"
cat > /usr/local/bin/gedara-home <<'EOF'
#!/bin/sh
exec /usr/bin/python3 /usr/local/lib/gedara-home/gedara_home_bridge.py "$@"
EOF
chmod 0755 /usr/local/bin/gedara-home
ok "bridge in $LIB, server ${HOME_SERVER:-gedara}"

# ── 3. The service ────────────────────────────────────────────────────────────
say "3/3 The bridge service"
cat > /etc/systemd/system/gedara-home.service <<'EOF'
[Unit]
Description=Gedara Home Assistant bridge
After=network-online.target
Wants=network-online.target

[Service]
User=gedara-home
Group=gedara-home
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/local/bin/gedara-home run
Restart=always
RestartSec=5
# Light work, and never in the way of printing or the music.
Nice=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
ReadWritePaths=/var/lib/gedara-home
ReadOnlyPaths=/etc/gedara-home

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable gedara-home >/dev/null 2>&1
if [ -s /etc/gedara-home/key ] && [ -s /etc/gedara-home/ha-token ]; then
  systemctl restart gedara-home && ok "bridge running (already paired)"
else
  ok "bridge installed; Home Assistant's address, the token and pairing come next (install.ps1 asks)"
fi

echo ""
echo "------------------------------------------------------------------"
if [ ${#PROBLEMS[@]} -eq 0 ]; then
  echo " RESULT: OK"
else
  echo " RESULT: PROBLEM"
  for p in "${PROBLEMS[@]}"; do echo "   - $p"; done
fi
echo "------------------------------------------------------------------"
[ ${#PROBLEMS[@]} -eq 0 ]

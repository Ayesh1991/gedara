#!/usr/bin/env bash
# Gedara music speaker (Phase 7h) - runs ON the Raspberry Pi as root, after the print server's
# setup.sh. install.ps1 -Music copies it with gedara_media_agent.py and starts it. Safe to run again.
#
# What it makes (docs/media-player/README.md):
#   MPD            plays /srv/gedara-music (inbox/ = songs from Gedara, pc/ = the PC folder), only on
#                  localhost; volume normalisation on (Gedara can switch it); 4 MB audio buffer
#   sound output   the USB sound card if one is plugged in, else the 3.5 mm jack (/etc/asound.conf)
#   Samba          the network folder "Gedara Music" (= /srv/gedara-music/pc), user "music" with a
#                  random password made here (install.ps1 stores it in Windows' Credential Manager)
#   agent          gedara-media-agent.service, its own user, locked down; `gedara-media pair|status`
#   priorities     MPD before CUPS, so preparing a phone print can't make the music stutter
#   ufw            SMB (445) from the home network only
#
#   sudo MEDIA_SERVER=gedara|gedara-staging bash setup-media.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB=/usr/local/lib/gedara-media
LOG=/var/log/gedara-media-setup.log
PROBLEMS=()

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mOK\033[0m  %s\n' "$*"; }
warn() { printf '   \033[33m!!\033[0m  %s\n' "$*"; PROBLEMS+=("$*"); }
note() { printf '   \033[33m--\033[0m  %s\n' "$*"; }
die() { printf '\n\033[31mPROBLEM: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run me with sudo (install.ps1 does this for you)"
[ -f "$HERE/gedara_media_agent.py" ] || die "gedara_media_agent.py must be next to this script"
exec > >(tee -a "$LOG") 2>&1
echo "---- $(date -Is) setup-media.sh on $(hostname)"
export DEBIAN_FRONTEND=noninteractive

# ── 1. Software ───────────────────────────────────────────────────────────────
say "1/7 Installing the music software"
apt-get update -q || die "apt-get update failed - is the Pi on the internet?"
apt-get -y -q install mpd python3-mpd python3-mutagen python3-pil samba alsa-utils \
  || die "could not install the music software"
ok "mpd, python3-mpd, mutagen, pillow, samba, alsa-utils"

# ── 2. Users, folders, the agent ──────────────────────────────────────────────
say "2/7 Folders and the Gedara music agent"
getent group gedara-music >/dev/null || groupadd --system gedara-music
id gedara-media >/dev/null 2>&1 || useradd --system --home /var/lib/gedara-media --shell /usr/sbin/nologin --groups audio,gedara-music gedara-media
id music >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin --groups gedara-music music
usermod -aG gedara-music,audio gedara-media
usermod -aG gedara-music mpd 2>/dev/null || true
install -d -o gedara-media -g gedara-music -m 2775 /srv/gedara-music /srv/gedara-music/inbox /srv/gedara-music/pc
install -d -o gedara-media -g gedara-media -m 0750 /var/lib/gedara-media
install -d -o root -g gedara-media -m 0750 /etc/gedara-media
[ -f /var/lib/gedara-media/mpd-normalise.conf ] || echo 'volume_normalization "yes"' > /var/lib/gedara-media/mpd-normalise.conf
chown gedara-media:gedara-media /var/lib/gedara-media/mpd-normalise.conf
case "${MEDIA_SERVER:-gedara}" in
  gedara|gedara-staging) echo "${MEDIA_SERVER:-gedara}" > /etc/gedara-media/server ;;
  *) die "MEDIA_SERVER must be gedara or gedara-staging" ;;
esac
chmod 0640 /etc/gedara-media/server && chgrp gedara-media /etc/gedara-media/server
install -d -m 0755 "$LIB" /usr/local/share/gedara-media
install -m 0644 "$HERE/gedara_media_agent.py" "$LIB/gedara_media_agent.py"
cat > /usr/local/bin/gedara-media <<'EOF'
#!/bin/sh
exec /usr/bin/python3 /usr/local/lib/gedara-media/gedara_media_agent.py "$@"
EOF
chmod 0755 /usr/local/bin/gedara-media
# A one-second chime for "Play a test sound".
python3 - <<'EOF'
import math, struct, wave
with wave.open('/usr/local/share/gedara-media/test-tone.wav', 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
    frames = bytearray()
    for i in range(44100):
        env = min(1, i / 2000, (44100 - i) / 6000)
        v = env * 0.35 * (math.sin(2 * math.pi * 880 * i / 44100) + 0.5 * math.sin(2 * math.pi * 1320 * i / 44100))
        frames += struct.pack('<h', int(v * 32767 / 1.5))
    w.writeframes(bytes(frames))
EOF
ok "folders under /srv/gedara-music, agent in $LIB, server ${MEDIA_SERVER:-gedara}"

# ── 3. Sound output ───────────────────────────────────────────────────────────
say "3/7 Choosing the sound output"
CONFIG_TXT=/boot/firmware/config.txt
[ -f "$CONFIG_TXT" ] || CONFIG_TXT=/boot/config.txt
if [ -f "$CONFIG_TXT" ] && ! grep -q '^dtparam=audio=on' "$CONFIG_TXT"; then
  echo 'dtparam=audio=on' >> "$CONFIG_TXT"
  note "turned on the 3.5 mm jack: restart the Pi once (sudo reboot) if there is no sound"
fi
USB_CARD=$(aplay -l 2>/dev/null | awk -F'[ :]' '/^card [0-9]+:/ && tolower($0) ~ /usb/ {print $2; exit}')
JACK_CARD=$(aplay -l 2>/dev/null | awk -F'[ :]' '/^card [0-9]+:/ && (tolower($0) ~ /headphones|bcm2835/) {print $2; exit}')
if [ -n "$USB_CARD" ]; then
  CARD=$USB_CARD; OUTPUT=usb
elif [ -n "$JACK_CARD" ]; then
  CARD=$JACK_CARD; OUTPUT=jack
else
  CARD=0; OUTPUT=none
  warn "no sound card found: plug in the USB sound card or check the jack, then run install.ps1 -Music again"
fi
# "default" is a dmix on that card, so MPD, AirPlay and Bluetooth (Phase 7i) can all open it; the
# agent makes sure only one of them is heard at a time.
cat > /etc/asound.conf <<EOF
# Gedara music speaker: the output setup-media.sh chose ($OUTPUT), shared by MPD, AirPlay, Bluetooth.
pcm.!default {
  type plug
  slave.pcm "gedara_mix"
}
pcm.gedara_mix {
  type dmix
  ipc_key 4242
  ipc_perm 0666
  slave {
    pcm "hw:$CARD,0"
    rate 44100
    period_size 1024
    buffer_size 8192
  }
}
ctl.!default {
  type hw
  card $CARD
}
EOF
echo "$OUTPUT" > /etc/gedara-media/output
chmod 0644 /etc/gedara-media/output
ok "sound output: $OUTPUT (card $CARD)"

# ── 4. MPD ────────────────────────────────────────────────────────────────────
say "4/7 MPD, the player"
cat > /etc/mpd.conf <<'EOF'
# Gedara music speaker (devices/media-player/setup-media.sh). Only the agent talks to MPD.
music_directory     "/srv/gedara-music"
playlist_directory  "/var/lib/mpd/playlists"
db_file             "/var/lib/mpd/tag_cache"
state_file          "/var/lib/mpd/state"
sticker_file        "/var/lib/mpd/sticker.sql"
bind_to_address     "localhost"
port                "6600"
auto_update         "yes"
restore_paused      "yes"
audio_buffer_size   "4096"
replaygain          "auto"
include             "/var/lib/gedara-media/mpd-normalise.conf"
audio_output {
  type        "alsa"
  name        "Speaker"
  device      "default"
  mixer_type  "software"
}
EOF
install -d -o mpd -g audio /var/lib/mpd/playlists
mkdir -p /etc/systemd/system/mpd.service.d /etc/systemd/system/cups.service.d
cat > /etc/systemd/system/mpd.service.d/gedara.conf <<'EOF'
# Music first: a phone print being prepared must not make it stutter.
[Service]
CPUWeight=200
Nice=-5
Restart=on-failure
EOF
cat > /etc/systemd/system/cups.service.d/gedara-music.conf <<'EOF'
[Service]
CPUWeight=50
Nice=10
EOF
# Gedara's "even out loud and quiet songs" setting: the agent writes the file, this restarts MPD.
cat > /etc/systemd/system/gedara-mpd-normalise.path <<'EOF'
[Unit]
Description=Gedara music - restart MPD when the normalise setting changes
[Path]
PathChanged=/var/lib/gedara-media/mpd-normalise.conf
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/gedara-mpd-normalise.service <<'EOF'
[Unit]
Description=Gedara music - apply the normalise setting
[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl restart mpd
EOF
systemctl daemon-reload
systemctl enable --now mpd gedara-mpd-normalise.path >/dev/null 2>&1
systemctl restart mpd && ok "MPD running on localhost, music before printing" || warn "MPD did not start (journalctl -u mpd)"

# ── 5. The "Gedara Music" network folder ──────────────────────────────────────
say "5/7 The \"Gedara Music\" network folder (Samba)"
PW_FILE=/etc/gedara-media/samba-password
if [ ! -s "$PW_FILE" ]; then
  ( umask 077; python3 -c 'import secrets; print(secrets.token_urlsafe(18))' > "$PW_FILE" )
fi
chmod 0600 "$PW_FILE"
PW=$(cat "$PW_FILE")
printf '%s\n%s\n' "$PW" "$PW" | smbpasswd -a -s music >/dev/null && smbpasswd -e music >/dev/null
unset PW
cat > /etc/samba/smb.conf <<'EOF'
# Gedara music speaker (devices/media-player/setup-media.sh): one share, home network only.
[global]
   server string = Gedara speaker
   server role = standalone server
   server min protocol = SMB2_10
   map to guest = never
   hosts allow = 127. 10. 172.16.0.0/12 192.168.
   load printers = no
   printing = bsd
   printcap name = /dev/null
   disable spoolss = yes
   log file = /var/log/samba/log.%m
   max log size = 200

[Gedara Music]
   comment = Drop songs here: they appear in Gedara Music
   path = /srv/gedara-music/pc
   valid users = music
   read only = no
   force group = gedara-music
   create mask = 0664
   directory mask = 2775
EOF
systemctl enable --now smbd >/dev/null 2>&1
systemctl restart smbd && ok "share \\\\$(hostname)\\Gedara Music (user music, password kept on the Pi)" || warn "Samba did not start"
systemctl disable --now nmbd >/dev/null 2>&1 || true
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
  ufw allow from "$net" to any port 445 proto tcp >/dev/null
done
ok "firewall: SMB from the home network only"

# ── 6. The agent service ──────────────────────────────────────────────────────
say "6/7 The agent service"
cat > /etc/systemd/system/gedara-media-agent.service <<'EOF'
[Unit]
Description=Gedara music speaker agent
After=network-online.target mpd.service
Wants=network-online.target
Requires=mpd.service

[Service]
User=gedara-media
Group=gedara-media
SupplementaryGroups=audio gedara-music
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/local/bin/gedara-media run
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/srv/gedara-music /var/lib/gedara-media -/run/gedara-media
ReadOnlyPaths=/etc/gedara-media

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable gedara-media-agent >/dev/null 2>&1
if [ -s /etc/gedara-media/key ]; then
  chown gedara-media:gedara-media /etc/gedara-media/key && chmod 0600 /etc/gedara-media/key
  systemctl restart gedara-media-agent && ok "agent running (already paired)"
else
  ok "agent installed; pairing comes next (install.ps1 shows the code)"
fi

# ── 7. Network speaker: AirPlay + Bluetooth (Phase 7i) ────────────────────────
say "7/7 Network speaker: AirPlay and Bluetooth"
apt-get -y -q install shairport-sync bluez bluez-alsa-utils bluez-tools >/dev/null \
  || warn "could not install AirPlay / Bluetooth software"
install -m 0644 "$HERE/gedara_network.py" "$LIB/gedara_network.py"
usermod -aG bluetooth gedara-media 2>/dev/null || true
id shairport-sync >/dev/null 2>&1 && usermod -aG gedara-music,audio shairport-sync
cat > /etc/tmpfiles.d/gedara-media.conf <<'EOF'
d /run/gedara-media 2775 gedara-media gedara-music -
p /run/gedara-media/shairport-metadata 0660 shairport-sync gedara-music -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/gedara-media.conf

# AirPlay: plays to the shared output; tells the agent (metadata pipe) when a phone starts / stops.
NAME=$(python3 -c 'import json; print(json.load(open("/var/lib/gedara-media/network.json")).get("name","Gedara speaker"))' 2>/dev/null || echo "Gedara speaker")
cat > /etc/shairport-sync.conf <<EOF
// Gedara speaker (devices/media-player/setup-media.sh). The name follows the speaker's name in Gedara.
general = {
  name = "$NAME";
  output_backend = "alsa";
  interpolation = "basic";
  volume_range_db = 50;
};
alsa = {
  output_device = "default";
};
sessioncontrol = {
  allow_session_interruption = "yes";
  session_timeout = 20;
};
metadata = {
  enabled = "yes";
  include_cover_art = "no";
  pipe_name = "/run/gedara-media/shairport-metadata";
};
EOF
if shairport-sync -V 2>/dev/null | grep -qi airplay2; then ok "AirPlay 2 supported"; else ok "classic AirPlay (works with iPhone, iPad, Mac)"; fi

# Gedara switches AirPlay on/off, renames it, or ends a session: the agent writes these files, root acts.
cat > /usr/local/lib/gedara-media/apply-network.sh <<'EOF'
#!/bin/sh
# Gedara speaker: apply /var/lib/gedara-media/network.json (AirPlay on/off + name) and end an
# AirPlay session when /run/gedara-media/airplay-stop appears (Gedara took the speaker back).
CONF=/var/lib/gedara-media/network.json
if [ -f "$CONF" ]; then
  ON=$(python3 -c 'import json; print(1 if json.load(open("'"$CONF"'")).get("airplay", True) else 0)' 2>/dev/null || echo 1)
  NAME=$(python3 -c 'import json,re; n=json.load(open("'"$CONF"'")).get("name","Gedara speaker"); print(re.sub(r"[^\w .\x27-]", "", n)[:40] or "Gedara speaker")' 2>/dev/null || echo "Gedara speaker")
  sed -i "s/^  name = \".*\";/  name = \"$NAME\";/" /etc/shairport-sync.conf
  if [ "$ON" = 1 ]; then systemctl enable --now shairport-sync >/dev/null 2>&1; systemctl restart shairport-sync
  else systemctl disable --now shairport-sync >/dev/null 2>&1; fi
fi
if [ -e /run/gedara-media/airplay-stop ]; then
  rm -f /run/gedara-media/airplay-stop
  systemctl restart shairport-sync
fi
EOF
chmod 0755 /usr/local/lib/gedara-media/apply-network.sh
cat > /etc/systemd/system/gedara-network.path <<'EOF'
[Unit]
Description=Gedara speaker - apply AirPlay settings from Gedara
[Path]
PathChanged=/var/lib/gedara-media/network.json
PathExists=/run/gedara-media/airplay-stop
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/gedara-network.service <<'EOF'
[Unit]
Description=Gedara speaker - apply AirPlay settings
[Service]
Type=oneshot
ExecStart=/usr/local/lib/gedara-media/apply-network.sh
EOF
mkdir -p /etc/systemd/system/shairport-sync.service.d /etc/systemd/system/bluealsa.service.d /etc/systemd/system/bluealsa-aplay.service.d
printf '[Service]\nCPUWeight=200\nRestart=on-failure\n' > /etc/systemd/system/shairport-sync.service.d/gedara.conf
printf '[Service]\nCPUWeight=200\nRestart=on-failure\n' > /etc/systemd/system/bluealsa-aplay.service.d/gedara.conf

# Bluetooth: an A2DP speaker that is invisible and refuses pairing except in Gedara's 2-minute window.
if [ -f /etc/bluetooth/main.conf ]; then
  sed -i -E 's/^#?\s*Class\s*=.*/Class = 0x240414/; s/^#?\s*DiscoverableTimeout\s*=.*/DiscoverableTimeout = 120/; s/^#?\s*PairableTimeout\s*=.*/PairableTimeout = 120/' /etc/bluetooth/main.conf
fi
BLUEALSA=$(command -v bluealsa || echo /usr/bin/bluealsa)
cat > /etc/systemd/system/bluealsa.service.d/gedara.conf <<EOF
[Service]
ExecStart=
ExecStart=$BLUEALSA -p a2dp-sink
EOF
systemctl daemon-reload
systemctl enable --now gedara-network.path shairport-sync >/dev/null 2>&1
systemctl restart shairport-sync && ok "AirPlay: \"$NAME\" on the home network" || warn "AirPlay did not start (journalctl -u shairport-sync)"
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
  ufw allow from "$net" to any port 5000,7000 proto tcp >/dev/null
  ufw allow from "$net" to any port 6000:6100 proto udp >/dev/null
  ufw allow from "$net" to any port 319,320 proto udp >/dev/null
done
ok "firewall: AirPlay from the home network only"
if [ -d /sys/class/bluetooth ] && ls /sys/class/bluetooth | grep -q hci; then
  systemctl enable --now bluetooth bluealsa bluealsa-aplay >/dev/null 2>&1
  systemctl restart bluealsa bluealsa-aplay
  bluetoothctl discoverable off >/dev/null 2>&1; bluetoothctl pairable off >/dev/null 2>&1
  ok "Bluetooth adapter found: pair phones from Gedara (Settings > Devices > the speaker)"
else
  note "no Bluetooth adapter: plug a USB Bluetooth adapter in and run install.ps1 -Music again"
fi
systemctl restart gedara-media-agent 2>/dev/null || true

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "------------------------------------------------------------------"
echo " Gedara music speaker on $(hostname) ($IP) - output: $OUTPUT"
if [ ${#PROBLEMS[@]} -eq 0 ]; then
  echo " RESULT: OK"
else
  echo " RESULT: PROBLEM"
  for p in "${PROBLEMS[@]}"; do echo "   - $p"; done
fi
echo "------------------------------------------------------------------"
[ ${#PROBLEMS[@]} -eq 0 ]

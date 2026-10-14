#!/usr/bin/env bash
# Gedara print server - everything that matters on one screen. Changes nothing.
#   install.ps1 -Status   (from the PC)   or   bash status.sh   (on the Pi)
set -u

line() { printf '%-26s %s\n' "$1" "$2"; }
yes_no() { if eval "$2" >/dev/null 2>&1; then line "$1" "OK"; else line "$1" "PROBLEM - $3"; fi; }

echo "Gedara print server: $(hostname)  ($(hostname -I 2>/dev/null | awk '{print $1}'))"
echo "------------------------------------------------------------------"
yes_no "Printer on USB"        "lpinfo --include-schemes usb -v | grep -q 'usb://EPSON/L3110'" "printer off, or the USB cable is out"
yes_no "CUPS running"          "systemctl is-active --quiet cups"                    "sudo systemctl restart cups"
yes_no "Name on the network"   "systemctl is-active --quiet avahi-daemon"            "phones won't find the printer: sudo systemctl restart avahi-daemon"
yes_no "Port 9100 (the PC)"    "systemctl is-active --quiet gedara-raw9100.socket"   "the PC can't print: run install.ps1 again"
yes_no "Firewall"              "ufw status | grep -q 'Status: active'"               "run install.ps1 again"
for q in L3110 L3110_raw; do
  state=$(lpstat -p "$q" 2>/dev/null | head -n1)
  case "$state" in
    *disabled*) line "Queue $q" "STOPPED - sudo cupsenable $q" ;;
    *idle*)     line "Queue $q" "ready" ;;
    *printing*) line "Queue $q" "printing" ;;
    "")         line "Queue $q" "missing - run install.ps1 again" ;;
    *)          line "Queue $q" "$state" ;;
  esac
done
jobs=$(lpstat -o 2>/dev/null | wc -l)
line "Jobs waiting" "$jobs$( [ "$jobs" -gt 0 ] && echo '  (lpstat -o lists them; cancel -a removes them all)')"
line "Disk used" "$(df -h / | awk 'NR==2 {print $5 " of " $2}')"
if [ -r /sys/class/thermal/thermal_zone0/temp ]; then
  line "Temperature" "$(( $(cat /sys/class/thermal/thermal_zone0/temp) / 1000 )) C"
fi
if command -v vcgencmd >/dev/null 2>&1; then
  t=$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)
  case "$t" in
    0x0) line "Power supply" "OK" ;;
    "")  ;;
    *)   line "Power supply" "WEAK ($t) - use a 5 V 2 A adapter and a short cable" ;;
  esac
fi
line "Up since" "$(uptime -s 2>/dev/null)"
last=$(ls -1t /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null | head -n1)
[ -n "$last" ] && line "Last automatic update" "$(date -r "$last" '+%Y-%m-%d %H:%M')"
echo "------------------------------------------------------------------"
echo "Last 5 jobs:"
lpstat -W completed -o 2>/dev/null | tail -n 5 | sed 's/^/  /'

# devices/print-server — Raspberry Pi 2 print server (Phase 7g)

Shares the Epson L3110 on the home network. Didula's guide: [docs/print-server](../../docs/print-server/README.md).

| File | Runs on | Does |
|---|---|---|
| `install.ps1` | the Windows PC (Windows PowerShell 5.1) | finds the Pi, makes this PC's SSH key (`%USERPROFILE%\.ssh\gedara_print_ed25519`, never printed) and installs it with one password prompt, copies `setup.sh`/`status.sh` (LF) to `/opt/gedara-print`, runs setup, adds the Windows printer `EPSON L3110 (Gedara Pi)` (Standard TCP/IP port `GedaraPi_<ip>`:9100 + the installed Epson driver; elevates itself for this), prints test pages. `-Status`, `-RemoveWindowsPrinter`, `-Reflashed`, `-PiHost` |
| `setup.sh` | the Pi, as root (idempotent) | packages (cups, cups-filters, avahi, printer-driver-escpr → gutenprint fallback, unattended-upgrades, ufw); cupsctl share to `@LOCAL`, no remote admin; queues `L3110` (driver, shared, A4, retry-job, default) and `L3110_raw` (raw, not shared); systemd socket `gedara-raw9100` (each connection → `lp -d L3110_raw -`); avahi IPv4-only; ufw (22/631/9100/5353 from RFC 1918 + link-local/ULA only); daily updates incl. the Raspbian archive; CUPS `Restart=on-failure`; summary ends `RESULT: OK` and exits non-zero on problems |
| `status.sh` | the Pi | read-only health screen (USB, services, queues, jobs, disk, temperature, throttling, last update) |

Why port 9100 for the PC rather than IPP: a Windows "Standard TCP/IP" raw port with the Epson
driver is fully scriptable (`Add-PrinterPort` / `Add-Printer`) and keeps every Epson option; the
socket hands each job to CUPS, so jobs still queue and retry, and the USB device has one owner.

SSH host key pinned under `HostKeyAlias=gedara-print` (first contact trusted on the home network; `-Reflashed` forgets it). Nothing here holds a Gedara or Supabase secret. Logs: `/var/log/gedara-print-setup.log`, `journalctl -u 'gedara-raw9100@*'`, CUPS `/var/log/cups/error_log`.

# Print server — when something's wrong

Cheapest first: is the printer on and is there paper → is the Pi's red light on → run
`powershell -ExecutionPolicy Bypass -File devices/print-server/install.ps1 -Status` (everything on one screen).

| You see | Likely cause | Do this |
|---|---|---|
| `install.ps1`: **can't find 'gedara-print.local'** | Windows can't look the name up | type the Pi's address from the router's device list (setup.md, Stage C step 3) |
| `install.ps1`: **the Pi … doesn't answer** | Pi still starting, or not on the network | wait 3 minutes after power-on; check the network cable lights; with Wi-Fi, check the name/password you gave Imager |
| `install.ps1`: **could not log in** | wrong user name or password, or the card was written again | check the paper from Stage B; after re-writing the card add `-Reflashed` |
| setup: **can't see the Epson L3110 on USB** | cable still in the PC, printer off | move the USB cable to the Pi, switch the printer on, run `install.ps1` again |
| setup: **no Linux driver lists the L3110** | the Pi's driver package doesn't know this model | the PC still prints. Send me the lines above it: phone printing needs another driver |
| PC: job sits **"Error – Printing"** / nothing comes out | the Pi's address changed | run `install.ps1` again (it fixes the address), then reserve the address in the router (setup.md, Stage D) |
| PC: Properties shows only **Layout / Paper/Quality** (no Epson presets) | that PC uses Windows' basic printer "Epson L3110 (Gedara) @ gedara-print" | add **EPSON L3110 (Gedara Pi)** there: setup.md, *Another PC (the laptop)* |
| PC: Epson window starts on **Letter** | an older install | Printing preferences → Document Size **A4** → OK (new installs set A4 themselves) |
| PC: prints **garbage** (pages of symbols) | the Windows printer uses the wrong driver | Settings → Printers → EPSON L3110 (Gedara Pi) → Printer properties → Advanced → Driver: **EPSON L3110 Series** |
| Phone: **printer not in the list** | the phone is on mobile data or a guest Wi-Fi, or the Pi's name service is stuck | phone on the home Wi-Fi (not "guest"); then `install.ps1 -Status`: "Name on the network" must be OK; restarting the Pi (unplug 10 s) also helps |
| Phone: **printer found, nothing prints** | the job waits on the Pi | `-Status` → "Jobs waiting" / "Queue L3110 STOPPED" → run `install.ps1` again (it re-enables the queues) |
| Phone print takes **a minute** to start | the Pi 2 prepares the whole page | normal for full label sheets; documents of a few pages are quicker |
| **Labels shifted** on phone prints only | the phone scales the page slightly | compare the two calibration pages (setup.md, Stage E) and tell me the difference |
| `-Status`: **Power supply WEAK** | adapter too weak or a long thin cable | use a 5 V 2 A adapter with a short cable; weak power causes random restarts |
| `-Status`: **Printer on USB: PROBLEM** while the printer is on | loose cable, or the printer went to sleep oddly | unplug/replug the USB cable at the Pi; switch the printer off and on |
| Nozzle check / head cleaning from the PC does nothing | the Epson Maintenance tab needs a direct USB link | use the printer's buttons, or plug the USB into the PC for that job and back afterwards |

Still stuck: copy everything `install.ps1 -Status` shows and send it to me.

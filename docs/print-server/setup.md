# Print server setup, click by click

About an hour, most of it waiting. Do the stages in order. After each step, **"You should see"**
tells you whether it worked. If something looks different, stop and send me a photo or the text.

---

## Stage A · Decide how the Pi joins the network
- **Network cable (recommended):** put the Pi and the printer near the router. The most reliable choice.
- **USB Wi-Fi adapter:** the Pi can sit anywhere in Wi-Fi range. Before you buy one, check its
  description says it works with **Linux / Raspberry Pi** without installing a driver (for example
  adapters with a Realtek RTL8188 or a MediaTek MT7601 / MT7610 chip). Avoid ones that only list
  Windows/macOS drivers.

---

## Stage B · Prepare the SD card (on this PC, about 15 minutes)

1. [ ] In your browser open **raspberrypi.com/software** → **Download for Windows** → run the
   downloaded `imager_….exe` → **Install** → open **Raspberry Pi Imager**.
2. [ ] Put the microSD card in the card reader.
3. [ ] **Device:** choose **Raspberry Pi 2**.
4. [ ] **Operating system:** **Raspberry Pi OS (other)** → **Raspberry Pi OS Lite (32-bit)**
   (Lite = no desktop, which is what a printer server needs).
5. [ ] **Storage:** choose the SD card. Check the size matches your card, not another drive.
6. [ ] **Next.** When it asks about **OS customisation**, choose **Edit settings** (newer Imager
   versions show the same items as steps of the wizard). Fill in:
   - **Hostname:** `gedara-print`
   - **Username:** a short name, for example `didula`. **Password:** one you choose. Write both on
     paper. You type the password once more, in Stage C.
   - **Wireless LAN:** **only if** you use a USB Wi-Fi adapter: your Wi-Fi name, its password,
     country **LK**. With a network cable, leave it empty.
   - **Locale:** time zone **Asia/Colombo**, keyboard **us**.
   - **Services** (or *Remote access*): **Enable SSH** → **Use password authentication**.
   - Raspberry Pi Connect: leave off.
7. [ ] **Save** → **Yes** (use these settings) → **Yes** (erase the card). Wait for **Write
   successful** → remove the card.
8. [ ] Put the card in the Pi (underneath, contacts facing the board). Close the case.
9. [ ] Connect the **network cable** from the Pi to the router (or plug in the Wi-Fi adapter).
10. [ ] Connect the power adapter. Leave the **printer still connected to the PC** for now.

**You should see:** the Pi's red light on, the green light flickering. **Wait 3 minutes** (the first
start sets itself up and restarts once).

---

## Stage C · One command on this PC (about 20 minutes, mostly waiting)

1. [ ] VS Code → the `gedara-handoff` folder → **Terminal → New Terminal**.
2. [ ] Type this and press Enter:
   ```bash
   powershell -ExecutionPolicy Bypass -File devices/print-server/install.ps1
   ```
3. [ ] **Your user name on the Pi:** type the username from Stage B, Enter.
   - If it says it **can't find 'gedara-print.local'**: open your router's page (usually
     `192.168.1.1`), find the device **gedara-print** in its list of connected devices, and type
     its address (like `192.168.1.50`).
4. [ ] **Password:** type the Pi password from Stage B (the letters stay invisible) → Enter.
   - The first time it may also ask *"Are you sure you want to continue connecting?"*. That is
     answered for you. If you see it anyway, type `yes`.
5. [ ] **Wait.** Coloured lines show each part: `1/7 Installing …` takes the longest on a Pi 2.
6. [ ] When it says **"Now move the printer's USB cable from the PC to the Raspberry Pi"**: unplug
   the USB cable from the PC, plug it into any USB port of the Pi, and make sure the printer is on.

   **You should see:** `OK found: usb://EPSON/L3110 …`, then the queues, port 9100, firewall, and
   **RESULT: OK**. A **test page** prints (the Pi made it, so phone printing works too).
7. [ ] **"Windows asks for permission to add a printer: click Yes"** → a blue Windows box asks
   *"Do you want to allow this app…"* → **Yes**. A second window opens, says `OK added 'EPSON L3110
   (Gedara Pi)'`, and asks you to press Enter.
8. [ ] **"Print a Windows test page?"** → press Enter (yes).

   **You should see:** a Windows test page from the printer and **All done.** in green.

---

## Stage D · Check the PC, and fix the Pi's address in the router

1. [ ] Open any Word document → **File → Print** → Printer: **EPSON L3110 (Gedara Pi)** → **Printer
   Properties**. **You should see:** the same Epson window as before (Main / More Options). Print one page.
2. [ ] Open a PDF → Print → the same printer → Print.
3. [ ] **Reserve the Pi's address**, so the PC always finds it:
   1. Open the router's page in the browser (usually `192.168.1.1`, the login is on a sticker under the router).
   2. Look for **LAN → DHCP**, **DHCP Static IP / Address Reservation**, or **Static Lease**.
   3. Add **gedara-print** (pick it from the list of connected devices) with the address that
      `install.ps1` showed. **Save.**
   - If you can't find it: tell me the router brand and model, and I'll give you the exact clicks.
   - If you skip this and the printer stops working one day: run the Stage C command again; it
     finds the new address and fixes the PC printer.
4. [ ] The old printer **"EPSON L3110 Series"** (USB) stays in Windows' list. It is now offline;
   leave it, for the day you plug the USB back in for a nozzle check.

---

## Stage E · Phones and iPad

**iPhone / iPad**
1. [ ] Gedara → **Places → Print labels** → **Calibration page** (it downloads a PDF) → it opens → **Share** (□↑) → **Print**.
2. [ ] **Printer:** **Epson L3110 (Gedara)** (it appears by itself; give it a few seconds) → **Print**.
   - Ignore **"Epson L3110 – PC only (raw)"** if it ever shows up: that one is for the PC.

**Android**
1. [ ] Gedara → Places → Print labels → Calibration page → open the PDF → **⋮** → **Print**.
2. [ ] At the top, **Select a printer → All printers** → **Epson L3110 (Gedara)**.
   - Not in the list: **Add printer → Default Print Service**, wait 10 seconds. Still nothing: install
     **Mopria Print Service** from the Play Store, open it once, then try again.

**Do the labels land in the same place?**
1. [ ] Print the calibration page from the **PC** too (Places → Print labels → Calibration page → open the PDF → Print → EPSON L3110 (Gedara Pi), size **Actual size**).
2. [ ] Hold the phone print and the PC print together against a window. Do the crosshairs line up?
   - **Within half a millimetre:** done. Print a real label sheet from the phone.
   - **Further apart:** tell me how many millimetres (left/right, up/down). Gedara then needs a
     separate calibration for phone prints (a small follow-up).

---

## Stage F · Tell me
Send me: **RESULT: OK** (or the PROBLEM lines), whether the PC, iPhone and Android printed, and
whether the two calibration pages lined up.

---

## Another PC (the laptop)

Windows may add the Pi's printer by itself as **"Epson L3110 (Gedara) @ gedara-print"**. That one
prints, but with Windows' basic driver: only Layout and Paper/Quality, no Epson presets. For the full
Epson Properties, add **EPSON L3110 (Gedara Pi)** to the laptop too:

1. [ ] **Epson driver on the laptop:** epson.com → Support → search **L3110** → Drivers → **Printer
   Driver** for Windows → install. If the installer insists on a USB connection, plug the printer
   into the laptop just for the install, then put the cable back on the Pi.
2. [ ] Copy **one file** to the laptop (USB stick, OneDrive or email to yourself):
   `devices/print-server/install.ps1` → for example into **Downloads**.
3. [ ] On the laptop: **Start** → type `powershell` → open **Windows PowerShell** → type:
   ```powershell
   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\install.ps1" -ThisPcOnly
   ```
   It finds the Pi (or asks for the address the desktop showed) → **Yes** when Windows asks → Enter.
4. [ ] **Remove the basic one** so you don't pick it by mistake: Settings → Bluetooth & devices (or
   Devices) → **Printers & scanners** → **Epson L3110 (Gedara) @ gedara-print** → **Remove**.

**You should see:** in the Print window, **EPSON L3110 (Gedara Pi)** → Properties → the Epson window
with Printing Presets, Document Size **A4**, Paper Type and Quality.

---

## Later

| You want to | Do this |
|---|---|
| See if everything is fine | `powershell -ExecutionPolicy Bypass -File devices/print-server/install.ps1 -Status` |
| Update the Pi by hand | the Stage C command again (updates also install by themselves every day) |
| Clean the print head | hold the printer's ink/stop button for about 3 seconds (check its manual), or plug the USB back into the PC and use Epson's **Maintenance** tab |
| Use the printer on the PC by USB again | plug the cable back into the PC and choose **EPSON L3110 Series** |
| Remove the Pi printer from the PC | `… install.ps1 -RemoveWindowsPrinter` |
| Add the printer to another PC | see **Another PC (the laptop)** above (`install.ps1 -ThisPcOnly`) |
| You wrote the SD card again | the Stage C command with `-Reflashed` at the end |

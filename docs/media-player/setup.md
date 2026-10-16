# Music speaker setup, click by click

About 20 minutes, most of it waiting. The print server must already be set up
([docs/print-server/setup.md](../print-server/setup.md)). After each step, **"You should see"**
tells you whether it worked; if something looks different, send me a photo or the text.

---

## Stage A · Sound
1. [ ] **Recommended:** plug a **USB sound card** into one of the Pi's USB ports (any cheap
   "USB audio adapter" with a 3.5 mm output works). Connect the speaker to it.
   **Or** connect the speaker to the Pi's own 3.5 mm jack (works, with a little hiss).
2. [ ] Use a **powered** speaker (its own USB or mains power), and set its own volume to about half.

---

## Stage B · One command on this PC
1. [ ] VS Code → the `gedara-handoff` folder → **Terminal → New Terminal**.
2. [ ] For the **real site** (gedara.vercel.app):
   ```powershell
   powershell -ExecutionPolicy Bypass -File devices/print-server/install.ps1 -Music
   ```
   For a test on the **preview site** first, add `-Server gedara-staging` at the end.
3. [ ] **Wait** while it installs (5–10 minutes). Coloured lines show each part.
   **You should see:** `sound output: usb` (or `jack`) and **RESULT: OK**.
4. [ ] It then shows a box with **Pairing code: 1234 5678** and waits.

---

## Stage C · Pair it in Gedara (while the code is on screen)
1. [ ] On your phone or the PC, open Gedara (the real site, or the preview if you used
   `-Server gedara-staging`) → **Settings → Devices** → **Music speakers** → **Add speaker**.
2. [ ] Type the 8 digits, keep or change the name, then tap **Pair**.
   **You should see:** in the terminal, `PAIRED: 'Living room speaker' in the household 'Gedara'`. If
   the household name is not yours, remove the speaker there and run Stage B again.
3. [ ] The installer then stores the folder password itself and puts a **"Gedara Music"** shortcut on
   the desktop; File Explorer opens it.

---

## Stage D · First songs
1. [ ] Gedara → **Music** → **Add music** → choose a few MP3s.
   **You should see:** each song goes *Uploading → On its way to the speaker*, then appears in the
   library within a few seconds.
2. [ ] Tap a song. **You should see:** it plays from the speaker in about a second, and the cover
   glows on the Music page.
3. [ ] Go to another Gedara screen: the **mini player** stays at the bottom.
4. [ ] Try the **sleep timer**: tap *15 min*. The page says "Fades out in 15 minutes".

**The PC folder:** drag songs (whole album folders are fine) into the **Gedara Music** shortcut.
Within a minute they appear in Gedara, with their covers.

**Android:** in the Files app (or WhatsApp, Drive), long-press a song → **Share** → **Gedara** → **Add**.

---

## Stage E · Settings and a wind-down schedule
1. [ ] **Settings → Devices → your speaker**:
   - **Play a test sound**;
   - set **Loudest anyone can set**;
   - leave **Even out loud and quiet songs** on.
2. [ ] **Wind-down schedules → Add**:
   - name `Wind down`, starts at `21:30`, choose the days;
   - the playlist (or the whole library), volume 35, stop after 45 min;
   - **Save**.
3. [ ] **Print a page while music plays.** The music should not stutter.

---

## The laptop (folder only)
Copy `devices/print-server/install.ps1` to the laptop (for example into Downloads), then in
**Windows PowerShell**:
```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\install.ps1" -MusicFolder
```
It asks for the Pi's user name and password once, then adds the same **Gedara Music** shortcut.
For music control the laptop just uses Gedara in the browser.

---

## Later
| You want to | Do this |
|---|---|
| Move the speaker from the preview site to the real site | Gedara (preview) → remove the speaker; then Stage B with `-Music` (no `-Server`) and Stage C on gedara.vercel.app |
| Check the speaker | Gedara → Settings → Diagnostics (Music speaker card), or the speaker's page |
| Update the Pi's music software | run the Stage B command again (your songs stay) |

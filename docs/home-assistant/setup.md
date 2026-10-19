# Home Assistant setup, click by click

About 15 minutes. The Gedara Pi must already be set up ([print server](../print-server/setup.md)).
After each step, **"You should see"** tells you whether it worked; if something looks different,
send me a photo or the text. **Never paste the token into a chat.**

---

## Stage A · A "Gedara" user in Home Assistant (once)
1. [ ] Open Home Assistant on the PC → **Settings** → **People** → **Add person** (bottom right).
2. [ ] Name: **Gedara**. Turn on **Allow person to login**. Then:
   - Username: **gedara**; make up a password (Home Assistant keeps it; you only need it in step 4);
   - **Can only log in from the local network**: **on**;
   - **Administrator**: **off**.
   Click **Create**.
3. [ ] Open a **private window** (Ctrl+Shift+N in Chrome or Edge) and go to your Home Assistant address
   (for example `http://homeassistant.local:8123`).
4. [ ] Sign in as **gedara** with that password.

## Stage B · The token (once)
1. [ ] Still signed in as **gedara**: click **Gedara** at the bottom left (the profile) → the **Security** tab.
2. [ ] Scroll to **Long-lived access tokens** → **Create token** → name it **Gedara bridge** → **OK**.
3. [ ] Home Assistant shows the token **once**. Click the copy button. Keep this window open until
   Stage C asks for it. Don't save it anywhere else.

---

## Stage C · One command on this PC
1. [ ] VS Code → the `gedara-handoff` folder → **Terminal → New Terminal**.
2. [ ] For the **real site** (gedara.vercel.app):
   ```powershell
   powershell -ExecutionPolicy Bypass -File devices/print-server/install.ps1 -HomeAssistant
   ```
   To try it on the **preview site** first, add `-Server gedara-staging` at the end.
3. [ ] If it asks for the Pi's password (for `sudo`), type it. **You should see:** **RESULT: OK**.
4. [ ] **`Address [http://homeassistant.local:8123]:`** press **Enter** if that's how you open Home
   Assistant, or type its address (for example `192.168.1.20:8123`) and press Enter.
5. [ ] **`Token:`** right-click to paste the token from Stage B, then press **Enter**. Nothing
   shows while you paste; that's normal.
   **You should see:** `OK: Home Assistant 2026.x; found 1 climate, 3 door, 12 light, 6 switch, 9 window; rooms: Bedroom, Kitchen, …`
6. [ ] Now close the private window from Stage A.
7. [ ] It shows a box with **Pairing code: 1234 5678** and waits.

## Stage D · Connect it in Gedara (while the code is on screen)
1. [ ] Open Gedara (the real site, or the preview if you used `-Server gedara-staging`) →
   **Settings → Devices** → **Home Assistant** → **Connect**.
2. [ ] Type the 8 digits, keep the name, tap **Connect**.
   **You should see:** in the terminal, `PAIRED: 'Home Assistant' in the household 'Gedara'`.

## Stage E · Choose what shows
1. [ ] **Settings → Devices → Home Assistant** (tap the row). Every door, window, light, switch and
   AC is listed by room.
2. [ ] Turn **Control** on for the **Mosquito Vaporizer** and the **Emergency light(s)**. The AC is
   already controllable; doors, windows and lights are shown.
3. [ ] Turn **Show** off for anything you don't want on the House page (for example test devices).
4. [ ] Optional: tap a name to give it a short one ("LivingRoom Living Room Window 3" → "Window 3").
5. [ ] Open **House** (sidebar on the PC; on the phone, the House card on Home).
   **You should see:** every room, "Everything closed" (or what's open). Switch the vaporizer:
   it turns on in Home Assistant within a second or two.

---

## Later
- **Update** the bridge: run the Stage C command again (it keeps the token if you press Enter at
  "Keep the Home Assistant token…").
- **New token** (if you deleted it in Home Assistant): Stage B again, then Stage C and answer **n**
  at "Keep the Home Assistant token…".
- **Disconnect:** Gedara → Settings → Devices → Home Assistant → **Disconnect Home Assistant**. Then
  in Home Assistant you can delete the Gedara user's token too.

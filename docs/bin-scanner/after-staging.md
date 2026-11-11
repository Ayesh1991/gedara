# Bin scanner: the checklist, stage by stage

Work through the stages in order. Tick each box as you go. After each **"Send me"** line, paste the
Serial Monitor text or a photo into the chat before you go on.

| Stage | What | You need | Where |
|---|---|---|---|
| 0 | The database and server on staging | PC | terminal |
| 1 | The bare board on USB (nothing wired) | the board, USB-C cable | VS Code + preview site |
| 2 | Wired on the bench, one part at a time | all parts, breadboard, jumper wires | VS Code + preview site |
| 3 | In its box, by the bin | box, window, charger | the kitchen |
| 4 | A week of real use | — | preview site |
| 5 | Go live on gedara.vercel.app | PC, GitHub | terminal + GitHub |
| 6 | Later: firmware updates | VS Code | gedara.vercel.app |

The **preview site** is https://gedara-git-phase-11-ayeshmantha.vercel.app (staging data, safe to play
with). The **real site** is https://gedara.vercel.app. Don't mix them: a scanner key from one site
only works on that site's server.

---

## Stage 0 · Database and server on staging (once)

In a terminal in the `gedara-handoff` folder:

1. [ ] The database (type `Y` if asked):
   ```bash
   npx --yes supabase@2.121.0 db push --linked
   ```
2. [ ] Tell me it's done. I then deploy the scanner's server function and the notification function to
   staging, refresh the app's database types, run the tests and push the preview.
3. [ ] Preview site: the footer says **v0.11.0 · db 109**. **Settings → Diagnostics → Test connection**
   is green and its last line ends with `scanner-ingest-1`.

---

## Stage 1 · The bare board (test firmware, `env:esp32_fake`)

The test firmware pretends to have a reader and a keypad. You "scan" by typing in the Serial Monitor.

### 1.1 Flash and connect
1. [ ] [setup.md](setup.md) Part 1 with **`env:esp32_fake`**.
2. [ ] Preview site → **Settings → Devices → Bin scanners** → name `Test scanner` → **Add scanner** →
   copy the key.
3. [ ] The Serial Monitor prints `[NET] Wi-Fi setup: join Gedara-Bin-XXXX with password ########`.
   Follow [setup.md](setup.md) Part 2 with the server **gedara-staging**.
4. [ ] Serial Monitor: `[NET] gedara-staging: OK - 0 scan(s) sent, Gedara answered` and
   `[NET] names list: N entries`. Preview site: **Test scanner · Online**.

### 1.2 A test product (on the preview site)
1. [ ] **Pantry → New product**. Name: `Test yoghurt`. **Counted in: pcs**. Save.
2. [ ] Open it → **Barcodes** → add `2000000000015`. Then **Add stock**: 6.
3. [ ] Open **Pantry → Bin scanner** on the phone and leave another Gedara page open on the iPad.
4. [ ] Serial Monitor: type `sync` (so the scanner learns the new name).

### 1.3 The done-when, pretend version
1. [ ] Type `scan 2000000000015`.
2. [ ] Serial Monitor: `[SOUND] tick`, `[OLED] Test yoghurt | ...`, then within about a second
   `[OLED] Test yoghurt | 5 left` and `[SOUND] used`. The iPad shows a pop-up **Test yoghurt −1 · 5 left**.
3. [ ] Tap **Undo** on the pop-up. Stock is 6 again.
4. [ ] `key 3` then `scan 2000000000015` → **3 left**.
5. [ ] `key *` → `[OLED] Test yoghurt | undone | 6 left`.

### 1.4 The modes
1. [ ] `key B` → `[OLED] mode B ADD`. `scan 2000000000015` → **7 left**, `[SOUND] added`.
2. [ ] Wait 30 seconds. `[MODE] back to USED` appears by itself.
3. [ ] `key C`, `scan 2000000000015` → **opened**.
4. [ ] `key #`, `scan 2000000000015` → only shows what is left; the stock doesn't change.
5. [ ] `key D`, `scan 2000000000015` → **counted as waste**.

### 1.5 A barcode Gedara doesn't know
1. [ ] `scan 2000000000022` → `[OLED] New barcode | 2000000000022 | Saved for you.`
2. [ ] Phone → **Pantry → Bin scanner → Needs you → Link to a product** → `Test yoghurt` →
   **Link and apply**. The stock goes down by one.
3. [ ] `scan 2000000000022` again → it just works.

### 1.6 No internet (the offline queue)
1. [ ] `offline on`.
2. [ ] `scan 2000000000015` twice (wait 3 seconds between them). You see `saved - 1 waiting`,
   then `saved - 2 waiting`.
3. [ ] `offline off`. Within a few seconds: `[NET] gedara-staging: OK - 2 scan(s) sent`. The
   Bin-scanner page shows both, in order, and the stock went down by exactly 2.

### 1.7 Commands and an update
1. [ ] Preview → **Settings → Devices → Test scanner** → **Test beep**, then type `sync` (that is the
   **#** key). Serial Monitor: `[SOUND] boot`.
2. [ ] **Find it**, `sync` → `[OLED] Here I am`.
3. [ ] **Pause this scanner**, `sync`, `scan 2000000000015` → `[OLED] Paused | The scan is kept.`
   Then **Resume and apply them**.
4. [ ] Update: [setup.md](setup.md) Part 6 with `0.1.1` and **`env:esp32_fake`** (the file is in
   `.pio\build\esp32_fake\`). After **Install**, type `sync`. It restarts and the page says **0.1.1**.

**Send me:** the Serial Monitor text from 1.3 to 1.7 (select all, copy, paste). Then go to Stage 2.

---

## Stage 2 · The bench (everything wired, nothing built yet)

> **Always unplug the USB cable before you connect or move any wire.**

Picture: [wiring.svg](wiring.svg). Table: [pins.md](pins.md). Connect **one part at a time**, in this
order, and test after each. Then a wrong wire shows up at once.

### 2.1 Switch to the real firmware
1. [ ] VS Code bottom bar → **env:esp32_fake** → choose **env:esp32** → click **→** (Upload) → **SUCCESS**.
2. [ ] Click **🔌**. You'll see `reader MISSING  screen MISSING`. **Expected**: nothing is connected yet.

### 2.2 OLED
1. [ ] Unplug. OLED: **VCC → 3V3**, **GND → GND**, **SDA → D21**, **SCL → D22**.
2. [ ] Plug in. The screen shows the ribbons and **G E D A R A**, then the clock and **A USED**.

### 2.3 Keypad
1. [ ] Unplug. Keypad pins 1–8 → **D13, D14, D27, D26, D25, D33, D32, D4** (pins.md).
2. [ ] Plug in. Press **B**: the screen goes white and says **B ADD**. Press **A**: back to **USED**.
3. [ ] Press **1 2 3 … 9 0 \* #** one by one and watch the Serial Monitor: each line names the key
   you pressed (`[KEY] …`), and the numbers show as `x3` on the screen.
   - A different key shows up? Preview → the scanner → **Keypad cable** → try another choice →
     **Save** → press **#**. Repeat until 1 is 1 and D is D.

### 2.4 Buzzer
1. [ ] Unplug. Buzzer **+ → D18**, **− → GND** (a 3-pin module: also VCC → 3V3).
2. [ ] Plug in: the start-up tune (three rising notes). Press **B**: a rising run. Press **A**: two notes down.
   - Only a harsh buzz? It is an active buzzer: preview → the scanner → **Buzzer: Active** → Save → #.

### 2.5 The barcode reader
1. [ ] Unplug. Reader: **pin 6 VCC → 3V3** (never VIN), **pin 3 GND → GND**, **pin 5 TXD → RX2**,
   **pin 4 RXD → TX2**. Put the 100 µF capacitor (long leg to VCC) and the 100 nF one across the
   reader's VCC and GND.
2. [ ] Plug in. The Serial Monitor says `reader ok  screen ok`. (MISSING: swap the RX2 / TX2 wires once.)
3. [ ] Move your hand in front of the reader: its lamp comes on for a moment, then goes off.
4. [ ] Hold the `Test yoghurt` barcode (any real product you gave that test barcode, or print
   `2000000000015` as a barcode) 10–20 cm in front: tick, name, **N left**.
5. [ ] Print or open on the phone one of Gedara's own labels (a product's `HL:PRD` QR): it reads too.

### 2.6 Timing
1. [ ] Scan five packs, a few seconds apart. Preview → the scanner → **Last answer took**: note the
   number after each.
2. [ ] Leave it for 10 minutes, scan once more, note that number too (the first one after a pause is slower).

**Send me:** a photo of the bench, the Serial Monitor start-up lines, and the numbers from 2.6.
**The bench stage is passed** when 2.2–2.5 all work on the preview site.

---

## Stage 3 · In its box, by the bin

1. [ ] Cut-outs in the box: the OLED (about 26 × 14 mm), the reader's window (a 20 mm hole behind the
   acrylic piece), a slot for the keypad's ribbon, a notch for the USB cable. The keypad sticks on
   the lid with its own adhesive.
2. [ ] Board on the screw-terminal board; the same wires as on the bench (pins.md). Keep the reader's
   wires short and the two capacitors right at the reader.
3. [ ] Mount it at hand height beside the bin, the reader tilted about 15°, not facing a window.
4. [ ] Plug the charger in. Start-up tune, clock, **A USED**.
5. [ ] Scan three different packs from where you would normally stand. Adjust the angle until it
   reads without you having to aim.
6. [ ] At night: check the lamp only comes on when something moves in front of it. Too bright or
   too often? Settings → **How it watches → Only after a key**, or tick **In quiet hours, only after
   a key press**.

**Send me:** a photo of it mounted.

---

## Stage 4 · A week of real use (still the preview site)

Use it for everything that goes in the bin. Once a day, open **Pantry → Bin scanner** and clear
**Needs you**. Note for me:

- [ ] packs it could not read (which, and what the barcode looks like: curved, foil, tiny);
- [ ] wrong amounts ("it took a whole pack but half was left"), with the product's name;
- [ ] anything that landed on the shopping list that shouldn't have;
- [ ] times it was in the wrong mode;
- [ ] sounds or light that annoyed anyone, and at what time;
- [ ] the scanner's page: **Scans waiting on it** should be 0, **Last restart** `poweron`.

**Send me** the list after a week (or earlier if something is plainly wrong). I adjust, you update
the firmware from the website (Stage 6).

---

## Stage 5 · Go live (production)

Do these **in this order** on the PC, in a terminal in the `gedara-handoff` folder.

1. [ ] Database to production (type `Y` when asked):
   ```bash
   npx --yes supabase@2.121.0 db push --project-ref ltzlsxupcsamwtgqfejg
   ```
2. [ ] The scanner's server function to production:
   ```bash
   npx --yes supabase@2.121.0 functions deploy scanner-ingest --project-ref ltzlsxupcsamwtgqfejg
   ```
3. [ ] The daily notification function (it now mentions the scanner):
   ```bash
   npx --yes supabase@2.121.0 functions deploy attention-push --project-ref ltzlsxupcsamwtgqfejg
   ```
4. [ ] Merge on GitHub (in the browser):
   1. Open **https://github.com/Ayesh1991/gedara** → **Pull requests** → **New pull request**.
   2. **base: main** ← **compare: phase-11** → **Create pull request**.
   3. Title: `Phase 11 Bin Scanner` → **Create pull request**.
   4. **Merge pull request** → **Confirm merge**.
5. [ ] Wait 2–3 minutes. Open **https://gedara.vercel.app**: the footer says **v0.11.0 · db 109**.
   **Settings → Diagnostics → Test connection** is all green.
6. [ ] Real site → **Settings → Devices → Bin scanners** → name `Bin scanner` → **Add scanner** →
   **copy** the key.
7. [ ] On the scanner, hold **A + D** for 10 seconds. The screen shows **Wi-Fi setup**.
8. [ ] Phone: join that network → the setup page → **Configure WiFi** → choose your home Wi-Fi and
   type its password again → paste the **new** key → **Server: gedara** → **Save**.
9. [ ] The scanner restarts. The real site shows **Bin scanner · Online**.
10. [ ] Preview site → **Test scanner** → **Remove this scanner**.
11. [ ] Stock the cupboard the quick way: press **B twice** (Add stays for 5 minutes) and scan each
    pack you have. New barcodes wait under **Needs you**: link each once.

---

## Stage 6 · Firmware updates (later)

1. [ ] VS Code: open `src/version.h` and raise the number (`0.1.0` → `0.1.1`). Save.
2. [ ] Bottom bar **env:esp32** → click **✓** (Build) → **SUCCESS**.
3. [ ] The site → Settings → Devices → the scanner → **Firmware → Upload firmware.bin** → choose
   `devices\bin-scanner\.pio\build\esp32\firmware.bin`.
4. [ ] Tap **Install**, then press **#** on the scanner. A progress bar, a restart, and the page
   shows the new version. If the new version can't reach Gedara within 2 minutes, it goes back to
   the old one by itself.

Stuck anywhere? [troubleshooting.md](troubleshooting.md), or send me the scanner's log (Settings →
Devices → the scanner → Log).

# Kitchen scale: everything after the staging connection

Work through the stages in order. Tick each box as you go. After each **"Send me"** line, paste the
Serial Monitor text or a photo into the chat before you go on.

| Stage | What | You need | Where |
|---|---|---|---|
| 1 | Finish the bare-board test on staging | the board on USB | preview site + VS Code |
| 2 | Wire everything on a breadboard (bench test) | all parts, jumper wires | VS Code + preview site |
| 3 | Build the real scale | plates, spacers, bolts, tools | your bench |
| 4 | The real sugar-jar test on staging | the finished scale | preview site + iPad |
| 5 | Go live on gedara.vercel.app | PC, GitHub | terminal + GitHub + gedara.vercel.app |
| 6 | Set up your real jars | jars, NFC stickers, Android phone | gedara.vercel.app |
| 7 | Later: firmware updates | VS Code | gedara.vercel.app |

The **preview site** is https://gedara-git-phase-6b-ayeshmantha.vercel.app (staging data, safe to play
with). The **real site** is https://gedara.vercel.app. Don't mix them: a scale key from one site only
works on that site's server.

---

## Stage 1 · Finish the bare-board test (still `env:s3_fake`)

The test firmware pretends to have a load cell and a tag. You "put a jar on it" by typing in the
Serial Monitor. Click in the Serial Monitor, type each command, press **Enter**.

### 1.1 Online
- [ ] Serial Monitor shows `[NET] gedara-staging: OK - 0 reading(s) sent, Gedara answered`.
- [ ] Preview site → **Settings → Devices** → **Test scale** says **Online**, firmware **0.1.1**.
- [ ] Type `status`. It shows `server gedara-staging · … · online 1`.

### 1.2 A test product and a test jar (on the preview site)
1. [ ] **Pantry → New product**. Name: `Test sugar`. **Counted in: g**. Save.
2. [ ] **Places** → open **Kitchen** (any place is fine) → **Add a place inside**. Name: `Test jar`.
   Type: **Box**. Save.
3. [ ] On the **Test jar** page, find the **Kitchen scale** panel → **Holds** → choose **Test sugar**.
4. [ ] Open the **Pantry → Kitchen scale** page on the iPad or phone and leave it open.

### 1.3 Link a pretend tag and set the empty weight
1. [ ] On the Test jar page tap **Weigh empty on the scale**. A countdown appears.
2. [ ] Within 5 minutes, in the Serial Monitor type:
   ```
   put 04A1B2C3D4E5F6 400
   ```
   (a jar with tag `04A1B2C3D4E5F6` weighing 400 g, empty).
3. [ ] The Serial Monitor shows `[OLED] Test sugar | 400 g | empty weight saved` and
   `[SOUND] says: "Empty weight saved."`. The Test jar page shows **Empty weight 400 g** and a tag.
4. [ ] Type `lift`. The Serial Monitor shows `[OLED] Ready | 0 g`.

### 1.4 Fill it (first time)
1. [ ] Type `put 04A1B2C3D4E5F6 1212` (400 g jar + 812 g sugar).
2. [ ] The Kitchen-scale page asks **"812 g heavier than its stock. Where did it come from?"**
   Nothing of Test sugar is in the pantry yet, so it can't move anything in.
3. [ ] Tap **Count correction**. It says **Done — 812 g in the container**.
4. [ ] Type `lift`.

### 1.5 The done-when, pretend version
1. [ ] Type `put 04A1B2C3D4E5F6 1188` (24 g used).
2. [ ] Within about a second the Kitchen-scale page shows **Test sugar −24 g · 788 g left**, and the
   Serial Monitor shows `[SOUND] says: "minus twenty four grams"`.
3. [ ] Tap **Undo** on the card. It says **Undone**, and the Test jar's stock is back to 812 g.
4. [ ] Type `lift`.

### 1.6 No internet (the offline queue)
1. [ ] Type `offline on`.
2. [ ] Type `put 04A1B2C3D4E5F6 1180`, then `lift`, then `put 04A1B2C3D4E5F6 1170`, then `lift`.
   The `[OLED]` lines end with `(saved)` and `(queued)`, and you hear "Saved. I will send it later."
3. [ ] Type `status`. It shows `queue 2`.
4. [ ] Type `offline off`. Within a few seconds: `[NET] gedara-staging: OK - 2 reading(s) sent`.
   The Kitchen-scale page shows both readings, and the queue is 0.

### 1.7 Commands from Gedara
1. [ ] Preview → **Settings → Devices → Test scale** → **Test beep**. Within 30 s the Serial Monitor
   shows `[SOUND] chime: logged` and `says: "Ready."`.
2. [ ] **Find it** → `[OLED] Here I am …` and `chime: locate`.

**Send me:** the Serial Monitor text from 1.3 to 1.6 (select all, copy, paste). Then go to Stage 2.

---

## Stage 2 · The bench test (everything wired, nothing built yet)

> **Always unplug the USB cable before you connect or move any wire.**

Picture: [wiring.svg](wiring.svg). Table: [pins.md](pins.md). Connect **one module at a time**, in this
order, and test after each. Then a wrong wire shows up at once.

### 2.1 Load cell + HX711 (the most important part)
1. [ ] Put the load cell on two pieces of wood, Z-shaped (see [assembly.md](assembly.md) §1). Clamp
   or screw them down so nothing wobbles. Arrow on the cell pointing **down**.
2. [ ] Load cell wires → HX711: **red → E+**, **black → E−**, **white → A−**, **green → A+**.
3. [ ] HX711 → board: **VCC → 3V3** (NOT 5V), **GND → GND**, **DT → GPIO 4**, **SCK → GPIO 5**.

### 2.2 Switch to the real firmware
1. [ ] VS Code bottom bar → **env:s3_fake** → choose **env:s3**.
2. [ ] Plug in the USB cable → click **→** (Upload) → **SUCCESS**.
3. [ ] Click **🔌**. You'll see `[SELFTEST] scale ok  NFC MISSING …`. **NFC MISSING is expected**: the
   reader isn't connected yet. If it says **scale MISSING**, unplug and check the four HX711 wires.

### 2.3 Calibrate (you must do this now)
The real load cell needs its own numbers.
1. [ ] Preview site → **Settings → Devices → Test scale → Calibrate**.
2. [ ] **Step 1:** nothing on the scale → **Zero**.
3. [ ] **Step 2:** put a known weight in the middle (a calibration weight, or a bottle of water you
   weighed on another kitchen scale). Type its grams → **Calibrate**.
4. [ ] **Step 3:** put something else you know on it. "The scale sees" should match within 1–2 g.
   **Finish**.

### 2.4 Is it steady?
1. [ ] Nothing on it for 1 minute: the Serial Monitor `status` shows grams within ±0.5 g of 0.
2. [ ] Put the known weight on, take it off, 5 times: the same number each time, within 1 g.
3. [ ] Leave 1 kg on it for 5 minutes, then `status`: it moved less than ~1 g.

**Send me:** the `status` lines from 2.4. If the numbers jump around, I'll tune the filter.

### 2.5 OLED
1. [ ] Unplug. OLED: **VCC → 3V3**, **GND → GND**, **SDA → GPIO 1**, **SCL → GPIO 2**.
2. [ ] Plug in. The screen shows the self-test, then **Ready · 0 g**.

### 2.6 RC522 tag reader
1. [ ] Unplug. RC522: **3.3V → 3V3**, **GND → GND**, **SDA → GPIO 10**, **MOSI → GPIO 11**,
   **SCK → GPIO 12**, **MISO → GPIO 13**, **RST → GPIO 9**. IRQ: nothing.
2. [ ] Plug in. The self-test now says **NFC ok**.
3. [ ] Stick one **NTAG sticker** under a plastic box and put something in it (at least 50 g: the
   scale ignores anything under 8 g). Put the box on the load-cell board, right above the RC522
   (hold the reader under the board for now). The OLED says **New container · Link it in Gedara**.
4. [ ] On the Kitchen-scale page tap **Link to a container** → choose **Test jar** → **Link the tag**
   (it replaces the pretend tag from Stage 1).
5. [ ] The box weighs differently from the pretend jar, so on the **Test jar** page tap **Weigh empty
   on the scale** and put the box on again (emptied). Then put it back with something in it: the OLED
   says **Test sugar** and a weight.

### 2.7 Amplifier and speaker
1. [ ] Unplug. MAX98357A: **VIN → 5V**, **GND → GND**, **BCLK → GPIO 6**, **LRC → GPIO 7**,
   **DIN → GPIO 15**, **SD → GPIO 16**. GAIN: nothing. Speaker to **+ / −**.
   The 1000 µF capacitor across VIN–GND: long leg (+) to VIN.
2. [ ] Plug in. You hear the start-up chime and **"Ready."**.
3. [ ] Settings → Devices → Test scale → **Test beep**: you hear it.

### 2.8 Button (optional)
1. [ ] Button between **GPIO 14** and **GND**. A short press with nothing on the scale = zero.
   Hold 3 s = status on the OLED.

**Send me:** a photo of the bench and the Serial Monitor start-up lines. Then build it.

---

## Stage 3 · Build the scale

Follow [assembly.md](assembly.md) step by step. In short:

1. [ ] Base plate and top plate (200 × 200 mm, top **not metal**).
2. [ ] Load cell Z-mounted, 5 mm spacers, **50 mm behind the centre**, arrow down, nothing touching
   its middle.
3. [ ] RC522 on nylon standoffs, **centred under the top plate, 2–3 mm below it, never touching**,
   at least 15 mm from the load cell.
4. [ ] Draw a 60 mm circle on top, right above the RC522.
5. [ ] Electronics in a small box at the back. HX711 close to the load cell, speaker wires away from it.
6. [ ] The four checks in assembly.md §5: **corner test**, **creep test**, **tag test**,
   **repeatability**.
7. [ ] **Calibrate again** (Stage 2.3): mounting changes the numbers slightly.

---

## Stage 4 · The real sugar-jar test (still staging)

1. [ ] Preview site: give **Test sugar** a real jar. Stick an NTAG sticker in the centre of the jar's
   base. Link it: Android **Write tag**, or put it on the scale and **Link to a container**.
2. [ ] **Weigh empty on the scale** with the empty jar and its lid.
3. [ ] Fill it with sugar, put it on the circle → **Count correction**.
4. [ ] **The done-when:** open **Pantry → Kitchen scale** on the iPad. Lift the jar, take 2 spoons,
   put it back. Within ~2 s the iPad shows **Test sugar −24 g** (your number). The small grey
   number on the card is how long it took.
5. [ ] Do it 3 times. **Send me** the three times shown on the cards.

---

## Stage 5 · Go live (production)

Do these **in this order** on the PC, in a terminal in the `gedara-handoff` folder.

1. [ ] Database to production (type `Y` when asked):
   ```bash
   npx supabase db push --project-ref ltzlsxupcsamwtgqfejg
   ```
2. [ ] The scale's server function to production:
   ```bash
   npx supabase functions deploy scale-ingest --project-ref ltzlsxupcsamwtgqfejg
   ```
3. [ ] The daily notification function (it now mentions the scale):
   ```bash
   npx supabase functions deploy attention-push --project-ref ltzlsxupcsamwtgqfejg
   ```
4. [ ] Merge on GitHub (in the browser):
   1. Open **https://github.com/Ayesh1991/gedara** → **Pull requests** → **New pull request**.
   2. **base: main** ← **compare: phase-6b** → **Create pull request**.
   3. Title: `Phase 6b Kitchen Scale Station` → **Create pull request**.
   4. **Merge pull request** → **Confirm merge**.
5. [ ] Wait 2–3 minutes. Open **https://gedara.vercel.app**: the footer says **v0.7.5 · db 67**.
   **Settings → Diagnostics → Test connection** is all green.
6. [ ] Real site → **Settings → Devices → Kitchen scales** → name `Kitchen scale` → **Add scale** →
   **copy** the key.
7. [ ] On the scale, **hold the button 10 s** (or the board's BOOT button). The OLED shows
   **Wi-Fi setup**, a network name and a password.
8. [ ] Phone: join that network → the setup page → **Configure WiFi** → choose your home Wi-Fi and
   type its password again → paste the **new** key → **Server: gedara** → **Save**.
9. [ ] The scale restarts and says "Ready". The real site shows **Kitchen scale · Online**.
10. [ ] Real site → the scale → **Calibrate** (Stage 2.3 again, so the real site records it).
11. [ ] Preview site → **Test scale** → **Remove this scale** (it no longer has a board).

---

## Stage 6 · Your real jars (gedara.vercel.app)

For each jar (start with sugar):

1. [ ] Make sure the product is counted by weight: **Pantry → the product → Counted in: g or kg**
   (or a pack size like "1 pack = 1 kg").
2. [ ] **Places** → where the jar lives → **Add a place inside** → name `Sugar jar`, type **Box**.
3. [ ] Its page → **Kitchen scale** panel → **Holds: Sugar**.
4. [ ] Sticker in the centre of the base. Android phone: **Write tag** and hold it to the back of the
   phone. (No Android: skip; step 5 links it.)
5. [ ] **Weigh empty on the scale** → empty jar with lid on the circle → "Empty weight saved".
6. [ ] Fill it:
   - If the sugar pack is in Gedara's Pantry, the scale **moves it into the jar by itself**.
   - If not, choose **Count correction** the first time.
7. [ ] Steel tins: use an **on-metal** sticker.

Every day after that: lift, use, put back. The iPad on **Pantry → Kitchen scale** shows each result.

---

## Stage 7 · Firmware updates (later)

1. [ ] VS Code: open `src/version.h` and raise the number (`0.1.1` → `0.1.2`). Save.
2. [ ] Bottom bar **env:s3** → click **✓** (Build) → **SUCCESS**.
3. [ ] Real site → Settings → Devices → Kitchen scale → **Firmware → Upload firmware.bin** → choose
   `devices\kitchen-scale\.pio\build\s3\firmware.bin`.
4. [ ] Tap **Install**. The OLED shows a progress bar, the scale restarts, and the page shows the new
   version. If the new version can't reach Gedara within 2 minutes, it goes back to the old one by
   itself.

Stuck anywhere? [troubleshooting.md](troubleshooting.md), or send me the Serial Monitor text.

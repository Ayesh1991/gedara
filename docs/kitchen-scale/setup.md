# Kitchen scale — set it up, step by step

You need: the PC with **VS Code** (PlatformIO is already installed on it), a **USB-C data cable**, your
**Android phone** (or the iPad), and Gedara open on it.

> Staging or the real Gedara? A scale key made on a **preview** link (gedara-git-…vercel.app) works only
> with the server **gedara-staging**. A key made on **gedara.vercel.app** works only with **gedara**.
> For everyday use: gedara.vercel.app + gedara.

---

## Part 1 · Put the firmware on the board (once, by cable)

1. Open **VS Code**.
2. **File › Open Folder…** → go to `D:\Website development\home ledger\gedara-handoff\devices\kitchen-scale` → **Select Folder**.
   The first time, PlatformIO prepares the project for a minute (bottom-right corner shows progress).
3. Plug the board into the PC with the USB-C cable, into the port marked **UART** (some boards say **COM**).
4. In the blue bar at the bottom, find the item that says **`env:s3`** (or `Default`). Click it and choose:
   - **`env:s3`** for the real scale (everything wired), or
   - **`env:s3_fake`** for the bare board test (Part 6).
5. Click the **→ arrow** ("Upload") in the blue bar. Wait for **SUCCESS** in the terminal (1–3 minutes).
   - *"Failed to connect"* or *"No serial port"*: hold the board's **BOOT** button, press and release
     **RST** (or **EN**), release BOOT, then click → again.
6. Click the **plug icon** ("Serial Monitor") in the blue bar. You'll see lines like
   `[SELFTEST] scale ok  NFC ok | storage ok …`.

## Part 2 · Add the scale in Gedara and give it Wi-Fi

1. On the phone, open **gedara.vercel.app** → **Settings** → **Devices**.
2. Under **Kitchen scales**: type a name (e.g. `Kitchen scale`) → **Add scale**.
3. A key appears **once**. Tap the **copy** button next to it. (Leave this screen open until step 7.)
4. The scale's screen shows **Wi-Fi setup**, a network name like **Gedara-Scale-1A2B** and a **password**.
   (If it doesn't: hold the scale's button for **10 seconds**.)
5. On the phone: **Settings › Wi-Fi** → tap **Gedara-Scale-…** → type the password from the scale's screen.
6. A page opens by itself (if not, open the browser and go to **http://192.168.4.1**). Tap **Configure WiFi**:
   - pick **your home Wi-Fi** and type its password,
   - **Scale key from Gedara**: long-press → **Paste**,
   - **Server**: tap **gedara** (or **gedara-staging** for a preview test),
   - tap **Save**.
7. The scale restarts, chimes and says **"Ready."** Back in Gedara (reconnect the phone to your home Wi-Fi),
   the scale shows **Online** within a minute. Tap **I've copied everything**.

## Part 3 · Calibrate (once; again if you move or rebuild it)

1. Gedara → **Settings** → **Devices** → tap the scale → **Calibrate**.
2. **Step 1:** take everything off the scale → **Zero**. Wait for the tick.
3. **Step 2:** put something whose weight you **know exactly** in the middle of the plate. Type its weight
   in grams → **Calibrate**.
   - Best: a calibration weight (500 g or 1 kg).
   - Otherwise: a bottle of water weighed on another kitchen scale you trust; type that number.
   - An unopened 1 kg sugar pack is usually within a few grams, but not exact.
4. **Step 3:** put something else you know on it. The number at the top should match → **Finish**.

## Part 4 · The first container (the sugar jar)

1. Gedara → **Places** → open **Kitchen** (or where the jar lives) → **Add a place inside**.
   Name: `Sugar jar`. Type: **Box**. **Save**.
2. On the Sugar jar's page, in the **Kitchen scale** panel → **Holds** → choose **Sugar**.
   (Only products counted by weight can be chosen. If Sugar isn't there, open Sugar in Pantry and give it
   a weight unit: g or kg, or a pack size like "1 pack = 1 kg".)
3. Stick an **NFC sticker in the centre of the jar's base**.
4. **On the Android phone:** on the jar's page → **Write tag** → hold the sticker to the back of the phone
   until it says **Done**. (Now any phone opens the jar with a tap.)
   **No Android phone?** Skip this step. Step 5 links the sticker on the scale.
5. **Empty weight:** with the jar **empty** (lid on) → tap **Weigh empty on the scale** → within 5 minutes
   put the empty jar on the circle. The scale says **"Empty weight saved."**
6. **Fill it:** pour in the sugar and put the jar back on the scale.
   - If the sugar pack is in Gedara's Pantry, the scale moves that amount into the jar by itself.
   - If not, Gedara asks on the iPad/phone: **Move from pantry** · **Count correction** · **Later**.
     For a first fill, **Count correction** is right.

**From now on:** lift the jar, use what you need, put it back. The OLED shows **Sugar · 788 g · -24 g**,
the scale says *"minus twenty four grams"*, and the iPad on **Pantry › Kitchen scale** shows it.

## Part 5 · Updating the firmware later

1. Change `FW_VERSION` in `src/version.h` (e.g. `0.1.0` → `0.1.1`). Gedara only installs a **newer** version.
2. VS Code → click the **✓** ("Build") in the blue bar → **SUCCESS**.
3. Gedara → **Settings** → **Devices** → the scale → **Firmware** → **Upload firmware.bin** → choose
   `devices\kitchen-scale\.pio\build\s3\firmware.bin`.
4. Tap **Install** next to the new version. The scale shows a progress bar, restarts and reports the new
   version. If the new version can't reach Gedara within 2 minutes, it goes back to the old one by itself
   (Diagnostics then says *rolled_back*).

## Part 6 · Bare-board test (no wiring: Step D)

1. Part 1 with **`env:s3_fake`**, then Part 2 (use a **preview** key + **gedara-staging** for testing).
2. In the **Serial Monitor**, type a command and press Enter:
   - `put 04A1B2C3D4E5F6 1212`: a jar with that tag (UID) and 1,212 g on the scale. Link the tag on the
     iPad (Pantry › Kitchen scale → **Link to a container**) the first time.
   - `lift`: take it off.
   - `offline on` / `offline off`: pretend the internet is down (readings wait in the outbox, then go).
   - `status` · `sync` · `tare` · `reboot`.
   The OLED and the speaker are printed as `[OLED] …` and `[SOUND] …` lines.

## Buttons on the scale

| Do this | Happens |
|---|---|
| Short press (scale empty) | zero, and sync now |
| Hold 3 s | status: firmware, IP, Wi-Fi strength, queue |
| Hold 10 s | Wi-Fi setup again |
| Hold while plugging in, 5 s | forget Wi-Fi and key (calibration stays) |

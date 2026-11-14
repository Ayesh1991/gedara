# Bin scanner — set it up, step by step

You need: the PC with **VS Code** (PlatformIO is already installed on it), a **USB-C data cable**,
your phone, and Gedara open on it.

> Staging or the real Gedara? A scanner key made on a **preview** link (gedara-git-…vercel.app) works
> only with the server **gedara-staging**. A key made on **gedara.vercel.app** works only with
> **gedara**. Test on the preview first ([after-staging.md](after-staging.md)).

---

## Part 1 · Put the firmware on the board (once, by cable)

1. Open **VS Code** → **File › Open Folder…** → go to
   `D:\Website development\home ledger\gedara-handoff\devices\bin-scanner` → **Select Folder**.
   The first time, PlatformIO prepares the project for a minute (bottom-right corner shows progress).
2. Plug the board into the PC with the USB-C cable.
3. In the **status bar along the very bottom** of the window, find the item that says **`env:esp32`**
   (or `Default`). Click it and choose:
   - **`env:esp32_fake`** for the bare board (nothing wired; you type the scans), or
   - **`env:esp32`** for the real scanner (everything wired).
4. Click the **→ arrow** ("Upload") in that bottom bar. Wait for **SUCCESS** (1–3 minutes).
   - *"Failed to connect"* or *"No serial port"*: hold the board's **BOOT** button, click → again, and
     let go of BOOT when you see `Connecting....` change to `Writing`.
   - No port at all: Windows may need the **CP210x** driver (search "CP210x Universal Windows Driver",
     from Silicon Labs).
5. Click the **plug icon** ("Serial Monitor") in the bottom bar. You'll see a line like
   `[SELFTEST] … | reader ok  screen ok | storage ok  waiting 0 | names 0`.

## Part 2 · Add the scanner in Gedara and give it Wi-Fi

1. On the phone, open Gedara → **Settings** → **Devices**.
2. Under **Bin scanners**: type a name (e.g. `Bin scanner`) → **Add scanner**. (Owner only.)
3. A key appears **once**. Tap the **copy** button next to it. Leave this screen open until step 7.
4. The scanner's screen shows **Wi-Fi setup**, a network name like **Gedara-Bin-1A2B** and a
   **password**. (On the bare board they are printed in the Serial Monitor. If it doesn't show: hold
   **A + D** for 10 seconds, or the board's **BOOT** button for 10 seconds.)
5. On the phone: **Settings › Wi-Fi** → tap **Gedara-Bin-…** → type that password.
6. A page opens by itself (if not, open the browser and go to **http://192.168.4.1**). Tap
   **Configure WiFi**:
   - pick **your home Wi-Fi** and type its password,
   - **Scanner key from Gedara**: long-press → **Paste**,
   - **Server**: tap **gedara** (or **gedara-staging** for a preview test),
   - tap **Save**.
7. The scanner restarts and plays its start-up tune. Back in Gedara (reconnect the phone to your home
   Wi-Fi), it shows **Online** within a minute. Tap **I've copied everything**.

## Part 3 · The first scans

1. Pick something that is already in Gedara's Pantry **with a barcode** (open the product: its
   barcodes are listed). The scanner's screen is on the clock with **A USED** in the corner.
2. Hold the barcode **10–20 cm** in front of the scanner's window. Its lamp comes on by itself.
3. A tick at once, the name, then **5 left** and two notes going down. The phone shows a pop-up with
   **Undo**.
4. Try the keys:
   - **B**, then scan → **ADD** (white screen), one pack added. After 30 s it is back on **USED**.
   - **C**, then scan → the oldest pack is marked opened.
   - **#**, then scan → only shows what is left.
   - **3**, then scan → three at once.
   - **\*** → the last scan is taken back.

## Part 4 · A barcode Gedara doesn't know

1. Scan it. The scanner says **New barcode · Saved for you**. Nothing is lost.
2. In Gedara: **Pantry → Bin scanner**. Under **Needs you** tap **Link to a product**.
3. Choose the product. **One scan means**: leave `1` for things counted in pieces; for a pack with a
   size type it (e.g. `400` and `ml`). Tap **Link and apply**.
   - Not in Gedara yet? Tap **It isn't in Gedara yet: new product**. The normal new-product form
     opens with the barcode filled in (and looks it up on Open Food Facts). Save it, go back to
     **Pantry → Bin scanner** and tap **Apply**.
4. The waiting scans are applied, and from now on that barcode just works.

### Linking many at once (products from bills)

Products that came in from a scanned bill have no barcode yet. To give them one without using or adding
anything:

1. Keep the phone open on Gedara (any page).
2. Press **#** on the scanner, then scan a pack from the cupboard. The scanner says **Link it · on your
   phone · Nothing else changes**.
3. The phone shows **Link this barcode** with **Link to a product**. Tap it: under **Is it one of
   these?** Gedara lists the likely products, those with **no barcode yet** first. Tap the right one,
   check **One scan means** (filled in from the pack size when Open Food Facts knows it), tap **Link**.
4. Scan the next pack. **#** stays on for 30 seconds after each scan, so a whole shelf goes in one
   go; press **#** again if it went back to Used.

A barcode that is already linked just shows the name and how many are left.

## Part 5 · Settings (Gedara → Settings → Devices → the scanner)

| Setting | What it does |
|---|---|
| Volume, quiet hours | in quiet hours it only ticks softly and the screen is dim |
| Screen off in quiet hours | the screen goes dark after 30 s; any key or scan wakes it |
| How it watches | **Senses movement** (lamp only when something comes near) · Always · Only after a key · **IR sensor + light** (needs the IR sensor and LED, pins.md) · **Distance sensor + light** (needs the VL53L0X, pins.md; recommended) |
| White LED (distance sensor) | **Auto** (only when it helps; learned) · Always · Off |
| A pack counts within (distance sensor) | 12–40 cm (default 30) |
| Light the pack | IR sensor mode: the white LED lights the pack while it reads (on at most 4 s per pack) |
| How keenly it senses | Normal · **High** · Highest. Use Highest if it misses packs in a dim kitchen; go back a step if it lights up when nobody is there |
| Seconds before it goes back to Used | 10–120 |
| Buzzer | Passive (tunes) or Active (beeps) |
| Keypad cable | if pressing 1 shows another key |
| Pause / Resume | a paused scanner changes nothing |
| Undo all | takes back everything it did in the last 1 / 6 / 24 / 72 hours (owner) |

A saved setting reaches the scanner at its next call: **press # on the scanner** (or wait up to 30
minutes). The same goes for **Test beep**, **Find it** and firmware updates.

## Part 6 · Updating the firmware later

1. Change `FW_VERSION` in `src/version.h` (e.g. `0.1.0` → `0.1.1`). Gedara only installs a **newer** version.
2. VS Code → bottom bar **env:esp32** → click the **✓** ("Build") → **SUCCESS**.
3. Gedara → **Settings** → **Devices** → the scanner → **Firmware** → **Upload firmware.bin** → choose
   `devices\bin-scanner\.pio\build\esp32\firmware.bin`.
4. Tap **Install** next to the new version, then **press # on the scanner**. It shows a progress bar,
   restarts and reports the new version. If the new version can't reach Gedara within 2 minutes, it
   goes back to the old one by itself.

## Part 7 · Bare-board test (nothing wired)

With **`env:esp32_fake`** the board pretends to have a reader and a keypad. Click in the Serial
Monitor, type a command, press **Enter**:

| Type | Means |
|---|---|
| `scan 4792210100125` | a barcode was read |
| `key B` (also `A C D # * 0`–`9`) | a key press |
| `hold *` | * held 3 s (status) |
| `setup` | A + D held 10 s (Wi-Fi setup) |
| `offline on` / `offline off` | pretend the internet is gone / back |
| `status` | firmware, server, Wi-Fi, scans waiting |
| `server gedara-staging` / `server gedara` | switch server |
| `sync` | call Gedara now (like #) |

The screen and the sounds are printed as `[OLED] …` and `[SOUND] …` lines.

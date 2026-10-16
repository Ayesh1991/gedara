# The speaker as a network speaker (AirPlay + Bluetooth), click by click

Phase 7i. YouTube Music, or any app, on your phone or PC can play straight to the Gedara speaker,
without Gedara. Only one thing plays at a time: when a phone starts, Gedara's music pauses. Gedara
shows **"Playing from AirPlay · Didula's iPhone"**, and tapping Play there asks before taking the
speaker back.

| From | How | Needs |
|---|---|---|
| iPhone, iPad, Mac | **AirPlay** | nothing extra |
| Android phone, laptop, desktop PC | **Bluetooth** | a **USB Bluetooth adapter** in the Pi (the Pi 2 has none). The PC needs Bluetooth too: most laptops have it; a desktop may need its own USB adapter |
| The "cast" button in YouTube Music | not possible | it works only with Google's own Chromecast devices; use AirPlay or Bluetooth |
| Spotify Connect | left out | it needs Spotify Premium |

**What to buy for Bluetooth:** a small USB Bluetooth 4.0 or 5.0 adapter whose listing says it works
with **Linux / Raspberry Pi**. Adapters with a CSR8510 or Realtek RTL8761B chip are common and work.

---

## Stage A · Update the Pi (once)
1. [ ] If you have the USB Bluetooth adapter, plug it into a free USB port on the Pi.
2. [ ] VS Code → `gedara-handoff` folder → **Terminal → New Terminal**:
   ```powershell
   powershell -ExecutionPolicy Bypass -File devices/print-server/install.ps1 -Music
   ```
   **You should see:** `7/7 Network speaker: AirPlay and Bluetooth`, `AirPlay: "…" on the home network`, and
   `Bluetooth adapter found` (or a note that there is none), then **RESULT: OK**.
   It may show a pairing code again if the Pi isn't paired yet; type it in Gedara as before.

## Stage B · AirPlay (iPhone / iPad / Mac)
1. [ ] Phone on the **home Wi-Fi**.
2. [ ] Open YouTube Music and play a song.
3. [ ] Tap the **AirPlay** icon (in the player, or Control Centre → the music card → AirPlay) →
   choose your speaker's name (the one in Gedara, for example **"Living room speaker"**).
   **You should see:** the music comes from the speaker within a few seconds, and Gedara → Music shows
   "Playing from AirPlay".

## Stage C · Bluetooth (Android / laptop / PC)
1. [ ] Gedara → **Settings → Devices → your speaker** → **Network speaker** → **Let a phone or PC pair (2 min)**.
   **You should see:** "Pairing open: 120 s" counting down.
2. [ ] On the phone: **Settings → Bluetooth** → wait for your speaker's name → tap it.
   On Windows: **Settings → Bluetooth & devices → Add device → Bluetooth** → the speaker's name.
3. [ ] **You should see:** the device appears under the button as "Connected now". Play YouTube Music
   and it comes from the speaker.
4. [ ] Next time it reconnects by itself: just pick the speaker in the phone's Bluetooth list.
   Outside those 2 minutes nobody new can pair, and the speaker isn't visible.

## Stage D · Switching
- A phone starts playing → Gedara's music pauses by itself.
- In Gedara, tap **Play** → "Take the speaker back?" → **Play here** → the phone stops, and Gedara plays.
- To turn AirPlay or Bluetooth off: Gedara → the speaker → **Network speaker** → the switches.
- To remove a phone: the **✕** next to it in the list.

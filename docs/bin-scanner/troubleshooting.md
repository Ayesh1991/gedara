# Bin scanner — when something's wrong

Cheapest first: the scanner's own screen (hold **\*** 3 s for status) → Gedara **Settings › Devices ›
the scanner** (Wi-Fi, scans waiting, last problem, firmware, **its log**) → Gedara **Settings ›
Diagnostics** → the VS Code **Serial Monitor**.

| You see | Likely cause | Do this |
|---|---|---|
| **reader MISSING** at start; Gedara shows "Scanner eye: Not answering" | the reader's wires | VCC on **3V3**; scanner pin 5 (TXD) → **RX2**, pin 4 (RXD) → **TX2** (crossed is right); GND joined. Try swapping the RX2 / TX2 wires once |
| The reader's lamp never comes on | no power, or eye set to "Only after a key" | check 3V3 and GND at the reader; Settings › Devices › the scanner › How it watches |
| Lamp on, but no tick | the code is too close, too far, or glaring | 10–20 cm; tilt the pack a little; shiny foil: tilt more |
| It reads the same pack twice | the pack stayed in view | a repeat within 2.5 s is ignored; move it away after the tick |
| **screen MISSING** at start | OLED wiring | VCC 3V3, GND, SDA → **D21**, SCL → **D22**. Some OLEDs have VCC and GND swapped: read the print on yours |
| Screen dark at night | "Screen off in quiet hours" | press any key; or switch it off in the settings |
| Pressing 1 shows another key (or nothing) | the keypad's ribbon is the other way | Settings › Devices › the scanner › **Keypad cable**: try the other three choices, Save, press # on the scanner |
| One whole row or column of keys is dead | one keypad wire is loose | that row's or column's pin (pins.md) |
| No sound | volume 0, quiet hours, or the buzzer type | Volume; Buzzer: Passive ↔ Active; buzzer + on **D18** |
| Only a harsh buzz instead of tunes | an **active** buzzer set as passive | Buzzer: **Active** (or buy a passive one for tunes) |
| **New barcode · Saved for you** | Gedara doesn't know it yet | Pantry › Bin scanner › Needs you › **Link to a product** |
| **Not a pantry item** | a place / Thing label, or some other QR code | nothing was changed |
| **none left · + on the shopping list** | Gedara had no stock of it | right if it was the last one. Still have some? Tap **I still have some…** on the pop-up and set the count |
| **already in jar** | the product lives in a kitchen-scale jar and the scale already counted this pack | nothing to do |
| **A bill just added this** | Add scanned within 3 days of a bill with the same product | Pantry › Bin scanner › Needs you: **Add 1 more** or **Ignore** |
| **saved · N waiting** / **wifi !** | no internet or Gedara unreachable | scans are safe on the scanner; they go when it's back, in order |
| **Paused · The scan is kept** | someone paused it, or it scanned too much too fast | Settings › Devices › the scanner: read why, then **Resume** (owner). If it wasn't you: **Undo all**, then **Remove this scanner** and add it again with a new key |
| Log: **DNS Failed** … *can't reach it*, although Wi-Fi is connected | the router's name server isn't answering (seen 11 Nov 2026: "Query refused") | firmware 0.1.0 from 11 Nov on switches to 8.8.8.8 / 1.1.1.1 by itself (log: *the router's name server doesn't answer*). Restarting the router usually cures the router |
| **Key not accepted** | scanner removed in Gedara, or a staging key on gedara (or the reverse) | add it again, hold **A + D** 10 s, paste the new key, pick the right server |
| Log: `[NET] server gedara` but the key was made on the preview site | the server field was left on **gedara** in the Wi-Fi setup | Serial Monitor: type `server gedara-staging` (or hold A + D 10 s and choose it) |
| **Server not found** | the server in the Wi-Fi setup doesn't have the scanner function yet | preview = **gedara-staging**; gedara.vercel.app = **gedara** (after going live) |
| Wi-Fi setup page doesn't open | the phone stayed on mobile data | turn mobile data off for a minute, or open http://192.168.4.1 |
| Test beep / Install / new settings do nothing | the scanner hasn't called yet | **press # on the scanner** (it only calls on a scan, on #, and every 30 minutes) |
| "5 left" takes 2–3 s on the first scan after a long pause | the secure connection has to start again | normal; the tick and the name are instant, later scans answer in about a second |
| Update says **rolled_back** | the new firmware couldn't reach Gedara | the old one runs again; check the build, try again |
| It restarts by itself (log: brownout) | the charger or cable is weak | another charger (1 A or more) and a short, thick cable |

**Serial Monitor:** `status` prints firmware, server, IP, Wi-Fi, scans waiting, names, eye. `sync`
calls Gedara now.

**Forget Wi-Fi and key:** hold the board's **BOOT** button while plugging it in, for 5 seconds.

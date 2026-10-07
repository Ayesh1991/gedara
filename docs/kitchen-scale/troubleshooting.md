# Kitchen scale — when something's wrong

Cheapest first: the scale's own screen → Gedara **Settings › Diagnostics** (Kitchen scale card) → the
scale's page in **Settings › Devices** (Wi-Fi, queue, last problem, firmware) → the VS Code **Serial Monitor**.

| You see | Likely cause | Do this |
|---|---|---|
| **scale MISSING** at start | HX711 not powered / DT-SCK swapped | check VCC is on **3V3**, DT → GPIO 4, SCK → GPIO 5 |
| **NFC MISSING** at start | RC522 wiring or 5 V | 3.3 V only; SS 10, MOSI 11, SCK 12, MISO 13, RST 9 |
| Weight goes **negative** when loaded | A+ / A− swapped | swap the two signal wires, or just calibrate again (the sign is learned) |
| Weight **jumps** or never settles | something touches the plate or cell; wires near the speaker | corner test (assembly.md §5); twist and shorten the load-cell wires |
| Drifts away from 0 when empty | creep / temperature | auto-zero handles ±50 g; if it says **Please empty**, empty it and press the button |
| **Too heavy** | over 5 kg | keep bulk rice in the pantry, refill a smaller jar |
| Container shows **No tag** | sticker too far from the antenna, or on metal | put it inside the circle; on steel tins use on-metal stickers; thick glass: coaster |
| **New container — link it in Gedara** | a sticker no container has | iPad: Pantry › Kitchen scale → **Link to a container** |
| **Set its empty weight** | the container has no empty weight | its page → **Weigh empty on the scale** |
| **heavier: check Gedara** | refilled but nothing in the pantry to move from | iPad: **Move from pantry** (after importing the bill), **Count correction**, or **Later** |
| **Lighter than empty — lid off?** | weighed without the lid it was tared with | put the lid on, or set the empty weight again |
| **queue N** stays above 0 / **wifi !** | no internet or Gedara unreachable | readings are safe on the scale; they go when it's back. Check the router; Diagnostics shows the last error |
| **Key not accepted** | scale removed in Gedara, or a staging key on gedara (or the reverse) | add the scale again, hold the button 10 s, paste the new key, pick the right server |
| Wi-Fi setup page doesn't open | phone stayed on mobile data | turn mobile data off for a minute, or open http://192.168.4.1 |
| Calibration **not_steady** | the plate moved | keep the weight still for 3 seconds, try again |
| Calibration **no_weight** | nothing heavy enough on it | use at least 50 g (500 g–1 kg is best) |
| Update says **rolled_back** | the new firmware couldn't reach Gedara | the old one runs again; check the build, try again |
| Card on the iPad is slow | Wi-Fi weak (see dBm), or the iPad page was asleep | keep the screen on (Pantry › Kitchen scale → Keep the screen on); move the router or the scale |

**Serial Monitor:** `status` prints firmware, IP, Wi-Fi, queue, weight and calibration. `sync` sends now.

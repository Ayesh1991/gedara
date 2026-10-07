# Kitchen scale — mechanical assembly

Do this **after** the bench test (Step E): the electronics on a breadboard, the load cell on a temporary
board, readings steady and calibrated. Then build it properly as below.

```
 side view (not to scale)
                 jar ── NTAG sticker in the centre of its base
   ┌──────────────────────────────────────┐   top plate (200×200, 5 mm acrylic) ← weighed
   └──────────▲──────────────────▲────────┘
              │ ≥ 2 mm air gap    │ spacer (5 mm)
         ┌────┴────┐        ┌────┴──────────────┐
         │ RC522   │        │ load cell  ← arrow points DOWN
         │ on M3   │        └──────────────┬────┘
         │standoffs│               spacer  │ (5 mm)
   ══════╧═════════╧═══════════════════════╧════════  base plate (fixed)
```

## 1 · The load cell ("Z-mount")

1. Look at the load cell: an **arrow** on one side shows the direction of the force. It must point **down**.
2. Choose where it goes: **left to right, about 50 mm behind the centre** of the base. The front-centre stays
   free for the RC522 (step 2).
3. Bolt **one end** of the cell to the **base**, with a **5 mm spacer between the cell and the base**. The
   cell must be able to bend: only its end block touches the spacer.
4. Bolt the **other end** to the **top plate**, with a 5 mm spacer **between the cell and the plate**.
5. Check the bolts don't reach the middle of the cell (the part with the white glue / strain gauges).
   Nothing may touch the middle of the cell.
6. Single-point cells are made for loads off-centre, so the plate doesn't have to sit centred on the cell.

## 2 · The RC522 (under the plate, not touching it)

1. Mount the RC522 on four **nylon standoffs on the base**, **centred under the middle of the top plate**.
2. Choose standoff length so the board's top is **2–3 mm below the underside of the top plate**. It must
   **never touch** the plate: when the plate is loaded it moves down a fraction of a millimetre. A touch
   would take part of the weight.
3. Keep the antenna (the copper loop) **at least 15 mm from the aluminium load cell**. Metal close to the
   antenna weakens it.
4. Draw or engrave a **circle (60 mm) on top of the plate**, right above the antenna: "put containers here".

## 3 · The tags

- One **NTAG213/215 sticker in the centre of each container's base**, flat (on a domed base, in the recess).
- Read range through 5 mm acrylic + 2–3 mm air + the jar's base is about 2–3 cm. Very thick glass bases
  may be too far: put the sticker on a thin coaster glued under the jar instead.
- **Steel tins:** use **on-metal (ferrite) stickers**. A normal sticker on steel doesn't read.

## 4 · Electronics box

- The DevKit, amplifier and capacitor in a small box **behind** the scale. The **HX711 close to the load
  cell** (short, twisted wires). Keep load-cell and HX711 wires **away from the speaker wires**.
- The OLED at the front edge (a short 4-wire cable), the speaker facing out of the box, the button where
  you can reach it.
- Strain relief on the USB cable, so pulling it can't move the plate.

## 5 · Checks before closing it up

1. **Corner test:** put the same 500 g weight in the middle and then near each corner. The readings should
   agree within ±1 g. If not, something touches the plate or the cell: the RC522, a wire, a bolt.
2. **Creep test:** leave 1 kg on it for 5 minutes. It should drift less than ~1 g, and come back to 0 when
   lifted. Auto-zero handles the rest.
3. **Tag test:** put each container down a few times in different positions inside the circle. The OLED
   should show its name every time.
4. **Repeatability:** put the sugar jar down and lift it 10 times. Gedara should say "No change" each time
   (differences below 2 g are noise).

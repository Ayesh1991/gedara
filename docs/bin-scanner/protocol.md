# Bin scanner ↔ Gedara protocol (v1)

One endpoint: `POST https://<project>.supabase.co/functions/v1/scanner-ingest`, header
`X-Gedara-Device: <43-character key>`. `GET` returns `{ok, fn_version, protocol, db}` (Diagnostics).
Schemas: `supabase/functions/_shared/scanner/protocol.ts` (Zod; shared by the function, the web app
and the simulator). Database side: `rpc_scanner_sync` (migration 108, service role only).

## Security

- The scanner holds **no Supabase key**, only its own key. Gedara stores **only its sha256**, in
  `scanner_token` (no client access; a separate table, so a scanner's key is refused by the scale's
  endpoint and the other way round). The owner adds and removes scanners; a removed key fails at
  once (401).
- **The household comes from the key, never from the request.**
- The scanner can ask for exactly this: `use`, `add`, `open`, `waste`, `check` of a scanned code, and
  `undo` of **its own last scan** (within 10 minutes). Nothing about money, nothing is deleted, no
  other device, no other household. Commands *to* the scanner: `beep`, `identify`, `reboot`, `ota`.
- Stock changes only as `stock_movement` rows, through the same private cores the app's RPCs use
  (`stock_take`, `stock_new_lot`, `stock_transfer_core`, `stock_open_core`, `stock_undo_core`).
- **A scanned code is untrusted** (a QR code can contain anything): 1–96 printable ASCII characters,
  enforced on the device (`lib/binlogic/gm861`), by Zod, and again in SQL; compared only against
  exact patterns; stored and shown as plain text.
- HTTPS is verified against pinned **root** certificates (`devices/shared/lib/gedara_device/src/roots.h`).
- Bodies ≤ 16 KB, ≤ 20 events per request. Logs never contain the key or a scanned code.

### Limits (a wrong or stolen key must not be able to empty the pantry)

| Limit | What happens |
|---|---|
| 120 events per 10 minutes | `GDRTE` → HTTP 429; the scanner waits a minute |
| 20 stock-changing scans within a minute (by scan time) | the scanner is **paused** |
| 150 packs in 24 hours | paused |
| 50 packs **added** in 24 hours | paused |
| 20 pieces per scan | the number keys stop at 20 |

**Paused** = scans are stored with status `held` and change nothing; the owner's phones get a push
alert at once and the Attention list shows it. The owner resumes on the scanner's page (apply or
drop the held scans). **Undo everything since…** on the same page takes back all of a scanner's scans
in a time window. A member can pause a scanner; only the owner resumes.

## Request

```jsonc
{
  "v": 1, "fw": "0.1.0",
  "epoch": 3735928559,   // random 32-bit id made when the scanner's flash is new
  "boot": 42, "up": 1234567,
  "status": { "rssi": -61, "heap": 181234, "queue": 0, "reset": "poweron", "time_ok": true,
              "ip": "192.168.1.41", "ota": "installed:0.1.1", "latency_ms": 640, "eye": "sense", "names": 212 },
  "events": [
    { "seq": 1201, "b": 42, "t": 1230100, "at": 1762770000123, "type": "scan", "mode": "use", "code": "4792210100125" },
    { "seq": 1202, "b": 42, "t": 1231900, "at": 1762770001900, "type": "scan", "mode": "add", "n": 3, "code": "HL:PRD:7K2P9Q" },
    { "seq": 1203, "b": 42, "t": 1233000, "type": "undo" }
  ],
  "done": [ { "id": "<command uuid>", "ok": true, "result": { "version": "0.1.1" } } ],
  "cat_v": "a1b2c3d4",
  "log": [ { "t": 1230000, "m": "[SCAN] use x1: Highland Yoghurt (seq 1201)" } ]
}
```

## Reply

```jsonc
{ "ok": true, "fn_version": "scanner-ingest-1",
  "acked": [1201, 1202, 1203],
  "results": [ { "seq": 1201, "status": "used", "name": "Highland Yoghurt", "dn": "Highland Yoghurt",
                 "unit": "pcs", "sized": false, "pack": 1, "qty": -1, "left_qty": 5, "on_list": false } ],
  "commands": [ { "id": "…", "command": "beep", "args": {} } ],
  "config": { "v": 3, "volume": 60, "quiet_from": "22:00", "quiet_to": "06:00", "eye": "sense",
              "eye_quiet": "same", "mode_s": 30, "buzzer": "passive", "bright": 80, "night_off": true,
              "keymap": "123A456B789C*0#D", "tz_offset_min": 330 },
  "cat": { "v": "a1b2c3d4", "items": [ ["4792210100125", "Highland Yoghurt"] ] },
  "paused": false,
  "next_ms": 1800000, "server_time": 1762770000456 }
```

`cat.items` (the names list: barcode or `HL:PRD` code → name, plain ASCII, ≤ 24 characters, ≤ 400
entries) is only sent when `cat_v` changed. `dn` is the name for the scanner's screen.

Statuses: `used` · `wasted` · `opened` · `added` · `moved` (pack moved into its scale jar) · `in_jar`
· `no_stock` · `nothing_to_open` · `checked` · `not_pantry` · `undo` · `undo_none` · `error`, and three
that wait for a person: `unknown` (barcode not linked), `bill_guard` (a bill just added it), `held`
(paused).

## Log budget: no polling

Supabase's log quota is Gedara's tightest, so the scanner calls **only**:

1. when something was scanned (one request per scan, or one per batch of up to 20 after being offline);
2. when **#** or the BOOT button is pressed;
3. for a heartbeat every `next_ms` (30 minutes; 5 s only while a command from Gedara is waiting).

The function reaches Postgres directly (`_shared/db/direct.ts`), which the API gateway doesn't log,
and logs only errors and pauses. About 40 scans + 48 heartbeats a day ≈ 100 log rows ≈ 0.1–0.2 MB,
under half a percent of the quota. A command (update, test beep) therefore reaches the scanner at its
next call: press **#** on it.

## Scans: exactly once

- Every scan is written to the scanner's flash **before** it is sent (`src/outbox.cpp`: 128-byte
  records with CRC32 in 4 KB segments). It leaves only when its `seq` is in `acked`.
- `seq` comes from blocks of 64 reserved in NVS: after a crash numbers may **skip**, never **repeat**.
- Gedara stores each event once per **(device, epoch, seq)**. A resend returns the first answer with
  `replayed: true` and moves no stock.
- An event Gedara can't use is stored as `error` and **acked anyway**, so it can't block the queue. An
  event the function can't read at all (400 with `path: events.N`) is dropped by the scanner.
- Retries: 1 s doubling to 60 s with jitter. 429 waits 60 s. 401 waits 5 min and shows "Key not accepted".

## Time

SNTP (time.google.com, pool.ntp.org), or `server_time` if NTP fails. Gedara uses `at` when it is
within *now − 30 days … now + 60 s*; otherwise it estimates from the uptime within the same `boot`.
Order always follows `seq`.

## The reader (GM861S)

Set up over its serial line at every start (never by setup barcodes): serial output, CR after each
code, Code 128 on, same code ignored for 2.5 s, read for at most 3 s, and the read mode:

| Gedara's "eye" | GM861S mode (zone 0x0000 bits 1–0) |
|---|---|
| `sense` | induction (11): lamp off until the picture changes |
| `always` | continuous (10) |
| `key` | command-triggered (01): the firmware sends "read now" for 20 s after a key press |

Frames and the CRC are tested against the manual's own examples (`test/test_gm861`).

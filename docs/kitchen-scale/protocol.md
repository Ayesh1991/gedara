# Kitchen scale ↔ Gedara protocol (v1)

One endpoint: `POST https://<project>.supabase.co/functions/v1/scale-ingest`, header
`X-Gedara-Device: <43-character key>`. `GET` returns `{ok, fn_version, protocol}` (Diagnostics).
Schemas: `supabase/functions/_shared/scale/protocol.ts` (Zod; shared by the function, the web app and the
simulator). Database side: `rpc_scale_sync` (migration 65, service role only).

## Security

- The scale holds **no Supabase key**, only its own key. Gedara stores **only its sha256** (`device_token`, no
  client access). The owner adds and revokes scales; a revoked key fails at once (401).
- HTTPS is verified against pinned **root** certificates (`src/roots.h`: GTS R1/R3/R4, ISRG X1/X2, from
  the Mozilla bundle by `tools/make-roots.py`), so certificate renewals don't matter.
- Every field is bounded twice: by Zod in the function, then again in SQL. Bodies ≤ 16 KB, ≤ 20 readings per
  request, ≤ 600 readings per 10 minutes per scale (`GDRTE` → 429). Logs never contain the key.

## Request

```jsonc
{
  "v": 1, "fw": "0.1.0",
  "epoch": 3735928559,   // random 32-bit id made when the scale's flash is new
  "boot": 42,            // boot counter
  "up": 1234567,         // uptime ms now
  "status": { "rssi": -61, "heap": 181234, "heap_min": 160000, "queue": 0, "reset": "poweron",
              "cal": { "factor": -412.37, "zero": 84213 }, "time_ok": true, "err": null,
              "ip": "192.168.1.40", "fs_free": 1900000, "ota": "installed:0.1.1", "latency_ms": 640 },
  "events": [ { "seq": 1201, "b": 42, "t": 1230100, "at": 1759480000123, "type": "weigh",
                "uid": "04A1B2C3D4E5F6", "ndef": "HL:LOC:7K2P9Q", "gross_g": 1188.4 } ],
  "live":   { "state": "settling", "uid": "04A1B2C3D4E5F6", "gross_g": 1180.2 },   // best effort
  "done":   [ { "id": "<command uuid>", "ok": true, "result": { "factor": -412.37 } } ],
  "containers_v": "a1b2c3d4"
}
```

## Reply

```jsonc
{ "ok": true, "fn_version": "scale-ingest-1",
  "acked": [1201],
  "results": [ { "seq": 1201, "status": "consumed", "name": "Sugar", "container": "Sugar jar",
                 "net_g": 788.4, "delta_g": -24.0, "moved_g": -24.0, "left_g": 788.4 } ],
  "commands": [ { "id": "…", "command": "calibrate", "args": { "known_g": 1000.0 } } ],
  "config": { "v": 3, "volume": 60, "quiet_from": "22:00", "quiet_to": "06:00", "voice": true,
              "threshold_g": 2, "tz_offset_min": 330 },
  "containers": { "v": "a1b2c3d4", "items": [ { "uid": "04A1…", "name": "Sugar", "tare_g": 400, "holds": true } ] },
  "poll_ms": 30000, "server_time": 1759480000456 }
```

`items` is only sent when `containers_v` changed. `poll_ms` is 1000 while someone watches the scale
(calibration) or a command is waiting, else 30 000.

## Readings: exactly once

- Every stable weighing is written to the scale's flash **before** it is sent (`src/outbox.cpp`: 64-byte
  records with CRC32 in 4 KB segments). It leaves only when its `seq` is in `acked`.
- `seq` comes from blocks of 64 reserved in NVS: after a crash numbers may **skip**, never **repeat**.
- Gedara stores each reading once per **(device, epoch, seq)**. A resend returns the first answer with
  `replayed: true` and moves no stock. A new `epoch` (erased flash) starts the numbering afresh.
- A reading Gedara can't use is stored as `error` and **acked anyway**, so it can't block the queue. A
  reading the function can't read at all (400 with `path: events.N`) is dropped by the scale.
- Retries: 1 s doubling to 60 s with jitter. 429 waits 60 s. 401 waits 5 min and shows "Key not accepted".

## Time

The scale sets its clock by SNTP (time.google.com, pool.ntp.org), or from `server_time` if NTP fails.
Gedara uses `at` when it is within *now − 30 days … now + 60 s*. Otherwise it estimates
`now − (up − t)` within the same `boot`, or uses the receive time with `time_estimated`. Order always
follows `seq`.

## What a weighing does (`private.scale_weigh`, migration 65)

`net = gross − the container's empty weight`, compared with the container's **stock** (its lots):

| net − stock | status | stock |
|---|---|---|
| ≤ −2 g (threshold, Settings) | `consumed` | taken from the jar's lots (FEFO), note "Kitchen scale" |
| between −2 and +2 g | `no_change` | nothing (the count is confirmed) |
| ≥ +2 g | `refilled` | moved in from the product's other lots |
| ≥ +2 g, more than there is elsewhere | `needs_decision` | what could be moved is; the rest waits: Move from pantry · Count correction · Later |
| net < −5 g | `below_tare` | nothing ("lid off?") |

Other statuses:
- `superseded`: a reading older than a later change to that jar. Recorded only.
- `unknown_tag`: a tag no container has.
- `tare_set`: "Weigh empty" armed; this reading became the empty weight, and an unknown tag was linked.
- `no_tare`, `no_product`: the container still needs setting up.
- `error`

An unknown tag whose NDEF URL names one of the household's containers is linked automatically.

## Commands

| command | args | the scale replies |
|---|---|---|
| `tare` | — | `{zero}` |
| `calibrate` | `{known_g}` (50–5000) | `{factor, zero, known_g}` or `{error: not_steady / no_weight}` |
| `beep`, `identify` | — | `{}` |
| `reboot` (owner) | — | `{}`, then restarts |
| `ota` (owner) | `{version, sha256, size, url}` (link signed for 10 min) | `{version}` or `{error}`, then restarts into the new firmware |

## Weighing on the scale (`lib/weighing`)

HX711 at 10 samples/s → saturation codes dropped → median of 5 → average of 4 → grams.

- **Stable** = 6 samples within 1 g, at least 0.6 s after the load arrived. It is emitted once.
  While the jar stays on the plate, a new value is emitted only after a ≥ 2 g change that stays 3 s.
- **Samples taken while the NFC field is on are ignored** (the field is only on for the tag read).
- **Removed** = below 3 g for 0.3 s.
- **Auto-zero** only when empty and steady for 2 s: ≤ 1.5 g per step, ≤ 50 g in total, then "please empty".
- **Overload** above 5,100 g.

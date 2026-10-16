# Music speaker protocol v1 (for developers)

The Pi's `gedara-media-agent` talks only to the Edge Function `media-agent` (`verify_jwt = false`).
Shapes: `supabase/functions/_shared/media/protocol.ts` (Zod; shared with the web app and the simulator
`devices/media-player/tools/sim.ts`). SQL: migrations 70–72.

## Pairing (no secret ever leaves the Pi)
1. The Pi makes a 43-character key, keeps it in `/etc/gedara-media/key` (0600, service user).
2. `POST {action:"pair_start", key_hash: sha256(key), hint: last 4 chars, agent}` → `{status:"waiting", code (8 digits), expires_at}`
   (same code if asked again; at most 3 waiting per caller IP hash, 100 in all → 429).
3. The owner types the code: `rpc_device_pair(household, code, name)` → a `device` (kind `media`) whose
   key hash is the Pi's, in `media_token` (no grants). Wrong codes are counted (10 per household per 10 min).
4. The Pi polls `POST {action:"pair_poll"}` with `X-Gedara-Device: <key>` → `{status:"paired", device_id, name, household}`.

## Sync
`POST {action:"sync", v:1, agent, up, wait?, status?, player?, done?, downloaded?, deleted?, pc_added?, pc_removed?, played?, art?, known?}`
with `X-Gedara-Device`.
- `wait:true` and nothing to report: the function holds the request for up to 25 s, checking for commands
  every 0.7 s (`rpc_media_pending`). The reply comes as soon as there is a command, or with
  `sync_now:true` when a song is waiting to be collected. About 1 invocation per 25 s.
- State changes (MPD `idle`) are reported at once by a second, short sync (`wait:false`).
- The reply carries:
  - `commands` (resolved: a `play` carries `queue: [{id, file}]` of songs on the card);
  - `downloads` (signed links, 15 min, with sha256 and size);
  - `deletions` (`{id, file}`);
  - `settings` and `schedules` when their version changed, and `tz`.
- Inbox objects the speaker no longer needs are deleted from Storage by the function (`media_inbox_trash`).

## Commands
`play` `pause` `resume` `stop` `next` `prev` `seek{s}` `volume{v}` (capped at `volume_max`)
`sleep{minutes, end_of_track, fade_s}` `shuffle{on}` `repeat{mode}` `queue_add{tracks, next}`
`queue_move{from,to}` `queue_remove{index}` `test_tone` `rescan`. A command not picked up in 60 s
expires. Volume and seek commands still waiting are replaced by the newest one.

## Songs
`media_track.state`: uploading → waiting → downloading → ready · failed · deleting.
- Uploads go to `media-inbox/<household>/<track id>`, only at the path `rpc_media_upload_begin` handed out.
- At most 300 MB may be waiting per household (GDMQF).
- Folder songs (`source='pc'`) are reported by sha256 and path. Their covers are uploaded through
  `art_upload {sha256}` (a signed upload into `media-art`).

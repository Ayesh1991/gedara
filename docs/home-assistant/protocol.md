# Home Assistant bridge protocol v1 (for developers)

Code: `supabase/functions/_shared/home/protocol.ts` (Zod, shared by the function, the web app as
`@home/protocol`, and the simulator), `supabase/functions/home-agent/index.ts`,
`devices/home-bridge/gedara_home_bridge.py`, migrations 75–76.

## Bridge ↔ Home Assistant (home network)
Home Assistant's websocket API, `ws://<ha>:8123/api/websocket`, authenticated with a long-lived token
of a **non-admin** HA user. The bridge uses only:
`get_states`, `config/entity_registry/list`, `config/device_registry/list`, `config/area_registry/list`
(rooms; optional), `subscribe_events` for `state_changed` and the three `*_registry_updated` events,
`call_service`, `ping`. `call_service` is limited in the bridge's code (`ALLOWED`) to
`switch|light.turn_on|turn_off` and `climate.turn_on|turn_off|set_temperature|set_hvac_mode`, on an entity
the bridge reported, with the temperature inside the entity's `min_temp…max_temp` in half degrees
and a mode from its `hvac_modes` (`plan_call`, unit-tested in `test_bridge.py`).

What is reported (`build_catalog`): `binary_sensor` with `device_class` door / window / opening /
garage_door (→ door or window), `light`, `switch`, `climate`; not disabled, hidden, or config /
diagnostic entities. For climate only `current_temperature, temperature, min_temp, max_temp,
target_temp_step, hvac_modes` (checked again by `private.home_attrs`).

## Bridge ↔ Gedara (HTTPS, home-agent Edge Function)
| Action | Body | Reply |
|---|---|---|
| `pair_start` | `{ key_hash, hint, agent }` (no key header) | `{ status: 'waiting', code, expires_at }` or `{ status: 'paired' }` |
| `pair_poll` | header `X-Gedara-Device: <key>` | `{ status: 'waiting' \| 'paired' \| 'expired', device_id?, name?, household? }` |
| `sync` | header + `{ v: 1, agent, up, wait?, status?, catalog?, catalog_full?, states?, done? }` | `{ device_id, name, commands: [{ id, entity_id, action, args }], need_catalog }` |

- `wait: true` and nothing to do: the function waits **inside Postgres** (`rpc_home_wait`, every
  0.3 s, at most 7 s a call: PostgREST's `statement_timeout` is 8 s) for up to 25 s, then picks
  commands with `rpc_home_pending`. About 5 logged requests per quiet 25 s.
- The bridge reports changes in a short sync ~1 s after they happen (batched), an AC's room
  temperature at most every 5 minutes (`Throttle`), the full catalog on start and when HA's
  registries change. No report when nothing changed: the long-poll carries the status.
- Commands expire after 60 s; `done: [{ id, ok, error? }]` closes them (`failed` keeps the reason).
- Limits: 400 catalog items / states and 50 results per sync, 256 KB body, 60 commands a minute per
  household; one bridge per household; the bridge's key in `home_token` only (a speaker's or the
  scale's key can't be used here).

#!/usr/bin/env python3
"""gedara-home: the bridge between Home Assistant and Gedara (Phase 8, docs/home-assistant).

It runs on the Gedara Raspberry Pi (next to the printer and the music speaker) and talks to:
  * Home Assistant, on the home network, through HA's websocket API with a long-lived token made for
    a non-admin HA user "Gedara". The token stays in /etc/gedara-home/ha-token and goes nowhere else;
  * Gedara, only through the home-agent Edge Function (protocol v1,
    supabase/functions/_shared/home/protocol.ts): pairing by an 8-digit code (the Pi makes its own
    key and sends only its sha256), a long-poll (<= 25 s) that returns as soon as Gedara sends a
    command, and short syncs that report what changed.

What it reports: doors and windows (binary_sensors with a door/window/opening/garage_door class),
lights, switches and climate (the AC), with their HA area (room). Changes go to Gedara within ~1 s;
an AC's room temperature at most every 5 minutes (Supabase's log budget).

What it will do: only switch/light turn_on/turn_off and climate turn_on/turn_off/set_temperature/
set_hvac_mode, on an entity it reported, with the temperature inside that AC's own range and a
mode it has. Everything else is refused here, whatever Gedara asks: no locks, alarms, covers,
scripts, automations, scenes or homeassistant.* services, ever.

    gedara-home pair       make the key (once) and show the pairing code until Gedara has it
    gedara-home setup-ha   ask for Home Assistant's address and token (hidden), then check them
    gedara-home check-ha   connect to Home Assistant with the token and say what it found (no secrets)
    gedara-home status     what the bridge knows (no secrets)
    gedara-home run        the service (systemd: gedara-home.service)

Stdlib + python3-websocket (websocket-client).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import secrets
import shutil
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

VERSION = "0.1.0"
AGENT = f"gedara-home {VERSION}"
ROOT = Path(os.environ.get("GEDARA_HOME_ROOT", "/"))
CONF = ROOT / "etc/gedara-home"
KEY_FILE = CONF / "key"
SERVER_FILE = CONF / "server"  # "gedara" or "gedara-staging" (written by setup-home.sh)
HA_URL_FILE = CONF / "ha-url"  # e.g. http://homeassistant.local:8123 (written by install.ps1)
HA_TOKEN_FILE = CONF / "ha-token"  # the HA long-lived token (written by install.ps1, never printed)
STATE_FILE = ROOT / "var/lib/gedara-home/state.json"
SERVERS = {
    "gedara": "https://ltzlsxupcsamwtgqfejg.supabase.co/functions/v1/home-agent",
    "gedara-staging": "https://ebtvpsrehwdxepayqwma.supabase.co/functions/v1/home-agent",
}
try:
    TZ = ZoneInfo("Asia/Colombo")
except ZoneInfoNotFoundError:  # no tz database (tests on Windows); Sri Lanka has no daylight saving
    TZ = timezone(timedelta(hours=5, minutes=30))

ENTITY_ID = re.compile(r"^[a-z_]{1,30}\.[a-z0-9_]{1,120}$")
OPENING_CLASSES = {"door", "window", "opening", "garage_door"}
# The whole list of what the bridge will ever ask Home Assistant to do.
ALLOWED = {
    ("switch", "turn_on"), ("switch", "turn_off"),
    ("light", "turn_on"), ("light", "turn_off"),
    ("climate", "turn_on"), ("climate", "turn_off"), ("climate", "set_temperature"), ("climate", "set_hvac_mode"),
}
CLIMATE_ATTRS = ("current_temperature", "temperature", "min_temp", "max_temp", "target_temp_step", "hvac_modes")
ROOM_TEMP_EVERY = 300.0  # seconds between room-temperature-only reports of an AC
MAX_CATALOG = 400


def log(msg: str) -> None:
    print(f"{datetime.now(TZ):%H:%M:%S} {msg}", flush=True)


class Refused(Exception):
    """A command the bridge will not pass to Home Assistant."""


# ── Pure helpers (unit-tested in test_bridge.py) ──────────────────────────────
def kind_of(entity_id: str, attrs: dict) -> str | None:
    """door / window / light / switch / climate for what Gedara shows, else None."""
    if not ENTITY_ID.match(entity_id):
        return None
    domain = entity_id.split(".", 1)[0]
    if domain in ("light", "switch", "climate"):
        return domain
    if domain == "binary_sensor":
        dc = str(attrs.get("device_class") or "")
        if dc == "window":
            return "window"
        if dc in ("door", "garage_door"):
            return "door"
        if dc == "opening":
            name = str(attrs.get("friendly_name") or entity_id).lower()
            return "window" if "window" in name else "door"
    return None


def area_of(entity: dict | None, devices: dict[str, dict], areas: dict[str, str]) -> str | None:
    """The entity's own area, else its device's area, as the area's name."""
    if not entity:
        return None
    area_id = entity.get("area_id") or (devices.get(entity.get("device_id") or "") or {}).get("area_id")
    name = areas.get(area_id or "")
    return name[:60] if name else None


def build_catalog(states: list[dict], entities: list[dict], devices: list[dict], areas: list[dict]) -> list[dict]:
    """What Gedara may show, from HA's get_states + the entity / device / area registries.
    Disabled, hidden, and configuration / diagnostic entities are left out."""
    reg = {e.get("entity_id"): e for e in entities if isinstance(e, dict)}
    devs = {d.get("id"): d for d in devices if isinstance(d, dict)}
    area_names = {a.get("area_id"): str(a.get("name") or "") for a in areas if isinstance(a, dict)}
    out = []
    for s in states:
        eid = str(s.get("entity_id") or "")
        attrs = s.get("attributes") or {}
        kind = kind_of(eid, attrs)
        if not kind:
            continue
        e = reg.get(eid)
        if e and (e.get("disabled_by") or e.get("hidden_by") or e.get("entity_category") in ("config", "diagnostic")):
            continue
        name = str(attrs.get("friendly_name") or eid)[:100].strip() or eid
        item = {"entity_id": eid, "domain": eid.split(".", 1)[0], "kind": kind, "name": name,
                "area": area_of(e, devs, area_names)}
        if attrs.get("device_class"):
            item["device_class"] = str(attrs["device_class"])[:30]
        out.append(item)
    out.sort(key=lambda i: i["entity_id"])
    return out[:MAX_CATALOG]


def _num(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and -50 <= v <= 100 else None


def state_report(s: dict) -> dict:
    """One entity's state for Gedara: HA's state, when it changed, and (AC only) the shown attributes."""
    eid = str(s.get("entity_id") or "")
    r = {"entity_id": eid, "state": str(s.get("state") or "unknown")[:30]}
    changed = s.get("last_changed")
    if isinstance(changed, str) and re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?([+-]\d\d:\d\d|Z)$", changed):
        r["changed_at"] = changed
    if eid.startswith("climate."):
        a = s.get("attributes") or {}
        attrs = {}
        for k in CLIMATE_ATTRS[:-1]:
            v = _num(a.get(k))
            if v is not None:
                attrs[k] = v
        modes = a.get("hvac_modes")
        if isinstance(modes, list):
            attrs["hvac_modes"] = [str(m)[:20] for m in modes if isinstance(m, str)][:10]
        r["attrs"] = attrs
    return r


def plan_call(cmd: dict, known: dict[str, dict]) -> tuple[str, str, dict]:
    """Gedara's command → (domain, service, service_data) for HA, or Refused. `known` is the latest
    HA state of every entity the bridge reported (entity_id → state object)."""
    eid = str(cmd.get("entity_id") or "")
    action = str(cmd.get("action") or "")
    args = cmd.get("args") if isinstance(cmd.get("args"), dict) else {}
    if not ENTITY_ID.match(eid) or eid not in known:
        raise Refused("not something this bridge reports")
    domain = eid.split(".", 1)[0]
    if (domain, action) not in ALLOWED:
        raise Refused(f"{domain}.{action} is not allowed from Gedara")
    attrs = known[eid].get("attributes") or {}
    if action == "set_temperature":
        t = args.get("temperature")
        if not isinstance(t, (int, float)) or isinstance(t, bool):
            raise Refused("temperature must be a number")
        lo = _num(attrs.get("min_temp"))
        hi = _num(attrs.get("max_temp"))
        lo = 16.0 if lo is None else lo
        hi = 32.0 if hi is None else hi
        if t < lo or t > hi or round(t * 2) != t * 2:
            raise Refused(f"temperature must be {lo:g} to {hi:g} in half degrees")
        return domain, action, {"temperature": float(t)}
    if action == "set_hvac_mode":
        mode = args.get("hvac_mode")
        modes = attrs.get("hvac_modes") if isinstance(attrs.get("hvac_modes"), list) else []
        if not isinstance(mode, str) or mode not in modes:
            raise Refused(f"this AC has no mode {mode!r}")
        return domain, action, {"hvac_mode": mode}
    return domain, action, {}


class Throttle:
    """Which state changes to send now. Everything at once, except an AC whose only change is the
    room temperature: that at most every ROOM_TEMP_EVERY seconds (the latest value wins)."""

    def __init__(self, every: float = ROOM_TEMP_EVERY):
        self.every = every
        self.sent: dict[str, tuple[dict, float]] = {}

    @staticmethod
    def _quiet_part(r: dict) -> dict:
        a = dict(r.get("attrs") or {})
        a.pop("current_temperature", None)
        return {"state": r.get("state"), "attrs": a}

    def due(self, r: dict, now: float) -> bool:
        last = self.sent.get(r["entity_id"])
        if last is None:
            return True
        prev, at = last
        if prev == r:
            return False
        if r["entity_id"].startswith("climate.") and self._quiet_part(prev) == self._quiet_part(r):
            return now - at >= self.every
        return True

    def mark(self, r: dict, now: float) -> None:
        self.sent[r["entity_id"]] = (r, now)


def ws_url(base: str) -> str:
    """http(s)://host:8123 → ws(s)://host:8123/api/websocket."""
    b = base.strip().rstrip("/")
    if not re.match(r"^https?://[A-Za-z0-9.\-]+(:\d{1,5})?$", b):
        raise ValueError("the Home Assistant address must look like http://homeassistant.local:8123")
    return ("wss://" + b[8:] if b.startswith("https://") else "ws://" + b[7:]) + "/api/websocket"


# ── Files ─────────────────────────────────────────────────────────────────────
def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)


def read_secret(path: Path, length: int | None = None) -> str | None:
    try:
        v = path.read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError):
        return None
    if not v or (length and len(v) != length):
        return None
    return v


def server_url() -> str:
    try:
        name = SERVER_FILE.read_text(encoding="ascii").strip()
    except OSError:
        name = "gedara"
    return SERVERS.get(name, SERVERS["gedara"])


# ── Gedara (HTTPS) ────────────────────────────────────────────────────────────
CTX = ssl.create_default_context()  # system CA store: certificates are always checked


class HttpError(Exception):
    def __init__(self, status: int, body: dict | None):
        super().__init__(f"HTTP {status} {body.get('error') if body else ''}")
        self.status = status
        self.body = body or {}


def post(url: str, body: dict, key: str | None, timeout: float) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json", "User-Agent": AGENT})
    if key:
        req.add_header("X-Gedara-Device", key)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            parsed = json.loads(e.read() or b"{}")
        except ValueError:
            parsed = None
        raise HttpError(e.code, parsed) from None


# ── Home Assistant (websocket) ────────────────────────────────────────────────
class HomeAssistant:
    """One websocket to HA: request/response by id, events to on_event. Reconnects by itself."""

    def __init__(self, url: str, token: str, on_event, on_connect):
        self.url = url
        self._token = token
        self.on_event = on_event
        self.on_connect = on_connect
        self.ws = None
        self.version: str | None = None
        self.state = "connecting"
        self.next_id = 1
        self.waiting: dict[int, dict] = {}
        self.lock = threading.Lock()
        self.send_lock = threading.Lock()

    def _open(self) -> None:
        import websocket  # noqa: PLC0415 — python3-websocket (websocket-client)

        ws = websocket.create_connection(self.url, timeout=15)
        hello = json.loads(ws.recv())
        if hello.get("type") != "auth_required":
            raise ConnectionError("not a Home Assistant websocket")
        ws.send(json.dumps({"type": "auth", "access_token": self._token}))
        r = json.loads(ws.recv())
        if r.get("type") != "auth_ok":
            ws.close()
            self.state = "auth_failed"
            raise PermissionError("Home Assistant refused the token")
        self.version = str(r.get("ha_version") or "")[:20] or None
        ws.settimeout(60)
        self.ws = ws
        self.state = "connected"

    def request(self, msg: dict, timeout: float = 20) -> dict:
        """Send a command and wait for its result (raises on HA errors)."""
        if not self.ws:
            raise ConnectionError("not connected to Home Assistant")
        ev = threading.Event()
        with self.lock:
            mid = self.next_id
            self.next_id += 1
            self.waiting[mid] = {"ev": ev}
        with self.send_lock:
            self.ws.send(json.dumps({**msg, "id": mid}))
        if not ev.wait(timeout):
            with self.lock:
                self.waiting.pop(mid, None)
            raise TimeoutError("Home Assistant didn't answer")
        with self.lock:
            res = self.waiting.pop(mid)["res"]
        if not res.get("success"):
            err = res.get("error") or {}
            raise RuntimeError(f"HA: {str(err.get('message') or err.get('code') or 'refused')[:150]}")
        return res

    def _reader(self) -> None:
        while True:
            raw = self.ws.recv()
            if not raw:
                raise ConnectionError("Home Assistant closed the connection")
            msg = json.loads(raw)
            if msg.get("type") == "result":
                with self.lock:
                    w = self.waiting.get(msg.get("id"))
                    if w is not None:
                        w["res"] = msg
                        w["ev"].set()
            elif msg.get("type") == "event":
                self.on_event(msg.get("event") or {})
            elif msg.get("type") == "pong":
                pass

    def loop(self) -> None:
        backoff = 2.0
        while True:
            try:
                self.state = "connecting"
                self._open()
                backoff = 2.0
                log(f"[HA] connected (Home Assistant {self.version or '?'})")
                threading.Thread(target=self.on_connect, daemon=True).start()
                self._reader()
            except PermissionError as e:
                log(f"[HA] {e}: make a new token (docs/home-assistant/setup.md) and run install.ps1 -Home again")
                time.sleep(300)
                continue
            except Exception as e:  # noqa: BLE001 — HA restarting or the network down: try again, slower
                if self.state != "auth_failed":
                    self.state = "unreachable"
                log(f"[HA] {e.__class__.__name__}: {e}")
            finally:
                ws, self.ws = self.ws, None
                if ws is not None:
                    try:
                        ws.close()
                    except Exception:  # noqa: BLE001
                        pass
                with self.lock:  # nobody waits for an answer from a closed socket
                    for w in self.waiting.values():
                        w["res"] = {"success": False, "error": {"message": "connection to Home Assistant lost"}}
                        w["ev"].set()
            time.sleep(backoff)
            backoff = min(60.0, backoff * 2) * (0.8 + 0.4 * random.random())

    def keepalive(self) -> None:
        while True:
            time.sleep(30)
            try:
                if self.ws:
                    with self.lock:
                        mid = self.next_id
                        self.next_id += 1
                    with self.send_lock:
                        self.ws.send(json.dumps({"id": mid, "type": "ping"}))
            except Exception:  # noqa: BLE001 — the reader notices a dead socket
                pass


def read_house(ha: "HomeAssistant") -> tuple[list[dict], list[dict]]:
    """(catalog, states) from HA. The registries only give rooms: if HA refuses one (an older HA,
    or a user without the right), everything still works and shows under "Other"."""
    states = ha.request({"type": "get_states"}).get("result") or []
    regs = []
    for kind in ("config/entity_registry/list", "config/device_registry/list", "config/area_registry/list"):
        try:
            regs.append(ha.request({"type": kind}).get("result") or [])
        except RuntimeError as e:
            log(f"[HA] {kind}: {e} (rooms may be missing)")
            regs.append([])
    return build_catalog(states, *regs), states


# ── The bridge ────────────────────────────────────────────────────────────────
class Bridge:
    def __init__(self, key: str, ha_url: str, ha_token: str):
        self.key = key
        self.url = server_url()
        self.started = time.time()
        self.ha = HomeAssistant(ws_url(ha_url), ha_token, self.on_event, self.on_connect)
        self.known: dict[str, dict] = {}  # entity_id → HA state object, for what we report
        self.catalog: list[dict] = []
        self.catalog_dirty = False
        self.throttle = Throttle()
        self.pending_states: dict[str, dict] = {}
        self.done: list[dict] = []
        self.lock = threading.Lock()
        self.report_now = threading.Event()
        self.refresh = threading.Event()

    # HA side ──────────────────────────────────────────────────────────────────
    def on_connect(self) -> None:
        try:
            for ev in ("state_changed", "entity_registry_updated", "device_registry_updated", "area_registry_updated"):
                self.ha.request({"type": "subscribe_events", "event_type": ev})
            self.load_all()
        except Exception as e:  # noqa: BLE001
            log(f"[HA] setup: {e}")

    def load_all(self) -> None:
        catalog, states = read_house(self.ha)
        ids = {c["entity_id"] for c in catalog}
        with self.lock:
            self.catalog = catalog
            self.catalog_dirty = True
            self.known = {s["entity_id"]: s for s in states if s.get("entity_id") in ids}
            self.throttle = Throttle()  # Gedara gets every state again with the new catalog
            self.pending_states = {eid: state_report(s) for eid, s in self.known.items()}
        log(f"[HA] {len(catalog)} doors, windows, lights, switches and ACs")
        self.report_now.set()

    def on_event(self, event: dict) -> None:
        kind = event.get("event_type")
        if kind in ("entity_registry_updated", "device_registry_updated", "area_registry_updated"):
            self.refresh.set()  # a new sensor, a renamed room …: read everything again (debounced)
            return
        if kind != "state_changed":
            return
        data = event.get("data") or {}
        new = data.get("new_state")
        eid = data.get("entity_id")
        with self.lock:
            if not new or eid not in self.known:
                return
            self.known[eid] = new
            self.pending_states[eid] = state_report(new)
        self.report_now.set()

    def refresher(self) -> None:
        while True:
            self.refresh.wait()
            time.sleep(5)  # HA sends a burst of registry events: read once
            self.refresh.clear()
            try:
                self.load_all()
            except Exception as e:  # noqa: BLE001
                log(f"[HA] refresh: {e}")

    # Gedara side ──────────────────────────────────────────────────────────────
    def status(self) -> dict:
        out = {"ha": self.ha.state, "entities": len(self.catalog)}
        if self.ha.version:
            out["ha_version"] = self.ha.version
        return out

    def sync(self, wait: bool) -> dict:
        now = time.time()
        with self.lock:
            body: dict = {"action": "sync", "v": 1, "agent": AGENT, "up": int(now - self.started), "status": self.status()}
            if self.catalog_dirty and self.ha.state == "connected":
                body["catalog"] = self.catalog
                body["catalog_full"] = True
            due = [r for r in self.pending_states.values() if self.throttle.due(r, now)]
            if due:
                body["states"] = due[:400]
            done, self.done = self.done[:50], self.done[50:]
            if done:
                body["done"] = done
            body["wait"] = wait and not (due or done or "catalog" in body)
        try:
            reply = post(self.url, body, self.key, timeout=45 if body["wait"] else 20)
        except Exception:
            with self.lock:  # nothing is lost: the results go again next time
                self.done[:0] = done
            raise
        with self.lock:
            if "catalog" in body:
                self.catalog_dirty = False
            for r in body.get("states", []):
                self.throttle.mark(r, now)
                if self.pending_states.get(r["entity_id"]) == r:
                    del self.pending_states[r["entity_id"]]
            if reply.get("need_catalog"):
                self.catalog_dirty = True
        for c in reply.get("commands") or []:
            threading.Thread(target=self.run_command, args=(c,), daemon=True).start()
        return reply

    def run_command(self, c: dict) -> None:
        ok, err = True, None
        try:
            with self.lock:
                known = dict(self.known)
            domain, service, data = plan_call(c, known)
            self.ha.request({"type": "call_service", "domain": domain, "service": service,
                             "target": {"entity_id": c["entity_id"]}, "service_data": data}, timeout=15)
            log(f"[CMD] {c['entity_id']} {c['action']} {data or ''}")
        except Refused as e:
            ok, err = False, f"refused by the bridge: {e}"[:200]
            log(f"[CMD] refused {c.get('entity_id')} {c.get('action')}: {e}")
        except Exception as e:  # noqa: BLE001
            ok, err = False, str(e)[:200]
            log(f"[CMD] {c.get('entity_id')} {c.get('action')} failed: {err}")
        with self.lock:
            self.done.append({"id": c["id"], "ok": ok, **({"error": err} if err else {})})
        self.report_now.set()

    def has_news(self) -> bool:
        now = time.time()
        with self.lock:
            return bool(self.done or (self.catalog_dirty and self.ha.state == "connected")
                        or any(self.throttle.due(r, now) for r in self.pending_states.values()))

    def reporter(self) -> None:
        """Changes go in a short sync ~1 s after they happen; AC room temperatures wait (Throttle).
        Nothing to say → no request (the long-poll already carries the bridge's status)."""
        while True:
            self.report_now.wait(timeout=30)  # the timeout lets a throttled room temperature go when due
            self.report_now.clear()
            time.sleep(1.0)  # a window and its light change together: one report
            if not self.has_news():
                continue
            try:
                self.sync(wait=False)
            except Exception as e:  # noqa: BLE001
                log(f"[NET] report: {e}")
                time.sleep(5)
                self.report_now.set()

    def run(self) -> None:
        log(f"{AGENT} → {self.url.split('//')[1].split('.')[0]}")
        for fn in (self.ha.loop, self.ha.keepalive, self.refresher, self.reporter):
            threading.Thread(target=fn, daemon=True).start()
        backoff = 1.0
        while True:
            try:
                self.sync(wait=True)
                backoff = 1.0
            except HttpError as e:
                if e.status == 401:
                    log("[NET] Gedara doesn't know this bridge any more (removed?). Pair it again: install.ps1 -Home")
                    time.sleep(300)
                else:
                    log(f"[NET] {e}")
                    time.sleep(backoff)
                    backoff = min(60.0, backoff * 2) * (0.8 + 0.4 * random.random())
            except Exception as e:  # noqa: BLE001 — internet down: try again, slower and slower
                log(f"[NET] {e.__class__.__name__}: {e}")
                time.sleep(backoff)
                backoff = min(60.0, backoff * 2) * (0.8 + 0.4 * random.random())


# ── CLI ───────────────────────────────────────────────────────────────────────
def cmd_pair() -> int:
    key = read_secret(KEY_FILE, 43)
    if not key:
        key = secrets.token_urlsafe(32)[:43]
        CONF.mkdir(parents=True, exist_ok=True)
        fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="ascii") as f:
            f.write(key)
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            try:
                shutil.chown(KEY_FILE, "gedara-home", "gedara-home")  # only the service reads it
            except (LookupError, OSError):
                pass
    url = server_url()
    r = post(url, {"action": "pair_start", "key_hash": hashlib.sha256(key.encode()).hexdigest(), "hint": key[-4:], "agent": AGENT}, None, 20)
    if r.get("status") == "paired":
        p = post(url, {"action": "pair_poll"}, key, 20)
        print(f"PAIRED: already paired as '{p.get('name')}' in '{p.get('household')}'")
        return 0
    code = r["code"]
    print("")
    print("  ┌──────────────────────────────────────────────┐")
    print(f"  │   Pairing code:   {code[:4]} {code[4:]}                  │")
    print("  └──────────────────────────────────────────────┘")
    print("  In Gedara: Settings › Devices › Home Assistant › Connect, type this code.")
    print("  (It works for 10 minutes.) Waiting…", flush=True)
    until = time.time() + 600
    while time.time() < until:
        time.sleep(3)
        p = post(url, {"action": "pair_poll"}, key, 20)
        if p.get("status") == "paired":
            print(f"PAIRED: '{p.get('name')}' in the household '{p.get('household')}'. If that's not your household, remove it there.")
            return 0
        if p.get("status") == "expired":
            break
    print("PROBLEM: the code expired. Run this again for a new one.")
    return 1


def cmd_check_ha() -> int:
    """Used by the installer: can we reach HA with the token? Prints counts only, never the token."""
    base = read_secret(HA_URL_FILE)
    token = read_secret(HA_TOKEN_FILE)
    if not base or not token:
        print("PROBLEM: no Home Assistant address or token on this Pi yet (install.ps1 -Home asks for them)")
        return 1
    try:
        url = ws_url(base)
    except ValueError as e:
        print(f"PROBLEM: {e}")
        return 1
    got: dict = {}

    def connected():
        try:
            got["catalog"] = read_house(ha)[0]
        except Exception as e:  # noqa: BLE001
            got["error"] = str(e)
        done.set()

    done = threading.Event()
    ha = HomeAssistant(url, token, lambda _e: None, connected)
    threading.Thread(target=ha.loop, daemon=True).start()
    done.wait(40)
    if ha.state == "auth_failed":
        print("PROBLEM: Home Assistant refused the token. Make a new one (docs/home-assistant/setup.md, step 2).")
        return 1
    if "catalog" not in got:
        print(f"PROBLEM: can't reach Home Assistant at {base} ({got.get('error') or ha.state}). Is the address right?")
        return 1
    kinds: dict[str, int] = {}
    for c in got["catalog"]:
        kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1
    rooms = sorted({c["area"] for c in got["catalog"] if c["area"]})
    print(f"OK: Home Assistant {ha.version or '?'}; found " + ", ".join(f"{n} {k}" for k, n in sorted(kinds.items()))
          + (f"; rooms: {', '.join(rooms)}" if rooms else ""))
    return 0


def write_private(path: Path, value: str) -> None:
    """A file only root and the gedara-home service can read (0640 root:gedara-home)."""
    CONF.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
    with os.fdopen(fd, "w", encoding="ascii") as f:
        f.write(value)
    os.chmod(path, 0o640)
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        try:
            shutil.chown(path, "root", "gedara-home")
        except (LookupError, OSError):
            pass


def cmd_setup_ha() -> int:
    """Asks (on the Pi, in the installer's window) for Home Assistant's address and the token, then
    checks them. The token is typed hidden and written only to HA_TOKEN_FILE; it is never shown."""
    import getpass  # noqa: PLC0415

    old = read_secret(HA_URL_FILE) or "http://homeassistant.local:8123"
    print("")
    print("  Home Assistant's address on the home network (Enter keeps the one shown).")
    while True:
        base = input(f"  Address [{old}]: ").strip() or old
        if re.match(r"^[A-Za-z0-9.\-]+(:\d{1,5})?$", base):
            base = "http://" + base  # typed without http://
        if ":" not in base.split("//", 1)[-1]:
            base += ":8123"
        try:
            ws_url(base)
            break
        except ValueError as e:
            print(f"  {e}")
    write_private(HA_URL_FILE, base.rstrip("/"))
    have = read_secret(HA_TOKEN_FILE)
    if have and input("  Keep the Home Assistant token this Pi already has? [Y/n]: ").strip().lower() in ("", "y", "yes"):
        pass
    else:
        print("  Paste the long-lived token of the 'Gedara' user in Home Assistant (right-click pastes;")
        print("  nothing shows while you paste, that's normal), then press Enter.")
        token = getpass.getpass("  Token: ").strip()
        if not re.match(r"^[A-Za-z0-9._\-]{20,600}$", token):
            print("PROBLEM: that doesn't look like a Home Assistant token. Run install.ps1 -Home again.")
            return 1
        write_private(HA_TOKEN_FILE, token)
        token = None
    return cmd_check_ha()


def cmd_status() -> int:
    print(json.dumps({"agent": AGENT, "server": server_url().split("//")[1].split(".")[0],
                      "paired_key": bool(read_secret(KEY_FILE, 43)), "ha_address": read_secret(HA_URL_FILE),
                      "ha_token": bool(read_secret(HA_TOKEN_FILE))}, indent=2))
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="gedara-home")
    ap.add_argument("command", choices=["pair", "setup-ha", "check-ha", "status", "run"])
    a = ap.parse_args(argv)
    if a.command == "pair":
        return cmd_pair()
    if a.command == "setup-ha":
        return cmd_setup_ha()
    if a.command == "check-ha":
        return cmd_check_ha()
    if a.command == "status":
        return cmd_status()
    key = read_secret(KEY_FILE, 43)
    base = read_secret(HA_URL_FILE)
    token = read_secret(HA_TOKEN_FILE)
    if not key or not base or not token:
        log("not set up yet: run install.ps1 -Home on the PC")
        time.sleep(60)
        return 1
    Bridge(key, base, token).run()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

"""The Gedara speaker as a plain network speaker (Phase 7i, docs/media-player/network-speaker.md).

* AirPlay: shairport-sync plays to the shared ALSA "default" (dmix). It tells us through its
  metadata pipe when a phone starts and stops (ssnc pbeg / pend) and the phone's name (ssnc snam).
  Turning AirPlay on/off, its name, and ending a session are done by root through a systemd path
  unit (gedara-network.path → apply-network.sh) watching files this module writes; the agent itself
  has no root rights.
* Bluetooth: BlueALSA (A2DP sink) + bluealsa-aplay. The agent (group "bluetooth") drives
  bluetoothctl: power on/off, its name, a 2-minute pairing window with a no-PIN agent (bt-agent),
  trusting what paired, forgetting, and disconnecting when Gedara takes the speaker back.

Pure helpers at the top are unit-tested (test_agent.py).
"""
from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path

RUN = Path(os.environ.get("GEDARA_MEDIA_RUN", "/run/gedara-media"))
METADATA_PIPE = RUN / "shairport-metadata"
NETWORK_FILE = Path(os.environ.get("GEDARA_MEDIA_STATE", "/var/lib/gedara-media")) / "network.json"
AIRPLAY_STOP = RUN / "airplay-stop"
ADDRESS = re.compile(r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$")
ITEM = re.compile(rb"<item><type>([0-9a-f]{8})</type><code>([0-9a-f]{8})</code><length>(\d+)</length>(?:\s*<data encoding=\"base64\">\s*([A-Za-z0-9+/=\s]*?)</data>)?</item>")


# ── Pure helpers ──────────────────────────────────────────────────────────────
def metadata_items(buf: bytes) -> tuple[list[tuple[str, str, bytes]], bytes]:
    """Complete shairport-sync metadata items in `buf` as (type, code, data), and the unparsed rest."""
    out: list[tuple[str, str, bytes]] = []
    last = 0
    for m in ITEM.finditer(buf):
        typ = bytes.fromhex(m.group(1).decode()).decode("latin-1")
        code = bytes.fromhex(m.group(2).decode()).decode("latin-1")
        data = base64.b64decode(re.sub(rb"\s", b"", m.group(4))) if m.group(4) else b""
        out.append((typ, code, data))
        last = m.end()
    rest = buf[last:]
    return out, rest[-65536:]


def airplay_event(typ: str, code: str, data: bytes) -> tuple[str, str | None] | None:
    """('start', None) / ('stop', None) / ('name', <phone>) for the items that matter, else None."""
    if typ != "ssnc":
        return None
    if code == "pbeg":
        return ("start", None)
    if code in ("pend", "disc"):
        return ("stop", None)
    if code == "snam":
        name = data.decode("utf-8", "replace").strip()[:60]
        return ("name", name or None)
    return None


def parse_bt_devices(paired: str, connected: str) -> list[dict]:
    """`bluetoothctl devices Paired` / `devices Connected` output → [{address, name, connected}]."""
    def lines(text: str) -> dict[str, str]:
        out = {}
        for line in text.splitlines():
            parts = line.strip().split(" ", 2)
            if len(parts) >= 2 and parts[0] == "Device" and ADDRESS.match(parts[1].upper()):
                out[parts[1].upper()] = (parts[2] if len(parts) > 2 else parts[1]).strip()[:60]
        return out

    con = lines(connected)
    return [{"address": a, "name": n, "connected": a in con} for a, n in sorted(lines(paired).items())][:20]


SAFE_NAME = re.compile(r"[^\w .'-]")


def safe_name(name: str) -> str:
    """A speaker name that is safe in shairport-sync.conf and bluetoothctl (same filter as apply-network.sh)."""
    return " ".join(SAFE_NAME.sub("", str(name)).split())[:40] or "Gedara speaker"


def newly_paired(before: set[str], now: list[dict]) -> list[str]:
    """Addresses that paired since the window opened."""
    return [d["address"] for d in now if d["address"] not in before]


def pairing_left(until: float | None, now: float) -> int:
    return max(0, int(round(until - now))) if until else 0


# ── AirPlay ───────────────────────────────────────────────────────────────────
class AirPlay:
    """Reads shairport-sync's metadata pipe in a thread; on_change(active, name) when it changes."""

    def __init__(self, on_change):
        self.on_change = on_change
        self.active = False
        self.name: str | None = None

    def loop(self) -> None:
        while True:
            try:
                if not METADATA_PIPE.exists():
                    time.sleep(5)
                    continue
                with open(METADATA_PIPE, "rb", buffering=0) as f:  # blocks until shairport-sync writes
                    buf = b""
                    while True:
                        chunk = f.read(4096)
                        if not chunk:
                            break
                        buf += chunk
                        items, buf = metadata_items(buf)
                        for typ, code, data in items:
                            ev = airplay_event(typ, code, data)
                            if not ev:
                                continue
                            kind, value = ev
                            if kind == "name":
                                self.name = value
                                if self.active:
                                    self.on_change(True, self.name)
                            elif kind == "start" and not self.active:
                                self.active = True
                                self.on_change(True, self.name)
                            elif kind == "stop" and self.active:
                                self.active = False
                                self.on_change(False, None)
            except OSError:
                time.sleep(5)

    @staticmethod
    def stop_session() -> None:
        """Ends the phone's AirPlay session (apply-network.sh restarts shairport-sync)."""
        try:
            AIRPLAY_STOP.write_text(str(time.time()))
        except OSError:
            pass

    @staticmethod
    def configure(enabled: bool, name: str) -> None:
        """AirPlay on/off and its name; written only when it changed (the path unit acts on writes)."""
        want = json.dumps({"airplay": bool(enabled), "name": safe_name(name)}, sort_keys=True)
        try:
            if NETWORK_FILE.exists() and NETWORK_FILE.read_text() == want:
                return
            NETWORK_FILE.write_text(want)
        except OSError:
            pass


# ── Bluetooth ─────────────────────────────────────────────────────────────────
def btctl(*args: str, timeout: float = 10) -> str:
    try:
        r = subprocess.run(["bluetoothctl", *args], capture_output=True, text=True, timeout=timeout)
        return r.stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


class Bluetooth:
    def __init__(self, on_change):
        self.on_change = on_change  # (active: bool, name: str | None)
        self.pairing_until: float | None = None
        self.agent: subprocess.Popen | None = None
        self.enabled = True
        self.active_addr: str | None = None
        self.paired_before: set[str] = set()
        self.devices: list[dict] = []
        self.lock = threading.Lock()

    @staticmethod
    def adapter() -> bool:
        return "Controller" in btctl("list")

    def state(self) -> str:
        if not self.adapter():
            return "none"
        if not self.enabled:
            return "off"
        return "pairing" if pairing_left(self.pairing_until, time.time()) > 0 else "ready"

    def configure(self, enabled: bool, name: str) -> None:
        if not self.adapter():
            return
        self.enabled = enabled
        btctl("power", "on" if enabled else "off")
        if enabled:
            btctl("system-alias", safe_name(name))
        else:
            self.close_pairing()

    def open_pairing(self, seconds: int) -> None:
        if not self.adapter() or not self.enabled:
            raise RuntimeError("no Bluetooth adapter, or Bluetooth is off")
        with self.lock:
            if self.agent is None or self.agent.poll() is not None:
                # A no-PIN ("Just Works") agent only while the window is open.
                self.agent = subprocess.Popen(["bt-agent", "--capability=NoInputNoOutput"],
                                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            # Remember who was already paired: only a device that pairs now is trusted, and the window
            # closes as soon as one has (one new phone per window; it then shows in Gedara with Remove).
            self.paired_before = {d["address"] for d in self.list_devices()}
            btctl("pairable", "on")
            btctl("discoverable", "on")
            self.pairing_until = time.time() + max(10, min(int(seconds), 300))

    def close_pairing(self) -> None:
        with self.lock:
            btctl("discoverable", "off")
            btctl("pairable", "off")
            if self.agent is not None:
                self.agent.terminate()
                self.agent = None
            was_open = self.pairing_until is not None
            self.pairing_until = None
        if was_open:
            # Only what paired in this window may reconnect later by itself.
            for address in newly_paired(self.paired_before, self.list_devices())[:1]:
                btctl("trust", address)

    def forget(self, address: str) -> None:
        a = address.upper()
        if not ADDRESS.match(a):
            raise ValueError("bad address")
        btctl("remove", a)

    def disconnect_active(self) -> None:
        if self.active_addr:
            btctl("disconnect", self.active_addr)

    def list_devices(self) -> list[dict]:
        self.devices = parse_bt_devices(btctl("devices", "Paired"), btctl("devices", "Connected"))
        return self.devices

    def streaming(self) -> str | None:
        """The address of the device whose audio is playing now (BlueALSA's running A2DP PCM), else None."""
        try:
            out = subprocess.run(["bluealsa-cli", "list-pcms"], capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.TimeoutExpired):
            return None
        for pcm in out.split():
            if "a2dpsnk" not in pcm and "a2dp" not in pcm:
                continue
            try:
                info = subprocess.run(["bluealsa-cli", "info", pcm], capture_output=True, text=True, timeout=5).stdout
            except (OSError, subprocess.TimeoutExpired):
                continue
            if re.search(r"Running:\s*true", info) or "Running: yes" in info:
                m = re.search(r"dev_([0-9A-F_]{17})", pcm.upper())
                return m.group(1).replace("_", ":") if m else "unknown"
        return None

    def loop(self) -> None:
        while True:
            try:
                if self.pairing_until and (time.time() >= self.pairing_until
                                           or newly_paired(self.paired_before, self.list_devices())):
                    self.close_pairing()
                addr = self.streaming() if self.enabled else None
                if addr != self.active_addr:
                    self.active_addr = addr
                    name = next((d["name"] for d in self.list_devices() if d["address"] == addr), None) if addr else None
                    self.on_change(addr is not None, name)
            except Exception:  # noqa: BLE001 — Bluetooth hiccups never stop the speaker
                pass
            time.sleep(2)

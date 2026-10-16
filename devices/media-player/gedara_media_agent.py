#!/usr/bin/env python3
"""gedara-media-agent: the Raspberry Pi's music speaker for Gedara (Phase 7h, docs/media-player).

It plays through MPD and talks only to Gedara's media-agent Edge Function (protocol v1,
supabase/functions/_shared/media/protocol.ts):
  * pairing:  the Pi makes its own key, sends only its sha256, shows an 8-digit code;
  * sync:     a long-poll (<= 25 s) that returns as soon as Gedara sends a command; state changes
              (play, pause, next song, volume ...) are reported at once by a second, short sync;
  * songs uploaded in Gedara are downloaded from signed links and checked by sha256;
  * songs dropped into the "Gedara Music" network folder (Samba, /srv/gedara-music/pc) are found
    every 30 s, their tags and covers read, and reported;
  * the sleep timer (with fade-out), the volume limit and wind-down schedules run here, so they
    work even when the internet is down;
  * (0.2.0, Phase 7i) it is also an AirPlay and Bluetooth speaker (gedara_network.py): one source
    plays at a time, Gedara's music pauses for a phone and takes the speaker back on Play.

    gedara-media pair     make the key (once) and show the pairing code until Gedara has it
    gedara-media status   what the agent knows (no secrets)
    gedara-media run      the service (systemd: gedara-media-agent.service)

Nothing secret is printed. The key lives in /etc/gedara-media/key (readable by this service only).
Stdlib + python3-mpd + python3-mutagen (+ python3-pil for covers, optional).
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import random
import secrets
import shutil
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gedara_network import AirPlay, Bluetooth  # noqa: E402

VERSION = "0.2.1"
AGENT = f"gedara-media {VERSION}"
ROOT = Path(os.environ.get("GEDARA_MEDIA_ROOT", "/"))
CONF = ROOT / "etc/gedara-media"
KEY_FILE = CONF / "key"
SERVER_FILE = CONF / "server"  # "gedara" or "gedara-staging" (written by install.ps1)
OUTPUT_FILE = CONF / "output"  # "usb" / "jack" / "none" (written by setup-media.sh)
STATE_FILE = ROOT / "var/lib/gedara-media/state.json"
NORMALISE_FILE = ROOT / "var/lib/gedara-media/mpd-normalise.conf"
MUSIC = ROOT / "srv/gedara-music"
INBOX = MUSIC / "inbox"
PC = MUSIC / "pc"
TEST_TONE = ROOT / "usr/local/share/gedara-media/test-tone.wav"
SERVERS = {
    "gedara": "https://ltzlsxupcsamwtgqfejg.supabase.co/functions/v1/media-agent",
    "gedara-staging": "https://ebtvpsrehwdxepayqwma.supabase.co/functions/v1/media-agent",
}
try:
    TZ = ZoneInfo("Asia/Colombo")
except ZoneInfoNotFoundError:  # no tz database (e.g. tests on Windows); Sri Lanka has no daylight saving
    TZ = timezone(timedelta(hours=5, minutes=30))
EXT = {"audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/flac": "flac", "audio/ogg": "ogg", "audio/wav": "wav"}
AUDIO_SUFFIXES = {".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wav"}
MAX_DOWNLOAD = 62_914_560
LOW_SPACE = 200 * 1024 * 1024


def log(msg: str) -> None:
    print(f"{datetime.now(TZ):%H:%M:%S} {msg}", flush=True)


# ── Pure helpers (unit-tested in test_agent.py) ───────────────────────────────
def sniff(head: bytes) -> str | None:
    """A song's type from its first bytes (never from the file name), as Gedara does."""
    if head[:3] == b"ID3":
        return "audio/mpeg"
    if len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0 and (head[1] & 0x06) != 0:
        return "audio/mpeg"
    if head[:4] == b"fLaC":
        return "audio/flac"
    if head[:4] == b"OggS":
        return "audio/ogg"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav"
    if head[4:8] == b"ftyp" and head[8:12] in (b"M4A ", b"M4B ", b"mp42", b"isom", b"dash"):
        return "audio/mp4"
    return None


def inside(base: Path, rel: str) -> Path | None:
    """`rel` under `base`, or None when it would leave it (../, absolute paths)."""
    if not rel or rel.startswith("/") or ".." in rel.split("/"):
        return None
    p = (base / rel).resolve()
    try:
        p.relative_to(base.resolve())
    except ValueError:
        return None
    return p


def schedule_due(s: dict, now: datetime, fired: set[str]) -> str | None:
    """The firing key ("<id>@YYYY-MM-DD") if schedule `s` starts this minute and hasn't fired today."""
    if not (int(s.get("days", 0)) >> now.weekday()) & 1:
        return None
    if now.strftime("%H:%M") != s.get("start"):
        return None
    key = f"{s.get('id')}@{now:%Y-%m-%d}"
    return None if key in fired else key


def fade_steps(start: int, seconds: float, every: float = 0.25) -> list[int]:
    """Volumes for a fade from `start` to 0 over `seconds` (one per `every` s), ending at 0."""
    n = max(1, int(seconds / every))
    return [round(start * (1 - (i + 1) / n)) for i in range(n)]


def folder_diff(index: dict[str, dict], seen: dict[str, tuple[int, float]], now: float, settle: float = 10.0):
    """What changed in the PC folder: (to_read, removed). `index` is what was reported before
    ({file: {size, mtime, sha256}}), `seen` the files there now ({file: (size, mtime)}). A file
    written in the last `settle` seconds is left for the next round (it may still be copying)."""
    to_read = [f for f, (size, mtime) in seen.items()
               if now - mtime >= settle and (f not in index or index[f]["size"] != size or index[f]["mtime"] != mtime)]
    removed = [f for f in index if f not in seen]
    return sorted(to_read), sorted(removed)


def player_repeat(repeat: str, single: str) -> str:
    if repeat == "1" and single == "1":
        return "one"
    return "all" if repeat == "1" else "off"


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


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_key() -> str | None:
    try:
        k = KEY_FILE.read_text(encoding="ascii").strip()
        return k if len(k) == 43 else None
    except OSError:
        return None


def server_url() -> str:
    try:
        name = SERVER_FILE.read_text(encoding="ascii").strip()
    except OSError:
        name = "gedara"
    return SERVERS.get(name, SERVERS["gedara"])


# ── HTTP ──────────────────────────────────────────────────────────────────────
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


# ── Tags + covers (mutagen, Pillow) ───────────────────────────────────────────
def read_tags(path: Path) -> dict:
    out: dict = {}
    try:
        import mutagen  # noqa: PLC0415

        easy = mutagen.File(str(path), easy=True)
        if easy is not None:
            def first(k):
                v = easy.get(k)
                return str(v[0]).strip()[:200] if v else None

            out = {k: v for k, v in {"title": first("title"), "artist": first("artist") or first("albumartist"), "album": first("album")}.items() if v}
            tn = first("tracknumber")
            if tn and tn.split("/")[0].isdigit() and int(tn.split("/")[0]) <= 999:
                out["track_no"] = int(tn.split("/")[0])
            if getattr(easy, "info", None) and getattr(easy.info, "length", None):
                out["duration_s"] = round(min(float(easy.info.length), 86_399), 3)
    except Exception as e:  # noqa: BLE001 — a damaged tag never stops a song
        log(f"[FOLDER] tags of {path.name}: {e.__class__.__name__}")
    return out


def read_cover(path: Path) -> bytes | None:
    """The embedded cover as a 320 px WebP (None without a cover, or without Pillow)."""
    try:
        import mutagen  # noqa: PLC0415
        from PIL import Image  # noqa: PLC0415

        f = mutagen.File(str(path))
        data = None
        if f is None:
            return None
        if hasattr(f, "pictures") and f.pictures:  # FLAC
            data = f.pictures[0].data
        elif f.tags is not None:
            if hasattr(f.tags, "getall"):  # ID3
                apic = f.tags.getall("APIC")
                data = apic[0].data if apic else None
            elif "covr" in f.tags:  # MP4
                data = bytes(f.tags["covr"][0])
        if not data:
            return None
        img = Image.open(io.BytesIO(data)).convert("RGB")
        img.thumbnail((320, 320))
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=72)
        return buf.getvalue() if buf.tell() <= 300_000 else None
    except Exception:  # noqa: BLE001
        return None


# ── The agent ─────────────────────────────────────────────────────────────────
class Agent:
    def __init__(self, key: str):
        self.key = key
        self.url = server_url()
        self.started = time.time()
        self.state = load_json(STATE_FILE, {})
        self.state.setdefault("folder", {})  # file -> {size, mtime, sha256}
        self.state.setdefault("fired", [])
        self.lock = threading.RLock()  # outbox + state
        self.mpd_lock = threading.RLock()
        self.outbox: dict[str, list] = {"done": [], "downloaded": [], "deleted": [], "pc_added": [], "pc_removed": [], "played": [], "art": []}
        self.queue_ids: list[str] = []  # Gedara ids, aligned with MPD's playlist
        self.sleep_until: float | None = None
        self.sleep_fade = 8
        self.covers: dict[str, bytes] = {}  # sha256 -> webp, waiting for their song row
        self.downloading: set[str] = set()
        self.rescan = threading.Event()
        self.report_now = threading.Event()
        self.last_song: tuple[str | None, float] = (None, 0.0)
        self.external: dict | None = None  # {"source": "airplay" | "bluetooth", "name": str | None}
        self.network_applied: tuple | None = None
        self.airplay = AirPlay(lambda on, name: self.on_external("airplay", on, name))
        self.bt = Bluetooth(lambda on, name: self.on_external("bluetooth", on, name))
        self.mpd = self.connect()

    # MPD ──────────────────────────────────────────────────────────────────────
    def connect(self):
        from mpd import MPDClient  # noqa: PLC0415

        c = MPDClient()
        c.timeout = 10
        c.idletimeout = None
        for attempt in range(30):
            try:
                c.connect("localhost", 6600)
                return c
            except OSError:
                time.sleep(min(10, 1 + attempt))
        raise SystemExit("MPD isn't running (systemctl status mpd)")

    def call(self, name: str, *args):
        with self.mpd_lock:
            for attempt in range(2):
                try:
                    return getattr(self.mpd, name)(*args)
                except (ConnectionError, OSError, BrokenPipeError):
                    if attempt:
                        raise
                    self.mpd = self.connect()
        return None

    def settings(self) -> dict:
        return {"volume_max": 80, "fade_s": 8, "normalise": True, **self.state.get("settings", {})}

    def report(self) -> dict:
        st = self.call("status") or {}
        state = {"play": "playing", "pause": "paused"}.get(st.get("state", "stop"), "stopped")
        pos = int(st["song"]) if "song" in st else None
        track = self.queue_ids[pos] if pos is not None and pos < len(self.queue_ids) else None
        until = self.sleep_until
        return {
            "state": state,
            "track_id": track if state != "stopped" else None,
            "elapsed_s": round(float(st.get("elapsed", 0)), 1),
            "duration_s": round(float(st["duration"]), 1) if st.get("duration") else None,
            "volume": max(0, min(100, int(st.get("volume", 0)) if st.get("volume", "-1") != "-1" else 0)),
            "sleep_until_ms": int(until * 1000) if until else None,
            "shuffle": st.get("random") == "1",
            "repeat": player_repeat(st.get("repeat", "0"), st.get("single", "0")),
            "queue": self.queue_ids[:500],
            "queue_index": pos if track else None,
            "source": self.external["source"] if self.external else "gedara",
            "source_name": (self.external or {}).get("name"),
        }

    def status(self) -> dict:
        du = shutil.disk_usage(MUSIC if MUSIC.exists() else ROOT)
        temp = None
        try:
            temp = int(Path("/sys/class/thermal/thermal_zone0/temp").read_text()) / 1000
        except (OSError, ValueError):
            pass
        try:
            output = OUTPUT_FILE.read_text().strip()
        except OSError:
            output = "none"
        files = sum(1 for p in MUSIC.rglob("*") if p.suffix.lower() in AUDIO_SUFFIXES) if MUSIC.exists() else 0
        out = {"output": output if output in ("usb", "jack", "none") else "none", "disk_free_mb": du.free // 1048576,
               "disk_total_mb": du.total // 1048576, "mpd": True, "files": files}
        if temp is not None:
            out["temp_c"] = round(temp, 1)
        out["airplay"] = bool(self.settings().get("airplay", True))
        # Bluetooth's thread keeps these fresh: a report never waits on bluetoothctl (a slow answer
        # here made Gedara say "the speaker didn't answer").
        out["bluetooth"] = self.bt.last_state
        if out["bluetooth"] != "none":
            out["bt_devices"] = list(self.bt.devices)
        return out

    # One source at a time (Phase 7i) ───────────────────────────────────────────
    def on_external(self, source: str, on: bool, name: str | None) -> None:
        with self.lock:
            if on:
                self.external = {"source": source, "name": name}
            elif self.external and self.external["source"] == source:
                self.external = None
        if on:
            st = self.call("status") or {}
            if st.get("state") == "play":
                self.call("pause", 1)  # Gedara's music makes way for the phone
            log(f"[SOURCE] {source} from {name or 'a phone'}")
        self.report_now.set()

    def take_over(self) -> None:
        with self.lock:
            ext, self.external = self.external, None
        if not ext:
            return
        if ext["source"] == "airplay":
            AirPlay.stop_session()
        else:
            self.bt.disconnect_active()
        log(f"[SOURCE] Gedara takes the speaker back from {ext['source']}")
        time.sleep(0.8)

    def apply_network(self, name: str) -> None:
        s = self.settings()
        want = (bool(s.get("airplay", True)), bool(s.get("bluetooth", True)), name)
        if want == self.network_applied:
            return
        self.network_applied = want
        AirPlay.configure(want[0], name)
        self.bt.configure(want[1], name)

    # One conversation ─────────────────────────────────────────────────────────
    def sync(self, wait: bool) -> dict | None:
        with self.lock:
            taken = {k: v[:20] if k in ("pc_added", "downloaded", "played", "art") else v[:100] for k, v in self.outbox.items() if v}
            for k, v in taken.items():
                del self.outbox[k][: len(v)]
        body = {"action": "sync", "v": 1, "agent": AGENT, "up": int(time.time() - self.started), "wait": wait and not taken,
                "status": self.status(), "player": self.report(),
                "known": {"settings_v": str(self.state.get("settings_v")) if "settings_v" in self.state else None,
                          "schedules_v": self.state.get("schedules_v")}}
        body.update(taken)
        try:
            reply = post(self.url, body, self.key, timeout=45 if body["wait"] else 20)
        except Exception:
            with self.lock:  # nothing is lost: it goes again next time
                for k, v in taken.items():
                    self.outbox[k][:0] = v
            raise
        self.handle(reply)
        if taken.get("pc_added"):
            self.upload_covers([s["sha256"] for s in taken["pc_added"]])
        return reply

    def handle(self, r: dict) -> None:
        with self.lock:
            if "settings" in r:
                self.state["settings"] = r["settings"] or {}
                self.state["settings_v"] = r.get("settings_v")
                self.apply_normalise()
            if r.get("name"):
                threading.Thread(target=self.apply_network, args=(r["name"],), daemon=True).start()
            if "schedules" in r:
                self.state["schedules"] = r["schedules"] or []
                self.state["schedules_v"] = r.get("schedules_v")
            save_json(STATE_FILE, self.state)
        for c in r.get("commands", []):
            ok, err = True, None
            try:
                self.run_command(c["command"], c.get("args") or {})
            except Exception as e:  # noqa: BLE001
                ok, err = False, str(e)[:200]
                log(f"[CMD] {c['command']} failed: {err}")
            with self.lock:
                self.outbox["done"].append({"id": c["id"], "ok": ok, **({"error": err} if err else {})})
        for d in r.get("downloads", []):
            if d["id"] not in self.downloading:
                self.downloading.add(d["id"])
                threading.Thread(target=self.download, args=(d,), daemon=True).start()
        for d in r.get("deletions", []):
            self.delete_file(d)
        if r.get("commands") or r.get("deletions"):
            self.report_now.set()

    # Commands ─────────────────────────────────────────────────────────────────
    def run_command(self, name: str, a: dict) -> None:
        cap = int(self.settings()["volume_max"])
        if name in ("play", "resume") and self.external:
            self.take_over()
        if name == "play":
            self.load_queue(a.get("queue") or [])
            self.call("random", 1 if a.get("shuffle") else 0)
            if self.queue_ids:
                self.call("play", min(int(a.get("index", 0)), len(self.queue_ids) - 1))
        elif name == "pause":
            self.call("pause", 1)
        elif name == "resume":
            st = self.call("status") or {}
            self.call("play") if st.get("state") == "stop" else self.call("pause", 0)
        elif name == "stop":
            self.call("stop")
        elif name == "next":
            self.call("next")
        elif name == "prev":
            self.call("previous")
        elif name == "seek":
            self.call("seekcur", str(float(a.get("s", 0))))
        elif name == "volume":
            self.call("setvol", max(0, min(int(a.get("v", 50)), cap)))
        elif name == "sleep":
            minutes = int(a.get("minutes", 0))
            self.sleep_fade = int(a.get("fade_s", self.settings()["fade_s"]))
            if a.get("end_of_track"):
                self.call("single", 1)  # MPD stops after this song
                self.sleep_until = None
            else:
                self.call("single", 0)
                self.sleep_until = time.time() + minutes * 60 if minutes > 0 else None
        elif name == "shuffle":
            self.call("random", 1 if a.get("on") else 0)
        elif name == "repeat":
            mode = a.get("mode", "off")
            self.call("repeat", 0 if mode == "off" else 1)
            self.call("single", 1 if mode == "one" else 0)
        elif name == "queue_add":
            st = self.call("status") or {}
            at = int(st["song"]) + 1 if a.get("next") and "song" in st else None
            for i, song in enumerate(a.get("tracks") or []):
                p = inside(MUSIC, song.get("file") or "")
                if not p or not p.exists():
                    continue
                if at is None:
                    self.call("add", song["file"])
                    self.queue_ids.append(song["id"])
                else:
                    self.call("addid", song["file"], at + i)
                    self.queue_ids.insert(at + i, song["id"])
        elif name == "queue_move":
            f, t = int(a["from"]), int(a["to"])
            self.call("move", f, t)
            self.queue_ids.insert(t, self.queue_ids.pop(f))
        elif name == "queue_remove":
            i = int(a["index"])
            self.call("delete", i)
            del self.queue_ids[i]
        elif name == "test_tone":
            self.test_tone()
        elif name == "rescan":
            self.rescan.set()
        elif name == "bt_pair":
            self.bt.open_pairing(int(a.get("seconds", 120)))
        elif name == "bt_forget":
            self.bt.forget(str(a.get("address", "")))
        else:
            raise ValueError(f"unknown command {name}")

    def load_queue(self, songs: list[dict]) -> None:
        self.call("clear")
        self.queue_ids = []
        for s in songs:
            p = inside(MUSIC, s.get("file") or "")
            if p and p.exists():
                try:
                    self.call("add", s["file"])
                    self.queue_ids.append(s["id"])
                except Exception as e:  # noqa: BLE001 — not in MPD's database yet: update and retry once
                    log(f"[CMD] add {s['file']}: {e}")
        self.call("single", 0)

    def test_tone(self) -> None:
        st = self.call("status") or {}
        was_playing = st.get("state") == "play"
        if was_playing:
            self.call("pause", 1)
            time.sleep(0.4)
        subprocess.run(["aplay", "-q", str(TEST_TONE)], check=True, timeout=10)
        if was_playing:
            self.call("pause", 0)

    def apply_normalise(self) -> None:
        """MPD's volume normalisation is a config setting: write it; a systemd path unit
        (gedara-mpd-normalise.path, setup-media.sh) restarts MPD when the file changes."""
        want = 'volume_normalization "yes"\n' if self.settings().get("normalise", True) else 'volume_normalization "no"\n'
        try:
            if NORMALISE_FILE.exists() and NORMALISE_FILE.read_text() == want:
                return
            NORMALISE_FILE.write_text(want)
            time.sleep(4)  # MPD restarts
            with self.mpd_lock:
                self.mpd = self.connect()
        except OSError as e:
            log(f"[SETTINGS] normalise: {e}")

    # Songs from Gedara ────────────────────────────────────────────────────────
    def download(self, d: dict) -> None:
        ext = EXT.get(d.get("mime", ""), "bin")
        rel = f"inbox/{d['id']}.{ext}"
        final = MUSIC / rel
        part = INBOX / f".part-{d['id']}"
        try:
            if int(d["size_bytes"]) > MAX_DOWNLOAD:
                raise ValueError("too large")
            if shutil.disk_usage(MUSIC).free < int(d["size_bytes"]) + LOW_SPACE:
                raise ValueError("the speaker's card is full")
            if not d.get("url"):
                raise ValueError("no link")
            INBOX.mkdir(parents=True, exist_ok=True)
            h = hashlib.sha256()
            size = 0
            req = urllib.request.Request(d["url"], headers={"User-Agent": AGENT})
            with urllib.request.urlopen(req, timeout=60, context=CTX) as res, part.open("wb") as out:
                head = b""
                for chunk in iter(lambda: res.read(1 << 16), b""):
                    size += len(chunk)
                    if size > MAX_DOWNLOAD:
                        raise ValueError("too large")
                    if len(head) < 16:
                        head += chunk[:16]
                    h.update(chunk)
                    out.write(chunk)
            if h.hexdigest() != d["sha256"].lower():
                raise ValueError("sha256 mismatch")
            if sniff(head) is None:
                raise ValueError("not a song")
            os.replace(part, final)
            self.call("update", "inbox")
            time.sleep(1.5)  # let MPD see the file before it is asked to play it
            with self.lock:
                self.outbox["downloaded"].append({"id": d["id"], "ok": True, "file": rel})
            log(f"[SONG] downloaded {rel} ({size // 1024} KB)")
        except Exception as e:  # noqa: BLE001
            part.unlink(missing_ok=True)
            with self.lock:
                self.outbox["downloaded"].append({"id": d["id"], "ok": False, "error": str(e)[:200]})
            log(f"[SONG] download failed: {e}")
        finally:
            self.downloading.discard(d["id"])
            self.report_now.set()

    def delete_file(self, d: dict) -> None:
        p = inside(MUSIC, d.get("file") or "")
        if p and p.is_file():
            p.unlink(missing_ok=True)
            with self.lock:
                self.state["folder"].pop(d["file"], None)
            self.call("update")
        with self.lock:
            self.outbox["deleted"].append(d["id"])

    # The PC's "Gedara Music" folder ───────────────────────────────────────────
    def scan_folder(self) -> None:
        if not PC.exists():
            return
        seen: dict[str, tuple[int, float]] = {}
        for p in PC.rglob("*"):
            if p.is_file() and p.suffix.lower() in AUDIO_SUFFIXES and not p.name.startswith("."):
                st = p.stat()
                seen[str(p.relative_to(MUSIC)).replace(os.sep, "/")] = (st.st_size, st.st_mtime)
        with self.lock:
            index = dict(self.state["folder"])
        to_read, removed = folder_diff(index, seen, time.time())
        added = []
        for rel in to_read[:20]:
            p = MUSIC / rel
            try:
                with p.open("rb") as f:
                    mime = sniff(f.read(16))
                if not mime:
                    continue
                sha = sha256_file(p)
                tags = read_tags(p)
                cover = read_cover(p)
                if cover:
                    self.covers[sha] = cover
                size, mtime = seen[rel]
                added.append({"sha256": sha, "file": rel, "size_bytes": size, "mime": mime,
                              "title": tags.pop("title", None) or p.stem[:200], **tags})
                with self.lock:
                    self.state["folder"][rel] = {"size": size, "mtime": mtime, "sha256": sha}
            except OSError as e:
                log(f"[FOLDER] {rel}: {e}")
        with self.lock:
            for rel in removed:
                self.state["folder"].pop(rel, None)
            self.outbox["pc_added"].extend(added)
            self.outbox["pc_removed"].extend(removed)
            save_json(STATE_FILE, self.state)
        if added or removed:
            self.call("update", "pc")
            log(f"[FOLDER] {len(added)} new, {len(removed)} gone")
            self.report_now.set()

    def upload_covers(self, shas: list[str]) -> None:
        for sha in shas:
            data = self.covers.pop(sha, None)
            if not data:
                continue
            try:
                r = post(self.url, {"action": "art_upload", "sha256": sha}, self.key, timeout=20)
                req = urllib.request.Request(r["url"], data=data, method="PUT",
                                             headers={"Content-Type": "image/webp", "x-upsert": "true", "User-Agent": AGENT})
                with urllib.request.urlopen(req, timeout=30, context=CTX):
                    pass
                with self.lock:
                    self.outbox["art"].append({"sha256": sha, "art_path": r["path"]})
            except Exception as e:  # noqa: BLE001 — a song without its cover is fine
                log(f"[FOLDER] cover: {e}")

    # Clocks: sleep timer, played songs, schedules ──────────────────────────────
    def fade_and_pause(self, seconds: float) -> None:
        st = self.call("status") or {}
        start = int(st.get("volume", 0)) if st.get("volume", "-1") != "-1" else 0
        for v in fade_steps(start, seconds):
            self.call("setvol", v)
            time.sleep(0.25)
        self.call("pause", 1)
        self.call("setvol", start)  # the next song starts at the old volume

    def clocks(self) -> None:
        fired = set(self.state.get("fired", []))
        while True:
            try:
                if self.sleep_until and time.time() >= self.sleep_until:
                    self.sleep_until = None
                    log("[SLEEP] fading out")
                    self.fade_and_pause(self.sleep_fade)
                    self.report_now.set()
                st = self.call("status") or {}
                song = self.queue_ids[int(st["song"])] if "song" in st and int(st["song"]) < len(self.queue_ids) else None
                prev, since = self.last_song
                if song != prev:
                    if prev and time.time() - since >= 30:
                        with self.lock:
                            self.outbox["played"].append({"id": prev, "at_ms": int(time.time() * 1000)})
                    self.last_song = (song, time.time())
                now = datetime.now(TZ)
                for s in self.state.get("schedules", []):
                    key = schedule_due(s, now, fired)
                    if key:
                        fired.add(key)
                        self.state["fired"] = sorted(fired)[-50:]
                        self.start_schedule(s)
            except Exception as e:  # noqa: BLE001
                log(f"[CLOCK] {e}")
            time.sleep(1)

    def start_schedule(self, s: dict) -> None:
        log(f"[SCHEDULE] {s.get('name')}")
        songs = list(s.get("tracks") or [])
        if s.get("shuffle"):
            random.shuffle(songs)
        if not songs:
            return
        self.load_queue(songs)
        self.call("setvol", min(int(s.get("volume", 35)), int(self.settings()["volume_max"])))
        self.call("random", 0)
        self.call("play", 0)
        stop = s.get("stop_after_min")
        self.sleep_fade = int(s.get("fade_s", 30))
        self.sleep_until = time.time() + int(stop) * 60 if stop else None
        self.report_now.set()

    # Threads ──────────────────────────────────────────────────────────────────
    def watcher(self) -> None:
        """MPD tells us when something changes (song, pause, volume): report it at once."""
        from mpd import MPDClient  # noqa: PLC0415

        while True:
            try:
                c = MPDClient()
                c.connect("localhost", 6600)
                while True:
                    c.idle("player", "mixer", "options", "playlist")
                    self.report_now.set()
            except Exception:  # noqa: BLE001
                time.sleep(3)

    def reporter(self) -> None:
        while True:
            self.report_now.wait()
            self.report_now.clear()
            time.sleep(0.15)  # several changes at once go in one report
            try:
                self.sync(wait=False)
            except Exception as e:  # noqa: BLE001
                log(f"[NET] report: {e}")
                time.sleep(3)
                self.report_now.set()

    def folder_loop(self) -> None:
        while True:
            try:
                self.scan_folder()
            except Exception as e:  # noqa: BLE001
                log(f"[FOLDER] {e}")
            self.rescan.wait(30)
            self.rescan.clear()

    def run(self) -> None:
        log(f"{AGENT} → {self.url.split('//')[1].split('.')[0]}")
        for fn in (self.watcher, self.reporter, self.clocks, self.folder_loop, self.airplay.loop, self.bt.loop):
            threading.Thread(target=fn, daemon=True).start()
        backoff = 1.0
        while True:
            try:
                r = self.sync(wait=True)
                backoff = 1.0
                if r and r.get("sync_now"):
                    continue
            except HttpError as e:
                if e.status == 401:
                    log("[NET] Gedara doesn't know this speaker any more (removed?). Pair it again: gedara-media pair")
                    time.sleep(300)
                else:
                    log(f"[NET] {e}")
                    time.sleep(backoff)
                    backoff = min(60.0, backoff * 2) * (0.8 + 0.4 * random.random())
            except Exception as e:  # noqa: BLE001 — network down: try again, slower and slower
                log(f"[NET] {e.__class__.__name__}: {e}")
                time.sleep(backoff)
                backoff = min(60.0, backoff * 2) * (0.8 + 0.4 * random.random())


# ── CLI ───────────────────────────────────────────────────────────────────────
def cmd_pair() -> int:
    key = read_key()
    if not key:
        key = secrets.token_urlsafe(32)[:43]
        CONF.mkdir(parents=True, exist_ok=True)
        fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="ascii") as f:
            f.write(key)
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            try:
                shutil.chown(KEY_FILE, "gedara-media", "gedara-media")  # only the service reads it
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
    print("  In Gedara: Settings › Devices › Music speakers › Add speaker, type this code.")
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


def cmd_status() -> int:
    state = load_json(STATE_FILE, {})
    print(json.dumps({"agent": AGENT, "server": server_url().split("//")[1].split(".")[0], "paired_key": bool(read_key()),
                      "settings": state.get("settings"), "schedules": [s.get("name") for s in state.get("schedules", [])],
                      "folder_songs": len(state.get("folder", {}))}, indent=2))
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="gedara-media")
    ap.add_argument("command", choices=["pair", "status", "run"])
    a = ap.parse_args(argv)
    if a.command == "pair":
        return cmd_pair()
    if a.command == "status":
        return cmd_status()
    key = read_key()
    if not key:
        log("not paired yet: run  gedara-media pair")
        time.sleep(60)
        return 1
    Agent(key).run()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

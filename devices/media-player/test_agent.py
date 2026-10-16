"""Unit tests for gedara-media-agent's pure logic (no MPD, no network).

    py -m unittest devices/media-player/test_agent.py     (from the repo root, or in this folder)
"""
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gedara_media_agent as a  # noqa: E402
import gedara_network as n  # noqa: E402


class Sniff(unittest.TestCase):
    def test_songs_by_first_bytes(self):
        self.assertEqual(a.sniff(b"ID3\x04\0\0"), "audio/mpeg")
        self.assertEqual(a.sniff(bytes([0xFF, 0xFB, 0x90, 0x64])), "audio/mpeg")
        self.assertEqual(a.sniff(b"fLaC\0\0"), "audio/flac")
        self.assertEqual(a.sniff(b"OggS\0\x02"), "audio/ogg")
        self.assertEqual(a.sniff(b"RIFF\x10\0\0\0WAVEfmt "), "audio/wav")
        self.assertEqual(a.sniff(b"\0\0\0\x20ftypM4A "), "audio/mp4")

    def test_not_songs(self):
        self.assertIsNone(a.sniff(b"%PDF-1.7"))
        self.assertIsNone(a.sniff(bytes([0xFF, 0xD8, 0xFF, 0xE0])))  # JPEG
        self.assertIsNone(a.sniff(bytes([0xFF, 0xF1, 0x50, 0x80])))  # ADTS AAC is not MP3
        self.assertIsNone(a.sniff(b"\0\0\0\x20ftypqt  "))


class Inside(unittest.TestCase):
    def test_only_inside_the_music_folder(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            self.assertEqual(a.inside(base, "pc/Album/song.mp3"), (base / "pc/Album/song.mp3").resolve())
            self.assertIsNone(a.inside(base, "../etc/passwd"))
            self.assertIsNone(a.inside(base, "pc/../../x"))
            self.assertIsNone(a.inside(base, "/etc/passwd"))
            self.assertIsNone(a.inside(base, ""))


class Schedules(unittest.TestCase):
    s = {"id": "s1", "days": 0b0011111, "start": "21:30"}  # Monday–Friday

    def test_fires_on_its_minute_and_day_once(self):
        monday = datetime(2026, 10, 12, 21, 30, 5, tzinfo=a.TZ)
        self.assertEqual(a.schedule_due(self.s, monday, set()), "s1@2026-10-12")
        self.assertIsNone(a.schedule_due(self.s, monday, {"s1@2026-10-12"}))

    def test_not_at_other_times_or_days(self):
        self.assertIsNone(a.schedule_due(self.s, datetime(2026, 10, 12, 21, 31, tzinfo=a.TZ), set()))
        saturday = datetime(2026, 10, 17, 21, 30, tzinfo=a.TZ)
        self.assertIsNone(a.schedule_due(self.s, saturday, set()))


class Fade(unittest.TestCase):
    def test_steps_down_to_zero(self):
        steps = a.fade_steps(60, 2)
        self.assertEqual(len(steps), 8)
        self.assertEqual(steps[-1], 0)
        self.assertTrue(all(x >= y for x, y in zip(steps, steps[1:])))

    def test_no_fade_still_ends_at_zero(self):
        self.assertEqual(a.fade_steps(40, 0), [0])


class Folder(unittest.TestCase):
    def test_new_changed_settling_and_removed(self):
        index = {"pc/a.mp3": {"size": 10, "mtime": 100.0, "sha256": "x"}, "pc/gone.mp3": {"size": 5, "mtime": 50.0, "sha256": "y"},
                 "pc/b.mp3": {"size": 20, "mtime": 100.0, "sha256": "z"}}
        seen = {"pc/a.mp3": (10, 100.0), "pc/b.mp3": (21, 200.0), "pc/new.mp3": (7, 300.0), "pc/copying.mp3": (3, 995.0)}
        to_read, removed = a.folder_diff(index, seen, now=1000.0)
        self.assertEqual(to_read, ["pc/b.mp3", "pc/new.mp3"])
        self.assertEqual(removed, ["pc/gone.mp3"])


class Repeat(unittest.TestCase):
    def test_modes(self):
        self.assertEqual(a.player_repeat("0", "0"), "off")
        self.assertEqual(a.player_repeat("1", "0"), "all")
        self.assertEqual(a.player_repeat("1", "1"), "one")


def _item(typ: str, code: str, data: bytes = b"") -> bytes:
    import base64
    body = f'<item><type>{typ.encode().hex()}</type><code>{code.encode().hex()}</code><length>{len(data)}</length>'
    if data:
        body += '\n<data encoding="base64">\n' + base64.b64encode(data).decode() + "</data>"
    return (body + "</item>\n").encode()


class AirPlayMetadata(unittest.TestCase):
    def test_start_name_stop_from_the_pipe(self):
        buf = _item("ssnc", "pbeg") + _item("core", "asar", b"Artist") + _item("ssnc", "snam", "Didula's iPhone".encode()) + _item("ssnc", "pend")
        items, rest = n.metadata_items(buf)
        events = [e for e in (n.airplay_event(*i) for i in items) if e]
        self.assertEqual(events, [("start", None), ("name", "Didula's iPhone"), ("stop", None)])
        self.assertEqual(rest.strip(), b"")

    def test_a_half_item_waits_for_the_rest(self):
        whole = _item("ssnc", "snam", b"iPad")
        items, rest = n.metadata_items(whole[:20])
        self.assertEqual(items, [])
        items, _ = n.metadata_items(rest + whole[20:])
        self.assertEqual(n.airplay_event(*items[0]), ("name", "iPad"))


class BluetoothLists(unittest.TestCase):
    def test_paired_and_connected(self):
        paired = "Device aa:bb:cc:dd:ee:01 Pixel 7\nDevice AA:BB:CC:DD:EE:02 Laptop\nnoise line\n"
        connected = "Device AA:BB:CC:DD:EE:01 Pixel 7\n"
        self.assertEqual(n.parse_bt_devices(paired, connected), [
            {"address": "AA:BB:CC:DD:EE:01", "name": "Pixel 7", "connected": True},
            {"address": "AA:BB:CC:DD:EE:02", "name": "Laptop", "connected": False},
        ])

    def test_only_new_devices_count_as_paired_in_the_window(self):
        before = {"AA:BB:CC:DD:EE:01"}
        now = [{"address": "AA:BB:CC:DD:EE:01"}, {"address": "AA:BB:CC:DD:EE:02"}]
        self.assertEqual(n.newly_paired(before, now), ["AA:BB:CC:DD:EE:02"])
        self.assertEqual(n.newly_paired({"AA:BB:CC:DD:EE:01", "AA:BB:CC:DD:EE:02"}, now), [])

    def test_names_are_safe_for_config_files(self):
        self.assertEqual(n.safe_name('Living room"; x = "y'), "Living room x y")
        self.assertEqual(n.safe_name("Didula's speaker"), "Didula's speaker")
        self.assertEqual(n.safe_name('"\\'), "Gedara speaker")

    def test_pairing_window_counts_down_and_closes(self):
        self.assertEqual(n.pairing_left(1000.0 + 120, 1000.0), 120)
        self.assertEqual(n.pairing_left(1000.0 + 120, 1121.0), 0)
        self.assertEqual(n.pairing_left(None, 5.0), 0)

    def test_adapter_seen_without_asking_bluetoothd(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertFalse(n.has_adapter(Path(d)))
            (Path(d) / "hci0").mkdir()
            self.assertTrue(n.has_adapter(Path(d)))
        self.assertFalse(n.has_adapter(Path(d) / "gone"))


if __name__ == "__main__":
    unittest.main()

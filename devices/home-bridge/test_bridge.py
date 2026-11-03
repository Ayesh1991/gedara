"""Unit tests for gedara-home's pure logic (no Home Assistant, no network).

    py -m unittest devices/home-bridge/test_bridge.py     (from the repo root, or in this folder)
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gedara_home_bridge as b  # noqa: E402

AC = {"entity_id": "climate.bedroom_ac", "state": "cool",
      "attributes": {"friendly_name": "AC", "current_temperature": 28.9, "temperature": 24, "min_temp": 16, "max_temp": 30,
                     "hvac_modes": ["off", "cool", "dry", "fan_only"], "target_temp_step": 0.5, "fan_mode": "auto"},
      "last_changed": "2026-10-20T08:00:00.123456+00:00"}
VAPORIZER = {"entity_id": "switch.mosquito_vaporizer", "state": "off", "attributes": {"friendly_name": "Mosquito Vaporizer"}}
KNOWN = {AC["entity_id"]: AC, VAPORIZER["entity_id"]: VAPORIZER,
         "light.mist_rgb": {"entity_id": "light.mist_rgb", "state": "on", "attributes": {}}}


class Kinds(unittest.TestCase):
    def test_what_gedara_shows(self):
        self.assertEqual(b.kind_of("binary_sensor.bedroom_window_1", {"device_class": "window"}), "window")
        self.assertEqual(b.kind_of("binary_sensor.front_door", {"device_class": "door"}), "door")
        self.assertEqual(b.kind_of("binary_sensor.garage", {"device_class": "garage_door"}), "door")
        self.assertEqual(b.kind_of("binary_sensor.x", {"device_class": "opening", "friendly_name": "Living Room Window 3"}), "window")
        self.assertEqual(b.kind_of("binary_sensor.y", {"device_class": "opening", "friendly_name": "Back gate"}), "door")
        self.assertEqual(b.kind_of("light.mist_rgb", {}), "light")
        self.assertEqual(b.kind_of("switch.vaporizer", {}), "switch")
        self.assertEqual(b.kind_of("climate.ac", {}), "climate")

    def test_what_it_never_shows(self):
        self.assertIsNone(b.kind_of("binary_sensor.motion", {"device_class": "motion"}))
        self.assertIsNone(b.kind_of("lock.front_door", {}))
        self.assertIsNone(b.kind_of("alarm_control_panel.home", {}))
        self.assertIsNone(b.kind_of("camera.nvt", {}))
        self.assertIsNone(b.kind_of("script.open_everything", {}))
        self.assertIsNone(b.kind_of("Not An Id", {}))


class Catalog(unittest.TestCase):
    def test_rooms_from_the_entity_or_its_device(self):
        states = [
            {"entity_id": "binary_sensor.bedroom_window_2", "state": "on", "attributes": {"device_class": "window", "friendly_name": "Bedroom Window 2"}},
            VAPORIZER, AC,
            {"entity_id": "switch.hidden_one", "state": "off", "attributes": {}},
            {"entity_id": "switch.esp_restart", "state": "off", "attributes": {}},
            {"entity_id": "sensor.bedroom_temperature", "state": "28.9", "attributes": {}},
        ]
        entities = [
            {"entity_id": "binary_sensor.bedroom_window_2", "area_id": None, "device_id": "dev1"},
            {"entity_id": "switch.mosquito_vaporizer", "area_id": "bedroom", "device_id": None},
            {"entity_id": "switch.hidden_one", "hidden_by": "user"},
            {"entity_id": "switch.esp_restart", "entity_category": "config"},
        ]
        devices = [{"id": "dev1", "area_id": "bedroom"}]
        areas = [{"area_id": "bedroom", "name": "Bedroom"}]
        cat = b.build_catalog(states, entities, devices, areas)
        self.assertEqual([c["entity_id"] for c in cat], ["binary_sensor.bedroom_window_2", "climate.bedroom_ac", "switch.mosquito_vaporizer"])
        self.assertEqual(cat[0], {"entity_id": "binary_sensor.bedroom_window_2", "domain": "binary_sensor", "kind": "window",
                                  "name": "Bedroom Window 2", "area": "Bedroom", "device_class": "window"})
        self.assertIsNone(cat[1]["area"])  # no registry entry: no room ("Other" in Gedara)
        self.assertEqual(cat[2]["area"], "Bedroom")


class States(unittest.TestCase):
    def test_ac_keeps_only_what_gedara_shows(self):
        r = b.state_report(AC)
        self.assertEqual(r["state"], "cool")
        self.assertEqual(r["changed_at"], "2026-10-20T08:00:00.123456+00:00")
        self.assertEqual(r["attrs"], {"current_temperature": 28.9, "temperature": 24.0, "min_temp": 16.0, "max_temp": 30.0,
                                      "target_temp_step": 0.5, "hvac_modes": ["off", "cool", "dry", "fan_only"]})

    def test_others_have_no_attributes(self):
        self.assertEqual(b.state_report({"entity_id": "binary_sensor.w", "state": "off", "attributes": {"secret": 1}}),
                         {"entity_id": "binary_sensor.w", "state": "off"})


class Allowed(unittest.TestCase):
    def test_the_controls_gedara_has(self):
        self.assertEqual(b.plan_call({"entity_id": "switch.mosquito_vaporizer", "action": "turn_on"}, KNOWN), ("switch", "turn_on", {}))
        self.assertEqual(b.plan_call({"entity_id": "light.mist_rgb", "action": "turn_off"}, KNOWN), ("light", "turn_off", {}))
        self.assertEqual(b.plan_call({"entity_id": "climate.bedroom_ac", "action": "set_temperature", "args": {"temperature": 24.5}}, KNOWN),
                         ("climate", "set_temperature", {"temperature": 24.5}))
        self.assertEqual(b.plan_call({"entity_id": "climate.bedroom_ac", "action": "set_hvac_mode", "args": {"hvac_mode": "dry"}}, KNOWN),
                         ("climate", "set_hvac_mode", {"hvac_mode": "dry"}))

    def test_refused_whatever_gedara_asks(self):
        bad = [
            {"entity_id": "lock.front_door", "action": "turn_off"},                 # never reported, never allowed
            {"entity_id": "alarm_control_panel.home", "action": "turn_off"},
            {"entity_id": "script.open_everything", "action": "turn_on"},
            {"entity_id": "automation.night_alarm", "action": "turn_off"},
            {"entity_id": "homeassistant.restart", "action": "turn_on"},
            {"entity_id": "switch.mosquito_vaporizer", "action": "toggle"},        # not one of the four actions
            {"entity_id": "switch.mosquito_vaporizer", "action": "set_temperature", "args": {"temperature": 24}},
            {"entity_id": "climate.bedroom_ac", "action": "set_temperature", "args": {"temperature": 31}},   # above its max
            {"entity_id": "climate.bedroom_ac", "action": "set_temperature", "args": {"temperature": 24.3}},  # not half degrees
            {"entity_id": "climate.bedroom_ac", "action": "set_temperature", "args": {"temperature": True}},
            {"entity_id": "climate.bedroom_ac", "action": "set_hvac_mode", "args": {"hvac_mode": "heat"}},    # it has no heat
            {"entity_id": "switch.not_reported", "action": "turn_on"},
        ]
        for c in bad:
            with self.subTest(c=c), self.assertRaises(b.Refused):
                b.plan_call(c, KNOWN | {"lock.front_door": {"entity_id": "lock.front_door", "attributes": {}}})

    def test_the_allow_list_is_exactly_this(self):
        self.assertEqual(b.ALLOWED, {("switch", "turn_on"), ("switch", "turn_off"), ("light", "turn_on"), ("light", "turn_off"),
                                     ("climate", "turn_on"), ("climate", "turn_off"), ("climate", "set_temperature"),
                                     ("climate", "set_hvac_mode")})


class Throttling(unittest.TestCase):
    def test_a_window_goes_at_once_the_room_temperature_every_5_minutes(self):
        t = b.Throttle(every=300)
        w = {"entity_id": "binary_sensor.w", "state": "on"}
        self.assertTrue(t.due(w, 0))
        t.mark(w, 0)
        self.assertFalse(t.due(w, 1))  # nothing changed
        self.assertTrue(t.due({"entity_id": "binary_sensor.w", "state": "off"}, 2))
        ac = b.state_report(AC)
        t.mark(ac, 0)
        warmer = {**ac, "attrs": {**ac["attrs"], "current_temperature": 29.1}}
        self.assertFalse(t.due(warmer, 120))
        self.assertTrue(t.due(warmer, 301))
        colder_target = {**ac, "attrs": {**ac["attrs"], "temperature": 23.0}}
        self.assertTrue(t.due(colder_target, 5))  # someone changed the AC: at once
        self.assertTrue(t.due({**ac, "state": "off"}, 5))


class Sensors(unittest.TestCase):
    """Phase 8b: people detected and ESP sensors, from ESPHome only (never the cameras)."""

    def test_esphome_only(self):
        self.assertEqual(b.kind_of("binary_sensor.living_room_human_presence", {"device_class": "occupancy"}, "esphome"), "presence")
        self.assertEqual(b.kind_of("binary_sensor.hall_motion", {"device_class": "motion"}, "esphome"), "presence")
        self.assertEqual(b.kind_of("binary_sensor.living_room_dark_detection", {"device_class": "light"}, "esphome"), "binary")
        self.assertEqual(b.kind_of("sensor.bedroom_temperature", {"unit_of_measurement": "°C", "state_class": "measurement"}, "esphome"), "sensor")
        # The camera ("Uho-P1A-M3F4D Motion Alarm") and other integrations: left out.
        self.assertIsNone(b.kind_of("binary_sensor.uho_p1a_m3f4d_motion_alarm", {"device_class": "motion"}, "onvif"))
        self.assertIsNone(b.kind_of("binary_sensor.uho_p1a_m3f4d_cell_motion_detection", {"device_class": "motion"}, None))
        self.assertIsNone(b.kind_of("sensor.phone_battery", {"unit_of_measurement": "%"}, "mobile_app"))
        self.assertIsNone(b.kind_of("sensor.esp_version", {}, "esphome"))  # text, no unit
        # Doors and windows still come from any integration.
        self.assertEqual(b.kind_of("binary_sensor.front_door", {"device_class": "door"}, "zha"), "door")

    def test_catalog_carries_platform_and_unit(self):
        states = [
            {"entity_id": "sensor.bedroom_temperature", "state": "28.9", "attributes": {"unit_of_measurement": "°C", "friendly_name": "Bedroom Temperature"}},
            {"entity_id": "binary_sensor.uho_motion", "state": "on", "attributes": {"device_class": "motion"}},
            {"entity_id": "binary_sensor.presence", "state": "off", "attributes": {"device_class": "presence"}},
            {"entity_id": "sensor.esp_wifi_signal", "state": "-60", "attributes": {"unit_of_measurement": "dBm"}},
        ]
        entities = [
            {"entity_id": "sensor.bedroom_temperature", "platform": "esphome", "area_id": "bedroom"},
            {"entity_id": "binary_sensor.uho_motion", "platform": "onvif"},
            {"entity_id": "binary_sensor.presence", "platform": "esphome"},
            {"entity_id": "sensor.esp_wifi_signal", "platform": "esphome", "entity_category": "diagnostic"},
        ]
        cat = b.build_catalog(states, entities, [], [{"area_id": "bedroom", "name": "Bedroom"}])
        self.assertEqual([(c["entity_id"], c["kind"], c.get("platform"), c.get("unit")) for c in cat],
                         [("binary_sensor.presence", "presence", "esphome", None), ("sensor.bedroom_temperature", "sensor", "esphome", "°C")])

    def test_events_keep_home_assistants_time(self):
        old = {"entity_id": "binary_sensor.front_door", "state": "off"}
        new = {"entity_id": "binary_sensor.front_door", "state": "on", "last_changed": "2026-11-02T16:24:33.512+00:00"}
        self.assertEqual(b.event_of(old, new), {"entity_id": "binary_sensor.front_door", "state": "on", "at": "2026-11-02T16:24:33.512+00:00"})
        self.assertIsNone(b.event_of(new, {**new, "attributes": {"brightness": 3}}))  # same state: no event
        self.assertTrue(b.ISO.match(b.event_of(None, {"entity_id": "light.x", "state": "on", "last_changed": "yesterday"})["at"]))

    def test_sensor_values_every_5_minutes_or_when_they_move(self):
        g = b.SensorGate(every=300)
        self.assertTrue(g.due("sensor.t", "28.9", "°C", 0))
        g.mark("sensor.t", "28.9", 0)
        self.assertFalse(g.due("sensor.t", "29.1", "°C", 60))   # +0.2 °C in a minute: wait
        self.assertTrue(g.due("sensor.t", "29.4", "°C", 60))    # +0.5 °C: now
        self.assertTrue(g.due("sensor.t", "29.0", "°C", 301))   # 5 minutes: now
        g.mark("sensor.h", "45", 0)
        self.assertFalse(g.due("sensor.h", "46", "%", 10))
        self.assertTrue(g.due("sensor.h", "47", "%", 10))
        self.assertTrue(g.due("sensor.t", "unavailable", "°C", 5))


class Address(unittest.TestCase):
    def test_websocket_url(self):
        self.assertEqual(b.ws_url("http://homeassistant.local:8123"), "ws://homeassistant.local:8123/api/websocket")
        self.assertEqual(b.ws_url("https://192.168.1.20:8123/"), "wss://192.168.1.20:8123/api/websocket")
        for bad in ("homeassistant.local:8123", "http://ha.local:8123/path", "file:///etc/passwd", "http://a b"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                b.ws_url(bad)


if __name__ == "__main__":
    unittest.main()

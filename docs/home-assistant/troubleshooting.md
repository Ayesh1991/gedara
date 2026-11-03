# Home Assistant in Gedara: troubleshooting

Cheapest first: is the Gedara Pi on → is Home Assistant on → the bridge's log.
The bridge's log on the Pi: `sudo journalctl -u gedara-home -n 50` (it never shows the token).

| Symptom | Why | Fix |
|---|---|---|
| The House page says **Offline** | the Gedara Pi is off or has no internet | check its power and network cable / Wi-Fi; wait 2 minutes after it starts |
| **"The bridge can't reach Home Assistant"** | Home Assistant is off or restarting, or its address changed | wait for Home Assistant to start; if its address changed, run `install.ps1 -HomeAssistant` again and type the new one |
| **"Home Assistant refused the bridge's token"** | the token was deleted in Home Assistant, or the Gedara user was removed | [setup.md](setup.md) Stage B for a new token, then Stage C and answer **n** to keep-the-token |
| The installer says **PROBLEM: can't reach Home Assistant at …** | wrong address, or the Pi can't resolve `homeassistant.local` | type Home Assistant's IP address instead (Home Assistant → Settings → System → Network shows it) |
| **"Home Assistant didn't answer"** after a tap | the Gedara Pi or Home Assistant is busy or offline | try again in a moment; check the two above |
| **"Home Assistant didn't do it: refused by the bridge …"** | something Gedara may not control (it can't happen from the app; it means a test or a bug) | nothing to fix at home; tell me |
| **"Home Assistant didn't do it: HA: …"** | Home Assistant itself refused (for example the device is unavailable) | check the device in Home Assistant |
| A switch isn't on the House page | switches start hidden | Settings › Devices › Home Assistant → **Show** (and **Control**) on |
| Something shows **Unavailable** | Home Assistant can't reach that device (Wi-Fi, power, ESPHome) | fix it in Home Assistant / ESPHome; Gedara shows it as soon as it's back |
| A room is missing; things are under **Other** | they have no area in Home Assistant | Home Assistant → the device → **Area**; Gedara updates within a few seconds |
| A new sensor doesn't appear | the bridge reads Home Assistant's list again after changes; it may take ~10 s | wait, or restart the bridge: `sudo systemctl restart gedara-home` |
| **No alert on my phone** when a door opens | notifications are off on that phone, alerts are Off for you, it's "Only at night" in the day, or that door's **Alert** is off | Settings › Notifications: turn on for this phone, House alerts → Always; Settings › Devices › Home Assistant → the door's **Alert** on |
| Only one alert for two quick openings | openings within 2 minutes are grouped (people: every 10 minutes per sensor) | as designed |
| A sensor isn't in the log or on the House page | only ESPHome sensors are read (cameras never), and its **Log** may be off | Settings › Devices › Home Assistant → **Show** / **Log** on; run `install.ps1 -HomeAssistant` again after adding an ESPHome device if it doesn't appear |
| Sensor values in the log every few minutes, not every second | values are kept every 5 minutes, or at once when they move (0.5 °, 2 %) | as designed (saves Supabase's free log quota) |

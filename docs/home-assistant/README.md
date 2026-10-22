# Home Assistant in Gedara (Phase 8)

Your Home Assistant (on the Raspberry Pi 3) shows inside Gedara, on the **House** page: every room's
**doors and windows** (open or closed), **lights** (on or off), and controls for the **AC**, the
**mosquito vaporizer** and the **emergency lights**. Owner and Sandeepani can control; a viewer only looks.
No new notifications: Home Assistant already sends its own.

| Read | For |
|---|---|
| [setup.md](setup.md) | **click by click**: the "Gedara" user and token in Home Assistant, one command, the pairing code, choosing what shows |
| [troubleshooting.md](troubleshooting.md) | symptom → fix |
| [protocol.md](protocol.md) | how the bridge and Gedara talk (for developers) |

## How it works
```
Gedara (phone / PC) ──► Supabase ◄── outbound only ── gedara-home bridge on the Gedara Pi ──home network──► Home Assistant (Pi 3)
```
- A small **bridge** runs on the Gedara Pi (the one that shares the printer and plays music). It talks
  to Home Assistant on the home network and to Gedara over the internet, **only calling out**.
  Nothing is installed inside Home Assistant, and no port is opened at home.
- **Home Assistant's token stays on the Gedara Pi** (`/etc/gedara-home/ha-token`, readable only by
  the bridge). It is typed once, hidden, into the installer's window and never comes to Gedara.
- The bridge reports doors, windows, lights, switches and ACs with their Home Assistant **area**
  (room). Changes reach Gedara within about a second; an AC's room temperature every 5 minutes.

## Safety
- **What can be controlled is fixed in the bridge itself:** lights and switches on/off, and the AC's
  power, mode and temperature (inside its own range). Locks, alarms, covers, cameras, scripts,
  automations, scenes and Home Assistant itself can never be controlled from Gedara, whatever happens.
- **In Gedara the owner chooses** what shows and what may be controlled (Settings › Devices ›
  Home Assistant). New things start as: doors, windows, lights and the AC shown; the AC controllable;
  switches hidden until you tick them.
- Every command records who sent it and is kept 30 days; one not picked up within 60 s is dropped.
- The bridge uses a **non-administrator** Home Assistant user, so even its token can't change Home
  Assistant's settings.

## Good to know
- If the Gedara Pi is off, the House page says **"Offline"** and shows the last known state; Home
  Assistant itself keeps working as before.
- Supabase's free plan counts logs: the bridge is built to add only a few MB a day.

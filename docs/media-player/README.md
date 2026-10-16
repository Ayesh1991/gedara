# Gedara Music (Phase 7h)

The Raspberry Pi 2 that shares the printer ([docs/print-server](../print-server/README.md)) is also
the household's **music speaker**. Songs live on its SD card; you choose and control them in Gedara
on any phone, the iPad or the PC. Nothing plays from the phone itself.

| Read | For |
|---|---|
| [setup.md](setup.md) | **click by click**: sound output, one command, pairing code, first songs, the PC folder |
| [troubleshooting.md](troubleshooting.md) | symptom → fix |
| [network-speaker.md](network-speaker.md) | **AirPlay and Bluetooth**: YouTube Music or any app from phones and PCs (Phase 7i) |
| [protocol.md](protocol.md) | how the Pi and Gedara talk (for developers) |

## What you get
- **Music** in Gedara: on the desktop sidebar, and on the phone through the Music card on Home and
  the mini player. It has:
  - Now playing, with the cover on a glow made of its own colours;
  - play / pause, next, volume, shuffle and repeat;
  - a **sleep timer that fades out**;
  - Up next (drag to reorder);
  - the library (songs, albums, artists, playlists, search).
- **The mini player** follows you on every screen while something plays.
- **Three ways to add songs:**
  1. **Add music** in Gedara (phone or PC, many files at once);
  2. **Share → Gedara** on Android;
  3. drag them into the **"Gedara Music"** folder on the PC.
- **Wind-down schedules** (for example every day at 21:30, "Relax" at volume 35, stop after
  45 minutes). The Pi runs them itself, so they work even when the internet is down.
- **A volume limit** for the whole household, and **"even out loud and quiet songs"**.
- **Printing keeps working.** The Pi gives music priority, so a phone print being prepared doesn't
  make the music stutter.

## Good to know
- **Sound:** the Pi 2's own 3.5 mm jack works but hisses a little. A cheap **USB sound card**
  (plugged in before setup) sounds much cleaner, and the setup picks it by itself. Use a **powered**
  speaker; an unpowered one will be very quiet.
- **Space:** a 16 GB card holds roughly 2,000 MP3s. Gedara's speaker page shows the space left.
- **Formats:** MP3, M4A/AAC, FLAC, OGG/Opus and WAV, up to 60 MB each when added in Gedara (the PC
  folder takes any size).
- **Security:** the Pi has its own key, made on the Pi and never shown or copied; you pair it by
  typing an 8-digit code. The folder password is stored in Windows' Credential Manager by the
  installer. Everything is reachable from the home network only.

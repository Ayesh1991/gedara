# Music speaker — when something's wrong

Cheapest first:
1. Is the speaker itself on, with its volume up?
2. In Gedara, Settings → Devices → the speaker: is it **Online**?
3. Settings → Diagnostics: Music speaker card, and Test connection (`media-agent-…`).
4. `install.ps1 -Status` (the print server's status screen).

| You see | Likely cause | Do this |
|---|---|---|
| Speaker **Offline** in Gedara | Pi off or not on the network; the agent stopped | unplug the Pi for 10 s; still offline: run `install.ps1 -Music` again (songs stay) |
| Tapping Play says **"The speaker didn't answer"** (but the song plays) | speaker software older than 0.2.1 waited on Bluetooth with no adapter plugged in | run `install.ps1 -Music` again (no new pairing code needed) |
| Tapping Play says **"The speaker didn't answer"** (nothing plays) | the Pi is offline or busy restarting | wait a minute; check Online as above |
| **No sound**, but Gedara shows it playing | speaker off / volume 0 / wrong output | speaker on and volume up; *Play a test sound*; using the jack: restart the Pi once after setup (`sudo reboot`); plugged a USB sound card in later: run `install.ps1 -Music` again so it's chosen |
| **Hiss** or crackle | the Pi 2's own 3.5 mm jack | use a USB sound card (Stage A) |
| Music **stutters** during a phone print | very large print job on the Pi 2 | normal for a moment; PC prints don't do this |
| A song stays **"On its way to the speaker"** | the Pi is offline, or its card is full | bring it online; Settings → Devices → the speaker → *Space on the card* |
| **"Bigger than 50 MB"** | Supabase's free plan takes at most 50 MB per file | drop it into the **Gedara Music** folder on the PC (no size limit); it appears in Gedara within a minute |
| **"Not a song this speaker can play"** | the file isn't MP3/M4A/FLAC/OGG/WAV (whatever its name says) | convert it to MP3 first |
| **"Waiting: the speaker is still collecting earlier songs"** | more than 300 MB on its way at once | nothing: Gedara carries on by itself |
| Songs dropped in the PC folder **don't appear** | still copying, or not songs | wait a minute; Settings → Devices → the speaker → *Check the PC folder now* |
| The **Gedara Music** folder asks for a password | Credential Manager entry missing (new PC, or a new card) | run `install.ps1 -MusicFolder` on that PC |
| Pairing: **"That code doesn't match"** | mistyped, or older than 10 minutes | run the Stage B command again for a new code |
| A schedule **didn't start** | it's off, or the day isn't ticked; the Pi's clock | check it on the speaker's page; the Pi takes its time from the internet at start-up |
| The speaker **isn't in the iPhone's AirPlay list** | phone on mobile data / guest Wi-Fi, or AirPlay is off | phone on the home Wi-Fi; Gedara → the speaker → Network speaker → AirPlay on; run `install.ps1 -Music` again and check stage 7/7 says OK (if it says "could not install", the Pi was updating itself: run it again) |
| AirPlay **drops** now and then | weak Wi-Fi at the phone, or a print being prepared | move closer to the router; classic AirPlay keeps a 2 s buffer |
| **Bluetooth: no adapter** in Gedara | the USB Bluetooth adapter isn't plugged in, or wasn't when setup ran | plug it in, run `install.ps1 -Music` again |
| The phone **can't find the speaker** in Bluetooth | pairing isn't open | Gedara → the speaker → *Let a phone or PC pair (2 min)*, then search on the phone within those 2 minutes |
| A paired phone **won't reconnect** | it was removed, or Bluetooth is off for the speaker | remove the speaker from the phone's Bluetooth list and pair again |
| Gedara's music **won't start** while a phone plays | that's by design: one source at a time | tap Play → *Play here* |

Still stuck: send me what `install.ps1 -Status` shows, and the speaker's page.

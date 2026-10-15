# Music speaker — when something's wrong

Cheapest first:
1. Is the speaker itself on, with its volume up?
2. In Gedara, Settings → Devices → the speaker: is it **Online**?
3. Settings → Diagnostics: Music speaker card, and Test connection (`media-agent-…`).
4. `install.ps1 -Status` (the print server's status screen).

| You see | Likely cause | Do this |
|---|---|---|
| Speaker **Offline** in Gedara | Pi off or not on the network; the agent stopped | unplug the Pi for 10 s; still offline: run `install.ps1 -Music` again (songs stay) |
| Tapping Play says **"The speaker didn't answer"** | the Pi is offline or busy restarting | wait a minute; check Online as above |
| **No sound**, but Gedara shows it playing | speaker off / volume 0 / wrong output | speaker on and volume up; *Play a test sound*; using the jack: restart the Pi once after setup (`sudo reboot`); plugged a USB sound card in later: run `install.ps1 -Music` again so it's chosen |
| **Hiss** or crackle | the Pi 2's own 3.5 mm jack | use a USB sound card (Stage A) |
| Music **stutters** during a phone print | very large print job on the Pi 2 | normal for a moment; PC prints don't do this |
| A song stays **"On its way to the speaker"** | the Pi is offline, or its card is full | bring it online; Settings → Devices → the speaker → *Space on the card* |
| **"Not a song this speaker can play"** | the file isn't MP3/M4A/FLAC/OGG/WAV (whatever its name says) | convert it to MP3 first |
| **"Waiting: the speaker is still collecting earlier songs"** | more than 300 MB on its way at once | nothing: Gedara carries on by itself |
| Songs dropped in the PC folder **don't appear** | still copying, or not songs | wait a minute; Settings → Devices → the speaker → *Check the PC folder now* |
| The **Gedara Music** folder asks for a password | Credential Manager entry missing (new PC, or a new card) | run `install.ps1 -MusicFolder` on that PC |
| Pairing: **"That code doesn't match"** | mistyped, or older than 10 minutes | run the Stage B command again for a new code |
| A schedule **didn't start** | it's off, or the day isn't ticked; the Pi's clock | check it on the speaker's page; the Pi takes its time from the internet at start-up |

Still stuck: send me what `install.ps1 -Status` shows, and the speaker's page.

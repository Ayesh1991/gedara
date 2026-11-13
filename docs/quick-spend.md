# Quick spend: the checklist, stage by stage

Quick spend (Phase 12, v0.12.0) enters a cash expense in a few seconds: type the amount, tap one tile, done.
It has its own icon on the home screen and works with no signal. Places also gets a search box.

Work through the stages in order and tick each box. After each **"Send me"** line, tell me in the chat
what you saw (a screenshot is best).

| Stage | What | You need | Where |
|---|---|---|---|
| 0 | The database on staging | PC | terminal |
| 1 | The icons: Android, iPhone, iPad | the three devices | preview site |
| 2 | A week of real use (and the tests) | phone, PC | preview site, terminal |
| 3 | Go live on gedara.vercel.app | PC, GitHub | terminal + GitHub |
| 4 | The icons again, on the real site | the three devices | gedara.vercel.app |

The **preview site** is https://gedara-git-phase-12-ayeshmantha.vercel.app (staging data, safe to play
with). The **real site** is https://gedara.vercel.app. An icon added from one site opens that site
only: add the preview icons now, and the real ones again in Stage 4.

---

## Stage 0 · Database on staging (once)

In a terminal in the `gedara-handoff` folder:

1. [ ] Get the new files: `git fetch origin phase-12` then `git checkout phase-12` then `git pull`.
2. [ ] The database (type `Y` if asked). It adds two migrations (111, 112):
   ```bash
   npx --yes supabase@2.121.0 db push --linked
   ```
3. [ ] The SQL tests, including the new `quick.test.sql`:
   ```bash
   pnpm test:db
   ```
   All lines say `ok`.
4. [ ] Preview site: the footer says **v0.12.0 · db 112**. (If it says db 111 or lower, step 2 didn't
   run; if it says v0.11.x, the preview hasn't been built yet: wait 3 minutes and reload.)
5. [ ] **Send me**: "staging done" and the footer text. I then refresh the database types from staging.

Nothing else changes on the server: no new function, no new key, no AI.

---

## Stage 1 · The icons

There are two ways to get a Quick spend icon, and the devices differ:

| | Android phone (Chrome) | iPhone and iPad (Safari) |
|---|---|---|
| **A · from the Gedara icon** | Press and hold Gedara → **Quick spend**. You can drag that entry out to make its own icon. | Not possible: iOS doesn't offer this. |
| **B · its own icon** | Expected to work (gold bolt, "Quick spend"). Same login as Gedara. | Works. Each home-screen icon on iOS keeps its own login, so it asks for an email code **once**. |

### 1.1 Android phone
First, Gedara itself must be installed from the **preview** site (if your Gedara icon opens
gedara.vercel.app, add the preview one too for now).

**Way A (the Gedara icon):**
1. [ ] Open the preview site in Chrome once, then close it (Chrome picks up the new shortcut within a
   day; removing and re-adding the Gedara icon makes it immediate).
2. [ ] Press and hold the Gedara icon. A small menu shows **Quick spend**. Tap it: the number pad opens.
3. [ ] Press and hold again, then **drag** "Quick spend" onto the home screen and let go. A Quick spend
   icon with a small Gedara badge appears.

**Way B (its own icon):**
1. [ ] In Chrome (not inside the Gedara app) open **https://gedara-git-phase-12-ayeshmantha.vercel.app/quick**.
2. [ ] Tap **⋮** (top right) → **Add to Home screen** → **Install** (or tap **⋯** on the Quick spend
   screen → **Add the Quick spend icon** → **Install Quick spend**).
3. [ ] A gold bolt named **Quick spend** appears. Tap it: the pad opens with no sign-in.
4. [ ] **Send me**: what happened at step 2. Did Chrome offer **Install**, only **Add shortcut**, or
   nothing? (This is the one thing I could not confirm from Google's documents. If Chrome refuses, Way A
   is your icon on Android.)

### 1.2 iPhone and iPad (do both)
1. [ ] In **Safari** open **https://gedara-git-phase-12-ayeshmantha.vercel.app/quick** (sign in if asked).
2. [ ] Tap **Share** (the square with the arrow) → scroll → **Add to Home Screen**.
3. [ ] The name says **Quick spend** and the icon is the gold bolt. Make sure **Open as Web App** is on.
   Tap **Add**.
4. [ ] Open the new icon. It asks you to sign in: type your email, then the 6-digit code from the email.
   This happens **once**; after that it stays signed in.
5. [ ] **Send me**: a screenshot of the home screen with the icon, and one of the Quick spend screen.

### 1.3 The five seconds
1. [ ] Close Quick spend completely. Tap its icon, type **60**, tap **Bus**. It says **Saved · Bus**.
2. [ ] Open Gedara → **Settings → Diagnostics**. The row **Quick spend** shows how long the pad took and
   how long until saved, on this phone.
3. [ ] **Send me** those two numbers. (Target: under 5 seconds from the tap on the icon.)

---

## Stage 2 · A week of real use

Use it for real on the preview site for a few days: tuk, bus, tea at the canteen, petrol. Things to try:

- [ ] **No signal**: switch on Airplane mode, enter two things, close the app, open it again. The
  entries are under **Today** with a cloud mark and **2 waiting** at the top. Switch Airplane mode
  off and open the app: they go, each once. Check **Money**: they are there, on the right day and time.
- [ ] **Undo**: save something, tap **Undo** within 8 seconds. It is gone (also from Money).
- [ ] **Fix**: tap an entry under Today → **Fix** → add a note or change the date → **Save**.
- [ ] **Favourites**: a tile used with the same amount three times (e.g. Tea 100) appears on top as
  **Tea 100** and saves with one tap. You can also set it: **⋯ → Edit tiles** → Tea → **Usual amount**.
- [ ] **Edit tiles**: rename, reorder (arrows), hide (eye), add your own tile with its category.
- [ ] **Sandeepani**: on her phone, Quick spend makes her own wallet **Cash — Sandeepani** (starts at
  Rs 0: answer the cash check, or set it in Money → Accounts). **Gave cash** (hidden at first: Edit
  tiles → eye) moves cash from your wallet to hers.
- [ ] **Cash check**: after five entries, a line under Today asks whether the wallet holds what Gedara
  thinks. **Yes**, or **No, I have…** and the amount.
- [ ] **Places**: Places → search box → type something kept in a box (a thing or a pantry item).
- [ ] The browser tests on the PC (staging only):
  ```bash
  pnpm e2e -- tests/e2e/quick12.spec.ts --trace off
  ```
  They print the measured speed: `Quick spend: pad ready … ms, four taps to saved … ms`.
- [ ] **Send me** anything odd, and the speed line.

---

## Stage 3 · Go live (production)

Do these **in this order** on the PC, in a terminal in the `gedara-handoff` folder.

1. [ ] Database to production (type `Y` when asked):
   ```bash
   npx --yes supabase@2.121.0 db push --project-ref ltzlsxupcsamwtgqfejg
   ```
   (Two migrations. No function to deploy, no secret to set.)
2. [ ] Merge on GitHub (in the browser):
   1. Open **https://github.com/Ayesh1991/gedara** → **Pull requests** → **New pull request**.
   2. **base: main** ← **compare: phase-12** → **Create pull request**.
   3. Title: `Phase 12 Quick spend` → **Create pull request**.
   4. **Merge pull request** → **Confirm merge**.
3. [ ] Wait 2–3 minutes. Open **https://gedara.vercel.app**: the footer says **v0.12.0 · db 112**.
   **Settings → Diagnostics → Test connection** is all green.
4. [ ] On the real site your **Cash** account becomes **Cash — Didula** the first time you open Quick
   spend (its history stays). Sandeepani's wallet is made when she first opens it.

## Stage 4 · The icons on the real site

Repeat **Stage 1** with **https://gedara.vercel.app/quick** in place of the preview address, then
remove the preview icons (press and hold → **Remove**). On iPhone and iPad any entries still waiting in
a preview icon would be lost with it: open it once with signal first, so the waiting count is gone.

---

## Good to know

- **What waits on the phone** is only the amount, the tile and the time (never a password or key).
  An entry waits until there is signal **and** you are signed in as the person who made it.
- **Signing out** (Settings → Sign out) deletes entries that have not been sent yet, after asking. A
  login that simply runs out keeps them; they go after you sign in again.
- **A scanned bill** for something you already entered here (same amount, same or next day, paid in
  cash) shows "Same as your quick entry?" after the import: **Keep the bill** removes the quick entry.
- **Card and BOC Flex payments**: don't enter them here. They arrive by SMS (Money → Bank alerts).
- **Viewers** can open Quick spend but can't add.

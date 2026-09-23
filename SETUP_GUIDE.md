# Gedara — Beginner Setup Guide (Steps 2–5, Windows)

Take it slowly. Everything here is free. When a step says **PowerShell**, press the Windows key,
type `PowerShell`, and open **Windows PowerShell**.

> **Never paste these into any chat, email or file that goes to GitHub:** database passwords,
> the Supabase **service_role / secret** key, the Gmail app password. Keep them only in a
> password manager (Google Password Manager, Bitwarden, or a locked note on your phone).

---

## Step 2 — Supabase (your database, logins and photo storage)

### 2.1 Create the account (5 min)
1. Open **https://supabase.com** → **Start your project** → **Sign up**.
2. Use **email + password** with `ayeshmantha1991.24@gmail.com`. Don't use "Continue with GitHub",
   because your GitHub is linked to your other email.
3. Open the confirmation email in that Gmail inbox and click **Confirm**.
4. You'll be asked to create an **organization** (a folder that holds projects):
   Name `Gedara` · Type `Personal` · Plan **Free** → **Create organization**.

### 2.2 Create the two projects (5 min)
You make two identical projects. **Staging** is the practice copy Claude Code builds and breaks
things in. **Prod** is the real one you and Sandeepani use every day.

1. **New project** →
   - Project name: `gedara-staging`
   - Database password: click **Generate a password**, then **copy it into your password
     manager now** (entry name: "Gedara staging DB").
   - Region: **Southeast Asia (Singapore)**
   - **Create new project**, then wait about 2 minutes until the dashboard appears.
2. Go back to the organization (top-left) → **New project** → the same again with the name
   `gedara-prod` (a new generated password, saved as "Gedara prod DB").

### 2.3 Find the project keys (so you know where they are)
In a project, open **Project Settings** (gear icon, bottom-left) → **API Keys** (also shown by
the green **Connect** button at the top). You'll see:
- **Project URL**, e.g. `https://abcd1234.supabase.co`: safe to share with Claude Code.
- **anon / publishable key**: safe; it goes into the app.
- **service_role / secret key**: **secret.** It bypasses all security. Only paste it into
  `.env.local` or Supabase/Vercel secret settings when Claude Code asks, and never into a chat.

You don't need to copy anything now. Claude Code will ask during Phase 0.

### 2.4 Make logins invite-only (do this in BOTH projects)
1. Left menu → **Authentication** → **Sign In / Providers** (older name: *Providers*).
2. **Email** provider: make sure it is **Enabled**. Leave "Confirm email" on.
3. Find **"Allow new users to sign up"** and switch it **OFF** → **Save**.

This means strangers can't create accounts. You and Sandeepani get added by hand in Phase 0:
**Authentication → Users → Add user → Create new user**, enter the email, tick **Auto Confirm
User**. Claude Code will tell you when.

### 2.5 Make the login email show a 6-digit code (BOTH projects)
> **Do 2.6 (Gmail SMTP) first.** Supabase locks the email templates (subject and body are
> greyed out, with the message "Set up custom SMTP to edit templates") until custom SMTP is saved.
> After 2.6 the template becomes editable, and then you come back here.

1. **Authentication** → **Emails** → **Magic link or OTP** template.
2. Subject: `Your Gedara login code`
3. Replace the body with:
   ```html
   <h2>Gedara ගෙදර</h2>
   <p>Your login code is:</p>
   <p style="font-size:32px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
   <p>It expires in 1 hour. If you didn't try to log in, ignore this email.</p>
   ```
4. **Save**.

### 2.6 Make the emails actually arrive: Gmail sending (IMPORTANT, 10 min)
Supabase's built-in email sender only sends to **members of your Supabase team** and only **2
emails per hour**. Your login email (`ayeshmantha@gmail.com`) and Sandeepani's are not team
members, so without this step **no login code will ever arrive**. Fix it free by letting Supabase
send through the Gmail account `ayeshmantha1991.24@gmail.com`:

**A. Create a Gmail App Password**
1. Sign in to **myaccount.google.com** as `ayeshmantha1991.24@gmail.com`.
2. **Security** → turn on **2-Step Verification** (required; follow the phone steps).
3. In the top search bar of the Google Account page type **App passwords** → open it.
4. App name: `Supabase Gedara` → **Create** → Google shows a **16-letter password**. Copy it into
   your password manager ("Gedara Gmail app password"). It is shown only once.

**B. Put it into Supabase (BOTH projects)**
1. **Authentication** → **Emails** → **SMTP Settings** → turn **Enable custom SMTP** ON.
2. Fill in:
   | Field | Value |
   |---|---|
   | Sender email | `ayeshmantha1991.24@gmail.com` |
   | Sender name | `Gedara` |
   | Host | `smtp.gmail.com` |
   | Port | `587` |
   | Username | `ayeshmantha1991.24@gmail.com` |
   | Password | the 16-letter app password (no spaces) |
3. **Save**.
4. **Authentication** → **Rate Limits** → "emails sent per hour" → set to `30` → **Save**.

Test it later in Phase 0: when you log in, the code should arrive within a minute. Check Spam the
first time and mark it "Not spam".

---

## Step 3 — Vercel (puts the website on the internet)

**Do step 1 (the GitHub repo) first.** Vercel builds the website from your GitHub repo.

### 3.1 Create the account (3 min)
1. Open **https://vercel.com** → **Sign Up** → choose **Hobby** (free, personal) → your name.
2. **Continue with GitHub** → sign in to GitHub → **Authorize Vercel**.

### 3.2 Import the repo and reserve the name (5 min)
1. Vercel dashboard → **Add New…** → **Project**.
2. Under **Import Git Repository**, find `gedara`.
   - If it isn't listed: click **Adjust GitHub App Permissions** → choose **Only select
     repositories** → pick `gedara` → **Save** → back in Vercel it now appears.
3. Click **Import**. On the configure screen:
   - **Project Name:** `gedara`. If Vercel says the name is taken, use `gedara-home` and write it
     in `docs/decisions.md` so Claude Code knows.
   - **Root Directory:** the picker only lists folders that already exist, so first create
     `apps/web` in GitHub (steps below), then click **Edit** → expand `apps` → select `web` →
     **Continue**. This keeps your planning documents (which contain your emails) off the internet.
   - Leave Framework ("Other"), Build and Environment Variables alone. Claude Code sets them in Phase 0.
4. Click **Deploy** → a "coming soon" page goes live at `https://gedara.vercel.app`.

**Creating `apps/web` in GitHub (2 min, in the browser):**
1. Open `github.com/<you>/gedara` → **Add file** → **Create new file**.
2. In the name box type `apps/web/index.html` (typing `/` creates the folders).
3. Content: `<h1>Gedara ගෙදර — coming soon</h1>`
4. **Commit changes…** → **Commit changes**. Back in Vercel, the picker now shows `apps`.
Claude Code replaces this placeholder in Phase 0.

From now on every push to GitHub rebuilds the site automatically. The `main` branch is the real
site, and other branches get their own **preview** address for testing.

---

## Step 4 — Tools on your computer (30–45 min, mostly downloads)

Install in this order. After each install **close and reopen PowerShell** before testing.

| # | Tool | What it is | How to install | Test in PowerShell |
|---|---|---|---|---|
| 1 | **Git** | Tracks every change to the code and sends it to GitHub | https://git-scm.com/download/win → run the installer → keep every default → Next… Finish | `git --version` |
| 2 | **GitHub Desktop** (optional, beginner-friendly) | Buttons instead of Git commands for commit/push | https://desktop.github.com → install → sign in with GitHub | — |
| 3 | **VS Code** (recommended) | Editor to open/look at files | https://code.visualstudio.com → install (tick "Add to PATH") | `code --version` |
| 4 | **Node.js LTS** | Runs the website's tools | https://nodejs.org → **LTS** button → run installer → defaults. Tick "Automatically install necessary tools" if asked | `node -v` (must be 20 or higher) |
| 5 | **pnpm** | Faster package installer the project uses | PowerShell: `npm install -g pnpm` | `pnpm -v` |
| 6 | **TypeScript language server** | Lets Claude Code check code as it writes | PowerShell: `npm install -g typescript-language-server typescript` | `typescript-language-server --version` |
| 7 | **Supabase CLI** | Sends database changes to Supabase | Nothing to install: Claude Code adds it to the project and runs it with `pnpm supabase …`. (Test now with `npx supabase --version`, answer `y` if asked) | `npx supabase --version` |
| 8 | **Docker Desktop** (optional) | Runs a private copy of Supabase on your PC for testing | See below | `docker --version` |

**Git: set your name once** (PowerShell):
```powershell
git config --global user.name "Didula Ayeshmantha"
git config --global user.email "ayeshmantha@gmail.com"
```

**If PowerShell says "running scripts is disabled on this system"** (common with pnpm), run
this once and answer `Y`:
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**Docker Desktop: install it only if your PC has 16 GB RAM** (8 GB works but is slow):
1. https://www.docker.com/products/docker-desktop → Download for Windows → install with
   **"Use WSL 2"** ticked → restart the PC when asked.
2. Open Docker Desktop once and accept the terms. It must be running when Claude Code tests the
   database.
3. If it complains about virtualisation, that must be enabled in the BIOS. Skip Docker instead.

**No Docker?** That's fine. Tell Claude Code at the start of Phase 0:
*"I don't have Docker. Use the gedara-staging project for development and tests, never prod."*

---

## Step 5 — Reference files (15 min)

These give Claude Code real examples so it builds the importers correctly. Put them inside your
repo folder (the copy of `gedara-handoff` on your PC).

### 5.1 Bill Scanner prompt → `reference/bill-scanner/prompt.md`
1. Open **claude.ai** → **Projects** → your **Bill Scanner** project.
2. Open the **project instructions** (the custom instructions box) → select all (Ctrl+A) → copy.
3. In VS Code: **File → Open Folder** → your repo folder → in the left panel, right-click
   `reference/bill-scanner` → **New File** → `prompt.md` → paste → **Ctrl+S**.

### 5.2 Sample bills → `reference/bill-scanner/samples/`
1. Open **Google Drive** → folder **Home Ledger Bills**.
2. Pick **5–10 different kinds**: a supermarket bill (Cargills/Keells), a small shop bill,
   fuel, LP gas (LAUGFS), electricity, water, a restaurant, one with a discount.
3. For each: right-click → **Download**.
   - If a file is a **Google Doc** (blue icon) instead of JSON: open it → **File → Download →
     Plain text (.txt)** → rename it from `.txt` to `.json`.
4. Move them into `reference/bill-scanner/samples/` and name them simply:
   `cargills-2026-08.json`, `ceb-electricity-2026-08.json` …
5. Open each in VS Code and delete anything private you don't want stored (card numbers, loyalty
   numbers, phone numbers).

### 5.3 Ledger history → `reference/sheet-export/ledger.csv`
1. Open the ledger **Google Sheet**.
2. Click the tab (bottom) that holds the entries.
3. **File → Download → Comma-separated values (.csv)**. This saves only the current tab. Repeat
   for any other tab that holds data.
4. Rename to `ledger.csv` (others: `ledger-<tabname>.csv`) and move into
   `reference/sheet-export/`.

### 5.4 Grocy: nothing now
Needed at Phase 3. Claude Code will then ask you to create a Grocy API key.

### 5.5 Send the files to GitHub
**With GitHub Desktop:** it lists the new files → bottom-left **Summary**: `Add reference files`
→ **Commit to main** → **Push origin** (top).

**With PowerShell** (inside the repo folder):
```powershell
git add .
git commit -m "Add reference files"
git push
```
Your repo is **private**, so these bills are visible only to you (and to Claude Code while it works).

---

## Checklist before opening Claude Code
- [ ] Supabase: 2 projects in Singapore; sign-ups OFF; code email template; Gmail SMTP — in **both**
- [ ] All passwords saved in a password manager
- [ ] Vercel: project `gedara` imported with Root Directory `apps/web` (failed build is OK)
- [ ] `git`, `node`, `pnpm`, `typescript-language-server` all answer with a version number
- [ ] Docker installed and running — **or** you'll tell Claude Code "no Docker"
- [ ] Reference files pushed to GitHub

Then open START_HERE.md → section 2 (plugins) and section 3 (first prompt).

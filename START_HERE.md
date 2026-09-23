# START HERE — handing Gedara to Claude Code

This folder becomes the **root of your `gedara` Git repo**. Nothing is coded yet. Claude Code
builds it phase by phase from `docs/MASTER_PLAN.md`.

## 1. One-time setup (about 1–2 hours)

> **New to this? Follow `SETUP_GUIDE.md`** — it walks through steps 2–5 click by click.

1. **GitHub:** create a private repo `gedara`. Copy everything in this folder into it (including
   the hidden `.claude/`, `.gitignore`, `.env.example`) and push.
2. **Supabase:** sign up with **ayeshmantha1991.24@gmail.com** → create `gedara-staging` and
   `gedara-prod`, region **Southeast Asia (Singapore)**. Save each database password in a
   password manager.
   - Auth → Providers → Email: enable, **turn OFF "Allow new users to sign up"** (invite-only).
   - Auth → Email templates → "Magic Link": make it show the `{{ .Token }}` 6-digit code.
   - Auth → Emails → **SMTP Settings: custom SMTP via Gmail** (`smtp.gmail.com:587`, sender
     `ayeshmantha1991.24@gmail.com`, a Gmail **App Password**). Without this, login codes are not
     delivered: the built-in sender only emails Supabase team members, 2 per hour.
3. **Vercel:** sign in with GitHub → import the `gedara` repo → project name **`gedara`**
   (if taken: `gedara-home`, and tell Claude Code). Set **Root Directory = `apps/web`**. The first
   build fails (expected), which reserves the name without publishing the docs. Leave the rest for
   Claude Code.
4. **Local tools:** Node 20+, pnpm (`npm i -g pnpm`), Supabase CLI, Git, Docker Desktop (optional — for
   local Supabase; without it, tell Claude Code to develop against `gedara-staging`), and `npm i -g typescript-language-server typescript`.
5. **Add reference files** (see `reference/README.md`): the Bill Scanner prompt, 5–10 sample bill
   JSONs, and the ledger Google Sheet as CSV.

## 2. Plugins in Claude Code
Open Claude Code in the repo folder. `.claude/settings.json` already lists the plugins. If
Claude Code asks, approve them, or install manually:
```
/plugin marketplace add anthropics/claude-plugins-official
/plugin install supabase@claude-plugins-official
/plugin install vercel@claude-plugins-official
/plugin install github@claude-plugins-official
/plugin install frontend-design@claude-plugins-official
/plugin install typescript-lsp@claude-plugins-official
/plugin install playwright@claude-plugins-official
/plugin install context7@claude-plugins-official
/plugin install security-guidance@claude-plugins-official
/plugin install feature-dev@claude-plugins-official
/plugin install commit-commands@claude-plugins-official
/plugin install claude-md-management@claude-plugins-official
```
Later: `pyright-lsp` (Phase 6b, Pi Python), `code-review`, `chrome-devtools-mcp`.
When the Supabase plugin asks you to log in, use the **ayeshmantha1991.24@gmail.com** account and
point it at **gedara-staging** only.

## 3. First prompt (Phase 0)
> Read CLAUDE.md, docs/MASTER_PLAN.md (all of it) and docs/HANDOVER.md §4.
> We are doing **Phase 0 — Foundation** only (MASTER_PLAN §9 and §11).
> Enter plan mode and propose the plan, including the list of migrations, before writing code.

Then for each later phase: new session → *"Read CLAUDE.md and docs/MASTER_PLAN.md §9 Phase N.
Plan mode first."*

## 4. After each phase — your 5-minute check
1. Open the Vercel preview URL on the **laptop and iPad**. The version badge must show the new
   version.
2. Settings → Diagnostics → **Test connection**: everything green.
3. Try the phase's "Done when" row from MASTER_PLAN §9 yourself.
4. Only then merge to `main` (production).

## 5. What's in this folder
| Path | Purpose |
|---|---|
| `SETUP_GUIDE.md` | Beginner click-by-click guide for accounts and tools (steps 2–5) |
| `CLAUDE.md` | Rules Claude Code follows every session |
| `docs/MASTER_PLAN.md` | The full design: schema, modules, UX, analytics, devices, phases |
| `docs/HANDOVER.md` | History + hard-won lessons from ledger v1–v7 |
| `docs/decisions.md` | Decisions log (Claude Code appends to it) |
| `docs/archive/SYSTEM_ARCHITECTURE.md` | Old spec, superseded — history only |
| `reference/` | Ledger v7 source + slots for bill samples and exports |
| `.claude/settings.json` | Plugins enabled for this project |
| `.env.example` | Which keys go where (copy to `.env.local`, never commit) |

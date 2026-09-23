# reference/ — read-only inputs

Claude Code reads these; never edits or ships them.

| Folder | Contents | Status |
|---|---|---|
| `ledger-v7/` | Current Home Ledger PWA: `index.html` (design tokens, `CATS` categories, `QUICK` tiles, djb2 `hash32` + `billToEntries` fingerprint format, SVG charts), `sw.js`, `CACHE_FIX.md` | ✅ included |
| `bill-scanner/prompt.md` | Custom instructions of the Claude "Bill Scanner" project (copy/paste them here) | ⬜ **Didula to add** (needed by Phase 2) |
| `bill-scanner/samples/*.json` | 5–10 real scanned-bill JSON files (Cargills, Keells, LAUGFS, a fuel bill, an electricity bill) | ⬜ **Didula to add** (needed by Phase 2) |
| `sheet-export/ledger.csv` | Google Sheet → File → Download → CSV (the ledger's full history, with fingerprint IDs) | ⬜ **Didula to add** (needed by Phase 2 import) |
| `grocy-export/` | Grocy API key (put it in `.env.local`, **not here**) + optional JSON dumps; the import script can pull live via API instead | ⬜ at Phase 3 |

Remove personal data you don't want in the repo (card numbers etc.) before adding samples.
Keep the Grocy and Homebox **source trees outside the repo**.

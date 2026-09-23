# The real problem: browser cache, not the code

Your GitHub `index.html` is already **v6** — correct code, clickable drill-down, dedupe, everything. I verified it: no errors, click handlers wired. Nothing is wrong with what's on GitHub.

What's wrong: the **old service worker** (from v1) used a "cache-first" strategy. It saved the old page and kept serving that saved copy, so your browser never downloaded the new file even though it's sitting on GitHub. That's why the footer still says v1.0 and items aren't clickable — you're literally looking at the original app from cache.

## The permanent fix (v7)

v7 changes the service worker to **network-first**: the app now always loads the live file when you're online, and only falls back to cache when offline. After this one update, pushing a new version to GitHub will *just work* — no more manual cache clearing ever again. The app also auto-reloads once when it detects a new version.

## One-time steps to escape the current stuck cache

Because the *old* worker is still in control, you must break out of it once. Do this on **each device**.

**First: back up (the laptop has your data).**
Settings → **Backup JSON** → save the file. (Clearing cache can wipe local entries. Your Sheet is also a copy, but back up anyway.)

**Laptop / desktop Chrome or Edge:**
1. Upload the new `index.html` and `sw.js` to GitHub (overwrite, commit). Wait 2 min.
2. Open the app → press **F12** → **Application** tab → **Service Workers** (left) → click **Unregister**.
3. Still in Application → **Storage** → **Clear site data**.
4. Close the tab, reopen the app. Footer should now read **app v7**.
5. If entries are gone: tap **Sync now** (pulls them back from the Sheet) or Settings → Restore backup.

**iPad / iPhone (Safari):**
1. Remove the app from the Home Screen (press-hold → Remove) if you installed it.
2. Settings app → **Safari** → **Advanced** → **Website Data** → search *github* → swipe-delete that entry.
3. Reopen the app URL in Safari. Footer should read **app v7**. Re-add to Home Screen.

**Android Chrome:**
1. Chrome ⋮ → Settings → Privacy → **Clear browsing data** → choose *Cached images and files* (and *Cookies/site data* for the site) → Clear.
2. Or: long-press the app icon → App info → Storage → Clear storage, if installed as a PWA.
3. Reopen. Footer should read **app v7**.

## After you're on v7

- Footer says **app v7**, and Settings has **Test connection** + **Remove duplicates** buttons.
- Insights → tap any sub-category row (Fish & seafood, Sugar…) → it opens the product list with charts → tap a product for its price-trend detail.
- Don't forget the Apps Script side: redeploy so the ping shows **version 5** (Deploy → Manage deployments → ✎ → New version). The dedupe button needs script v5.
- Run **Remove duplicates** once per device to clear the duplicates already created.

From v7 onward, every future update is just: upload to GitHub → reopen the app. The cache fight is over.

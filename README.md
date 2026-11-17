# Mothball Tabs

Mothball your tabs. A Chrome extension that finds duplicate tabs, puts idle ones to
sleep, groups a site's tabs together, and saves a window as a session you can
reopen later.

**Free, local-only, no account, no server, no tracking.** Everything stays in your
browser profile and the extension makes no network requests at all.

Not on the Chrome Web Store yet — load it from source below.

---

## Install from source (2 minutes)

1. Download this repository (green **Code** button → *Download ZIP*) and unzip it
   somewhere permanent. Not your Downloads folder — Chrome runs the extension from
   that exact folder, so moving or deleting it later breaks the install.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to
   **Mothball Tabs**.

Click the icon, or press `Alt+Shift+T`.

---

## What it does

Click the toolbar icon to see every open tab grouped by site.

**Suggestion cards** at the top are the assistant. They are plain rules, not a
black box:

| Card | Meaning | Button does |
| --- | --- | --- |
| *N duplicate tabs* | The same page is open more than once; one copy of each is kept | Closes the extra copies |
| *N tabs untouched for 7+ days* | Not visited recently and not protected | **Sleeps** them — memory freed, tab stays in the strip |
| *N sites with 8+ tabs* | One site is taking over the tab strip | Puts each site into a named, coloured tab group |

Every card also has **Show me**, which selects those tabs so you can look before
anything happens. Nothing acts until you click.

**Per site:** each site header has *Sleep all* and *Close all*.

**Selection:** tick tabs, then **Sleep**, **Save** or **Close** — the buttons always
show the exact count.

**Search** filters by title, address or site (`/` focuses the box). **Sort** toggles
*By site* / *Recent*.

**Saved sessions** live in the panel at the bottom. Saving stores the addresses;
**Open** reopens them in a new window (50 at a time). Capped at 50 sessions of 400
tabs, so storage can't grow without bound.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt+Shift+T` | Open Mothball Tabs |
| `Alt+Shift+D` | Close duplicates in all windows |
| `Alt+Shift+S` | Sleep idle tabs |
| `Alt+Shift+W` | Save the current window as a session |

Change them at `chrome://extensions/shortcuts`.

### What is never touched

- Pinned tabs (unless you disable that in settings)
- The tab you are looking at
- Any tab playing audio
- Domains you added to the protect list
- Tabs whose last-visit time Chrome does not report — unknown age is never a reason to act

Sleeping never closes anything. Bulk closes ask for confirmation first, and report
per-tab failures rather than failing silently.

---

## Settings

Gear icon → idle threshold, grouping threshold, protected domains, confirmation,
debug logging. The same page exports and imports a JSON backup (settings and saved
sessions), and can delete everything the extension stored. Backups contain page
addresses — treat the file like a browsing history.

---

## Security and privacy

The short version: **no data leaves your machine.**

- No server, no account, no analytics, no remote code.
- The popup and options page make **zero network requests**. Even favicons come
  from Chrome's own cache through the internal `_favicon` endpoint rather than
  being fetched from the sites you visit. Verify in DevTools → Network.
- **Four permissions**, no host permissions, **no content scripts** at all — the
  extension cannot read or modify any web page, and no page can see it.
- **`chrome.storage.local` only**, never `chrome.storage.sync` (sync would upload
  your tab titles to Google).
- Tab titles and addresses are attacker-controlled text. Everything reaches the DOM
  through `textContent`/`createTextNode`: there is no `innerHTML`, no `eval`, no
  `new Function`, no inline script or handler anywhere.
- Imported backups and stored settings are re-validated: numbers clamped, unknown
  keys dropped, URL schemes allowlisted (`javascript:`, `data:`, `blob:` rejected),
  image URLs limited to http/https/raster data URIs, every field length-capped.
- A failed storage read can never overwrite your saved sessions with an empty list.

Full detail in [PRIVACY.md](PRIVACY.md).

---

## Development

Plain ES modules. No build step, no dependencies, no bundler — `Load unpacked` runs
the source you can read.

```
src/lib/core.js        pure decisions: normalise, dedupe, group, suggest, validate
src/lib/api.js         timeouts, retry with backoff + jitter, retry budget, batching
src/lib/storage.js     capped local persistence, backup/restore, no-loss reads
src/lib/tabActions.js  the tab operations, each reporting { ok, failed }
src/lib/log.js         privacy-preserving logging
src/background.js      toolbar badge + keyboard shortcuts
src/popup.*            the main UI
src/options.*          settings, sessions, backup
tests/core.test.js     unit tests for the decision logic
tools/make-icons.py    regenerates the icons (standard library only)
```

### Tests

```bash
node --test tests/
```

18 tests covering URL handling, duplicate-keeping rules, the protection rules,
settings clamping and hostile-input rejection — the places where a bug would
actually cost someone tabs. `core.js` imports nothing and touches no browser API,
which is what makes it testable in milliseconds.

### Icons

```bash
python3 tools/make-icons.py
```

Reproducible PNGs, standard library only.

### Design notes

- Every Chrome API call has a timeout, so the UI cannot hang.
- Transient failures retry with exponential backoff plus jitter; permanent ones
  ("no tab with id") never retry, because retrying hides the real message.
- A retry budget pauses retries after repeated failures instead of hammering a
  broken API.
- Bulk work runs in chunks of 4–6 with a small gap, so a 300-tab action doesn't
  freeze the browser.
- Operations are idempotent: acting on a tab that is already gone is recorded as a
  failure, never retried into a mistake.
- The MV3 service worker keeps no state beyond one debounce timer, because Chrome
  can stop it at any moment.

---

## Status

Working, tested, and used locally. Not yet published to the Chrome Web Store.
Publishing needs a $5 developer account, a review, and a listing name that isn't
already taken — `Mothball Tabs` appeared to be free at the time of writing, but the
store is the final judge.

## Licence

No licence file yet, which means all rights reserved by default. If you want others
to reuse this, add an MIT licence; if you plan to sell it later, leave it as is.

## Credits

Built from scratch. The name is not affiliated with any other tab extension.

# Privacy policy — Mothball Tabs

**Last updated: 17 November 2026**

## The short version

Mothball Tabs does not collect, transmit, sell or share any data. It has no server,
no account system, no analytics and no network code. Everything it stores stays in
your own browser profile on your own device.

## What the extension reads

To show you your tabs, the extension reads the title, address, pinned/active/
audible/muted state and last-visit time of the tabs in your browser. This
information is used only to draw the popup and to decide what to suggest. It is
never sent anywhere.

The extension has **no host permissions** and **no content scripts**, so it cannot
read the contents of any web page, and no web page can communicate with it.

## What the extension stores

All of the following is kept in `chrome.storage.local`, inside your browser
profile, readable only by this extension:

- **Settings** — idle threshold, grouping threshold, protected domains, whether to
  confirm bulk closes, debug flag.
- **Saved sessions** — the names and addresses you chose to save. Capped at 50
  sessions of 400 tabs.
- **Usage counters** — three numbers: tabs closed, tabs slept, sessions saved. No
  page data, no timestamps of individual actions.

The extension deliberately does **not** use `chrome.storage.sync`, which would
upload this data to Google's servers.

## Network activity

There is none. The extension contains no `fetch`, no `XMLHttpRequest`, no remote
script, no web socket and no third-party SDK. Favicons shown in the popup are
served from Chrome's own local cache via the internal `_favicon` endpoint, so the
sites you visit are not contacted by the extension.

You can verify this yourself: open the popup, open DevTools, and look at the
Network tab — it stays empty.

## Permissions and why each one exists

| Permission | Why |
| --- | --- |
| `tabs` | Read tab titles and addresses so they can be listed, grouped and closed |
| `storage` | Remember your settings and saved sessions locally |
| `tabGroups` | Create and label Chrome tab groups when you ask for grouping |
| `favicon` | Show site icons from Chrome's cache without any network request |

No host permissions are requested. No browsing history, bookmarks, downloads,
passwords, cookies or page content is accessed.

## Your control over the data

- Delete a saved session in the options page.
- **Delete all extension data** in the options page removes settings, sessions and
  counters in one click.
- Uninstalling the extension removes its storage.

Note that a backup file you export contains page addresses. Keep it as private as
you would keep your browsing history.

## Logs

Debug logging is off by default and can be enabled in settings. Logs contain counts
and error messages only — never tab titles, addresses or page content.

## Children

The extension is a general-purpose browser utility and is not directed at
children. It collects no personal information from anyone.

## Changes

If this policy ever changes, the update will be published in this repository.

## Contact

Open an issue in this repository.

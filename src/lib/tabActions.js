/**
 * The handful of real actions Mothball Tabs performs on tabs.
 *
 * Each one returns { ok, failed } (plus a few counts) instead of throwing, so the
 * UI can be specific — "closed 9 of 11" beats "something went wrong".
 * Nothing here decides *what* to close; that is core.js, which is pure and
 * reviewable. This module only carries the decisions out.
 */

import { findDuplicateGroups } from './core.js';
import { runBatched, withTimeout } from './api.js';
import { bumpStats } from './storage.js';
import { debug, error as logError } from './log.js';

const CLOSE_TIMEOUT_MS = 8000;
const SLEEP_TIMEOUT_MS = 8000;
const SESSION_URL_CAP = 50;

function cleanIds(ids) {
  const seen = new Set();
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Closes tabs one by one so a single stale id cannot block the rest. */
export async function closeTabIds(ids) {
  const list = cleanIds(ids);
  if (!list.length) return { ok: [], failed: [] };

  const result = await runBatched(
    list,
    async (id) => {
      await withTimeout(chrome.tabs.remove(id), CLOSE_TIMEOUT_MS, 'close tab');
    },
    { concurrency: 6, gapMs: 8 },
  );

  if (result.ok.length) await bumpStats({ closed: result.ok.length });
  debug('close finished', { requested: list.length, closed: result.ok.length, failed: result.failed.length });
  return result;
}

/**
 * Puts tabs to sleep (discards them from memory, keeps them in the strip).
 * Protected tabs are filtered here as a second line of defence, in case the
 * caller's list was built from slightly older state.
 */
export async function sleepTabs(tabs) {
  const list = Array.isArray(tabs) ? tabs : [];
  const eligible = list.filter((tab) => !tab.active && !tab.audible && !tab.discarded && !tab.pinned);
  const skipped = list.length - eligible.length;

  if (!eligible.length) return { ok: [], failed: [], skipped };

  const result = await runBatched(
    eligible.map((tab) => tab.id),
    async (id) => {
      await withTimeout(chrome.tabs.discard(id), SLEEP_TIMEOUT_MS, 'sleep tab');
    },
    { concurrency: 4, gapMs: 10 },
  );

  if (result.ok.length) await bumpStats({ slept: result.ok.length });
  debug('sleep finished', { requested: list.length, slept: result.ok.length, skipped, failed: result.failed.length });
  return { ...result, skipped };
}

/** Closes every extra copy of a page, keeping the best copy of each. */
export async function closeDuplicateTabs(tabs) {
  const groups = findDuplicateGroups(Array.isArray(tabs) ? tabs : []);
  const ids = groups.flatMap((group) => group.extras.map((tab) => tab.id));
  const result = await closeTabIds(ids);
  return { ...result, duplicates: ids.length, pages: groups.length };
}

const GROUP_COLORS = ['blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'cyan', 'grey'];

/**
 * Groups tabs by site within their own window (Chrome does not allow a tab group
 * to span windows). Sites with a single tab are left alone — a group of one is
 * just clutter with a label.
 */
export async function groupTabsBySite(tabs) {
  const list = Array.isArray(tabs) ? tabs : [];
  const buckets = new Map();
  for (const tab of list) {
    const key = `${tab.windowId}\u0000${tab.label}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(tab);
    else buckets.set(key, [tab]);
  }

  const result = { ok: [], failed: [], groups: 0 };
  let colorIndex = 0;

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const label = bucket[0].label;
    const windowId = bucket[0].windowId;
    try {
      const groupId = await chrome.tabs.group({
        tabIds: bucket.map((tab) => tab.id),
        createProperties: { windowId },
      });
      await chrome.tabGroups.update(groupId, {
        title: label,
        color: GROUP_COLORS[colorIndex % GROUP_COLORS.length],
      });
      colorIndex += 1;
      result.groups += 1;
      result.ok.push(groupId);
    } catch (error) {
      logError(`Could not group ${label}`, error);
      result.failed.push({ item: label, error: String(error?.message || error) });
    }
  }

  return result;
}

/** Opens a saved session in a fresh window. */
export async function restoreCollection(collection) {
  const urls = (collection?.tabs || []).map((tab) => tab.url).filter((url) => typeof url === 'string');
  if (!urls.length) throw new Error('That session has no usable addresses.');

  const slice = urls.slice(0, SESSION_URL_CAP);
  const created = await chrome.windows.create({ url: slice, focused: true });
  return { opened: slice.length, requested: urls.length, windowId: created?.id ?? null };
}

/** Brings a tab and its window to the front. */
export async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (typeof tab.windowId === 'number' && tab.windowId >= 0) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

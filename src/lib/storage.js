/**
 * Local persistence (chrome.storage.local — never chrome.storage.sync).
 *
 * Sync storage would ship tab titles to Google's servers, so it is deliberately
 * not used. Everything here stays in this browser profile.
 *
 * Design notes:
 *   - A short-lived in-memory cache avoids re-reading storage on every render.
 *   - Reads that fail are visible: settings fall back to defaults (harmless),
 *     but collections never fall back to an empty list, because writing that
 *     empty list back would erase a user's saved sessions.
 *   - Collections are sanitised on the way in and capped, so storage cannot grow
 *     without bound and a corrupted entry cannot break the UI.
 */

import { DEFAULT_SETTINGS, makeId, sanitizeCollection, validateSettings } from './core.js';
import { RetryBudget, callWithRetry } from './api.js';
import { debug, error as logError } from './log.js';

const SETTINGS_KEY = 'settings';
const COLLECTIONS_KEY = 'collections';
const STATS_KEY = 'stats';
const EXPORT_VERSION = 1;

const CACHE_TTL_MS = 2500;
const cache = new Map();
const budget = new RetryBudget({ threshold: 8, cooldownMs: 20000 });

const EMPTY_STATS = { closed: 0, slept: 0, sessions: 0, lastCleanupAt: 0 };

async function readRaw(key) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const result = await callWithRetry(`storage.get(${key})`, () => chrome.storage.local.get(key), {
    attempts: 2,
    budget,
  });
  const value = result && typeof result === 'object' ? result[key] : undefined;
  cache.set(key, { value, at: Date.now() });
  return value;
}

async function writeRaw(key, value) {
  await callWithRetry(`storage.set(${key})`, () => chrome.storage.local.set({ [key]: value }), {
    attempts: 2,
    budget,
  });
  cache.set(key, { value, at: Date.now() });
}

/* -------------------------------------------------------------------------- */
/* settings                                                                   */
/* -------------------------------------------------------------------------- */

export async function getSettings() {
  try {
    const stored = await readRaw(SETTINGS_KEY);
    return validateSettings(stored, DEFAULT_SETTINGS);
  } catch (error) {
    logError('Could not read settings, using defaults', error);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = validateSettings({ ...current, ...(patch || {}) }, current);
  await writeRaw(SETTINGS_KEY, next);
  debug('settings saved', { idleDays: next.idleDays, protectedDomains: next.protectedDomains.length });
  return next;
}

/* -------------------------------------------------------------------------- */
/* saved sessions                                                             */
/* -------------------------------------------------------------------------- */

export async function getCollections() {
  let stored;
  try {
    stored = await readRaw(COLLECTIONS_KEY);
  } catch (error) {
    logError('Could not read saved sessions', error);
    return [];
  }
  const settings = await getSettings();
  const list = Array.isArray(stored) ? stored : [];
  return list.map((item) => sanitizeCollection(item, settings)).filter(Boolean);
}

export async function addCollection(input, settings = null) {
  const limits = settings || (await getSettings());
  const clean = sanitizeCollection(input, limits);
  if (!clean) throw new Error('Nothing to save: no usable tab addresses in the selection.');

  let existing;
  try {
    existing = await readRaw(COLLECTIONS_KEY);
  } catch {
    // Refuse rather than risk overwriting real sessions with an empty list.
    throw new Error('Local storage is unavailable, so nothing was saved. Your tabs are untouched.');
  }

  const list = Array.isArray(existing) ? existing : [];
  const next = [clean, ...list].slice(0, limits.maxCollections);
  await writeRaw(COLLECTIONS_KEY, next);
  await bumpStats({ sessions: 1 });
  return clean;
}

export async function deleteCollection(id) {
  if (typeof id !== 'string') return 0;
  const existing = await readRaw(COLLECTIONS_KEY);
  const list = Array.isArray(existing) ? existing : [];
  const next = list.filter((item) => item && item.id !== id);
  await writeRaw(COLLECTIONS_KEY, next);
  return list.length - next.length;
}

/* -------------------------------------------------------------------------- */
/* usage counters (no page data, just numbers)                                */
/* -------------------------------------------------------------------------- */

async function readStats() {
  try {
    const stored = await readRaw(STATS_KEY);
    if (!stored || typeof stored !== 'object') return { ...EMPTY_STATS };
    return {
      closed: Number(stored.closed) || 0,
      slept: Number(stored.slept) || 0,
      sessions: Number(stored.sessions) || 0,
      lastCleanupAt: Number(stored.lastCleanupAt) || 0,
    };
  } catch {
    return { ...EMPTY_STATS };
  }
}

export async function bumpStats(patch = {}) {
  const current = await readStats();
  const closed = Math.max(0, Number(patch.closed) || 0);
  const slept = Math.max(0, Number(patch.slept) || 0);
  const sessions = Math.max(0, Number(patch.sessions) || 0);
  const next = {
    closed: current.closed + closed,
    slept: current.slept + slept,
    sessions: current.sessions + sessions,
    lastCleanupAt: closed || slept ? Date.now() : current.lastCleanupAt,
  };
  try {
    await writeRaw(STATS_KEY, next);
  } catch (error) {
    debug('stats not written', error);
  }
  return next;
}

export async function getStats() {
  return readStats();
}

/* -------------------------------------------------------------------------- */
/* backup / restore                                                           */
/* -------------------------------------------------------------------------- */

export async function exportAll() {
  const [settings, collections, stats] = await Promise.all([getSettings(), getCollections(), readStats()]);
  return {
    app: 'mothball-tabs',
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    settings,
    collections,
    stats,
  };
}

/**
 * Merges a backup file back in. The payload is untrusted: every session goes
 * through sanitizeCollection, and nothing outside the known shape is kept.
 */
export async function importAll(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('That file is not a Mothball Tabs backup.');
  if (payload.app !== undefined && payload.app !== 'mothball-tabs') {
    throw new Error('That file is not a Mothball Tabs backup.');
  }

  const settings = await getSettings();
  const incoming = Array.isArray(payload.collections) ? payload.collections : [];
  const cleanIncoming = incoming.map((item) => sanitizeCollection(item, settings)).filter(Boolean);

  const existing = await getCollections();
  const knownIds = new Set(existing.map((item) => item.id));
  const knownSignatures = new Set(existing.map(signatureOf));

  let added = 0;
  let skipped = 0;
  const merged = [...existing];
  for (const item of cleanIncoming) {
    const signature = signatureOf(item);
    if (knownIds.has(item.id) || knownSignatures.has(signature)) {
      skipped += 1;
      continue;
    }
    // Fresh id in case the file reuses one we already have.
    merged.push({ ...item, id: makeId() });
    knownIds.add(item.id);
    knownSignatures.add(signature);
    added += 1;
  }

  merged.sort((a, b) => b.createdAt - a.createdAt);
  await writeRaw(COLLECTIONS_KEY, merged.slice(0, settings.maxCollections));

  if (payload.settings && typeof payload.settings === 'object') {
    await saveSettings(validateSettings(payload.settings, settings));
  }

  return { added, skipped, invalid: incoming.length - cleanIncoming.length };
}

function signatureOf(collection) {
  return `${collection.name}|${collection.tabs.map((tab) => tab.url).join('\u0000')}`;
}

/** Removes everything this extension stored. */
export async function clearAll() {
  cache.clear();
  await callWithRetry('storage.clear', () => chrome.storage.local.remove([SETTINGS_KEY, COLLECTIONS_KEY, STATS_KEY]), {
    attempts: 2,
    budget,
  });
}

/**
 * Mothball Tabs — decision logic.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE LOOKS THE WAY IT DOES
 * ---------------------------------------------------------------------------
 * Every suggestion the assistant makes comes from a rule in this file. No
 * network calls, no model, no heuristics hidden in the UI. That means:
 *   - the rules can be unit-tested (tests/core.test.js),
 *   - a user can read exactly why something was recommended,
 *   - nothing here depends on `chrome.*`, so it is portable and auditable.
 *
 * All functions are pure: same input, same output, no side effects.
 */

export const DEFAULT_SETTINGS = Object.freeze({
  /** Tabs untouched for this many days are suggested for sleeping. */
  idleDays: 7,
  /** Pinned tabs are never suggested for sleeping or closing. */
  protectPinned: true,
  /** Domains (e.g. "github.com") that must never be suggested. */
  protectedDomains: [],
  /** Ask before closing more than one tab. */
  confirmBulkClose: true,
  /** A site with this many open tabs is suggested for grouping. */
  groupThreshold: 8,
  /** Hard caps so local storage can never grow without bound. */
  maxCollections: 50,
  maxTabsPerCollection: 400,
  /** Verbose console logging. */
  debug: false,
});

export const MAX_URL_LENGTH = 8192;
export const MAX_COLLECTION_NAME = 80;
export const MAX_TAB_TITLE = 200;

/**
 * Schemes we are willing to display and act on. Anything else (javascript:,
 * blob:, data: used as a link, chrome-search:, extension-internal schemes we do
 * not own) is treated as "unknown" and left alone.
 */
const ALLOWED_PROTOCOLS = new Set([
  'http:',
  'https:',
  'file:',
  'chrome:',
  'chrome-extension:',
  'edge:',
  'about:',
  'view-source:',
]);

/** Click-tracking parameters that do not change the page being shown. */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'yclid',
  'twclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'si',
  '_ga',
  '_gl',
  'spm',
]);

const DAY_MS = 86400000;

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function truncate(text, max) {
  const str = typeof text === 'string' ? text : '';
  if (str.length <= max) return str;
  return `${str.slice(0, Math.max(0, max - 1))}…`;
}

export function isTrackingParam(name) {
  const key = String(name).toLowerCase();
  return key.startsWith('utm_') || key.startsWith('pk_') || TRACKING_PARAMS.has(key);
}

/**
 * Accepts only image URLs we are willing to put in an <img> tag.
 * Rejects javascript:, chrome:, file:, blob:, and SVG (SVG can carry script).
 * Used for data imported from a backup file, which is untrusted input.
 */
export function isSafeImageUrl(url) {
  if (typeof url !== 'string' || !url || url.length > 2048) return false;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) return true;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:';
}

/* -------------------------------------------------------------------------- */
/* URL normalisation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Parses a tab URL into a comparable shape.
 * Returns null for unparseable or disallowed URLs instead of throwing, so one
 * odd tab can never break a whole render.
 *
 * dropTracking / dropHash exist so that two URLs that show the same page
 * compare as equal (that is what "duplicate" means here).
 */
export function normalizeUrl(raw, { dropTracking = false, dropHash = false } = {}) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;

  const protocol = parsed.protocol;
  const hostname = parsed.hostname || '';
  const host = parsed.host || hostname;
  const pathname = parsed.pathname || '/';

  let search = '';
  if (parsed.search) {
    if (dropTracking) {
      const kept = [];
      for (const [key, value] of parsed.searchParams) {
        if (!isTrackingParam(key)) kept.push([key, value]);
      }
      // Stable ordering so ?a=1&b=2 and ?b=2&a=1 compare equal.
      kept.sort((a, b) => (a[0] === b[0] ? compareStrings(a[1], b[1]) : compareStrings(a[0], b[0])));
      if (kept.length) {
        const stable = new URLSearchParams();
        for (const [key, value] of kept) stable.append(key, value);
        search = `?${stable.toString()}`;
      }
    } else {
      search = parsed.search;
    }
  }

  const hash = dropHash ? '' : parsed.hash;

  return {
    protocol,
    hostname,
    host,
    pathname,
    search,
    hash,
    key: `${protocol}//${host}${pathname}${search}`,
  };
}

function compareStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The identity used for duplicate detection: same page, minus noise. */
export function dedupeKey(url) {
  const normalized = normalizeUrl(url, { dropTracking: true, dropHash: true });
  return normalized ? normalized.key : null;
}

/** Human label for a site, e.g. "github.com" or "Local files". */
export function siteLabel(urlOrNormalized) {
  const normalized =
    urlOrNormalized && typeof urlOrNormalized === 'object' ? urlOrNormalized : normalizeUrl(urlOrNormalized);
  if (!normalized) return 'other';
  if (normalized.protocol === 'http:' || normalized.protocol === 'https:') {
    return normalized.hostname.replace(/^www\./, '') || normalized.host;
  }
  if (normalized.protocol === 'file:') return 'Local files';
  if (normalized.protocol === 'chrome:' || normalized.protocol === 'edge:') return 'Browser pages';
  if (normalized.protocol === 'chrome-extension:') return 'Extensions';
  return 'Other';
}

/* -------------------------------------------------------------------------- */
/* tab view model                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Maps a chrome.tabs.Tab into the flat shape the rest of the app uses.
 * Deliberately drops favIconUrl: favicons are served from Chrome's own cache via
 * the _favicon endpoint, so the UI never contacts a third-party host.
 */
export function toTabView(tab) {
  if (!tab || typeof tab.id !== 'number') return null;
  const url = typeof tab.url === 'string' ? tab.url : '';
  const normalized = normalizeUrl(url);
  const fallbackTitle = normalized ? normalized.hostname || url : url;

  return {
    id: tab.id,
    windowId: typeof tab.windowId === 'number' ? tab.windowId : -1,
    index: typeof tab.index === 'number' ? tab.index : 0,
    title: truncate(typeof tab.title === 'string' && tab.title.trim() ? tab.title.trim() : fallbackTitle, MAX_TAB_TITLE),
    url,
    label: siteLabel(normalized),
    dedupeKey: dedupeKey(url),
    pinned: tab.pinned === true,
    active: tab.active === true,
    audible: tab.audible === true,
    discarded: tab.discarded === true,
    groupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
    // lastAccessed is only present on Chrome 121+; null means "we do not know",
    // and unknown tabs are never suggested for sleeping.
    lastAccessed: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : null,
  };
}

/* -------------------------------------------------------------------------- */
/* grouping, filtering, duplicates                                            */
/* -------------------------------------------------------------------------- */

/** Site buckets, biggest first. */
export function groupBySite(tabs) {
  const list = Array.isArray(tabs) ? tabs : [];
  const buckets = new Map();
  for (const tab of list) {
    const bucket = buckets.get(tab.label);
    if (bucket) bucket.push(tab);
    else buckets.set(tab.label, [tab]);
  }
  const groups = [...buckets.entries()].map(([label, groupTabs]) => ({
    key: label,
    label,
    tabs: [...groupTabs].sort((a, b) => a.index - b.index),
  }));
  groups.sort((a, b) => b.tabs.length - a.tabs.length || a.label.localeCompare(b.label));
  return groups;
}

/**
 * Which copy of a duplicated page to keep: pinned first, then the visible one,
 * then the most recently used, then the leftmost. Deterministic, so repeated
 * runs never fight over which tab survives.
 */
export function compareKeeper(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.active !== b.active) return a.active ? -1 : 1;
  const aSeen = a.lastAccessed ?? -Infinity;
  const bSeen = b.lastAccessed ?? -Infinity;
  if (aSeen !== bSeen) return bSeen - aSeen;
  return a.index - b.index;
}

export function findDuplicateGroups(tabs) {
  const list = Array.isArray(tabs) ? tabs : [];
  const buckets = new Map();
  for (const tab of list) {
    if (!tab.dedupeKey) continue;
    const bucket = buckets.get(tab.dedupeKey);
    if (bucket) bucket.push(tab);
    else buckets.set(tab.dedupeKey, [tab]);
  }

  const groups = [];
  for (const [key, groupTabs] of buckets) {
    if (groupTabs.length < 2) continue;
    const sorted = [...groupTabs].sort(compareKeeper);
    groups.push({
      key,
      label: sorted[0].label,
      keeper: sorted[0],
      extras: sorted.slice(1),
      tabs: sorted,
    });
  }
  groups.sort((a, b) => b.extras.length - a.extras.length || a.label.localeCompare(b.label));
  return groups;
}

/** Token search over title, URL and site label. All tokens must match. */
export function filterTabs(tabs, query) {
  const list = Array.isArray(tabs) ? tabs : [];
  const tokens = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (!tokens.length) return [...list];
  return list.filter((tab) => {
    const haystack = `${tab.title} ${tab.url} ${tab.label}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/* -------------------------------------------------------------------------- */
/* protection rules                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A tab is protected when acting on it could lose something the user cares
 * about: a pinned tab, the tab they are looking at, audio that is playing, or a
 * domain they asked us to leave alone.
 */
export function isProtected(tab, settings = DEFAULT_SETTINGS) {
  if (!tab) return true;
  if (settings.protectPinned && tab.pinned) return true;
  if (tab.active || tab.audible) return true;
  const normalized = normalizeUrl(tab.url);
  if (!normalized) return true;
  const hostname = normalized.hostname.replace(/^www\./, '');
  return settings.protectedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

/* -------------------------------------------------------------------------- */
/* the assistant                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Builds the suggestion cards. Each suggestion is a plain rule with the exact
 * tab ids it would touch, so the UI can show it, preview it, or apply it.
 *
 * tone: 'warn' for anything destructive, 'calm' for reversible actions.
 */
export function buildSuggestions(tabs, settings = DEFAULT_SETTINGS, now = Date.now()) {
  const list = Array.isArray(tabs) ? tabs : [];
  const suggestions = [];

  const duplicateGroups = findDuplicateGroups(list);
  const duplicateIds = duplicateGroups.flatMap((group) => group.extras.map((tab) => tab.id));
  if (duplicateIds.length) {
    suggestions.push({
      id: 'duplicates',
      kind: 'duplicates',
      action: 'close',
      tone: 'warn',
      title: `${duplicateIds.length} duplicate tab${duplicateIds.length === 1 ? '' : 's'}`,
      detail: `${duplicateGroups.length} page${duplicateGroups.length === 1 ? ' is' : 's are'} open more than once. One copy of each stays open.`,
      tabIds: duplicateIds,
    });
  }

  const idleMs = clampInt(settings.idleDays, 1, 365, DEFAULT_SETTINGS.idleDays) * DAY_MS;
  const cutoff = now - idleMs;
  const idleIds = list
    .filter((tab) => !isProtected(tab, settings) && tab.lastAccessed !== null && tab.lastAccessed < cutoff)
    .map((tab) => tab.id);
  if (idleIds.length) {
    suggestions.push({
      id: 'idle',
      kind: 'idle',
      action: 'sleep',
      tone: 'calm',
      title: `${idleIds.length} tab${idleIds.length === 1 ? '' : 's'} untouched for ${settings.idleDays}+ days`,
      detail: 'Sleeping frees memory and keeps every tab where it is. Nothing is closed.',
      tabIds: idleIds,
    });
  }

  const threshold = clampInt(settings.groupThreshold, 3, 50, DEFAULT_SETTINGS.groupThreshold);
  const heavySites = groupBySite(list).filter((group) => group.tabs.length >= threshold);
  if (heavySites.length) {
    const heavyIds = heavySites.flatMap((group) => group.tabs.filter((tab) => !tab.pinned).map((tab) => tab.id));
    if (heavyIds.length) {
      suggestions.push({
        id: 'group',
        kind: 'group',
        action: 'group',
        tone: 'calm',
        title: `${heavySites.length} site${heavySites.length === 1 ? '' : 's'} with ${threshold}+ tabs`,
        detail: 'Bundle each site into a named, coloured tab group so the strip stays readable.',
        tabIds: heavyIds,
      });
    }
  }

  return suggestions;
}

/* -------------------------------------------------------------------------- */
/* stats                                                                      */
/* -------------------------------------------------------------------------- */

export function computeStats(tabs, settings = DEFAULT_SETTINGS, now = Date.now()) {
  const list = Array.isArray(tabs) ? tabs : [];
  const idleMs = clampInt(settings.idleDays, 1, 365, DEFAULT_SETTINGS.idleDays) * DAY_MS;
  const cutoff = now - idleMs;
  return {
    total: list.length,
    windows: new Set(list.map((tab) => tab.windowId)).size,
    sites: new Set(list.map((tab) => tab.label)).size,
    duplicates: findDuplicateGroups(list).reduce((sum, group) => sum + group.extras.length, 0),
    idle: list.filter((tab) => !isProtected(tab, settings) && tab.lastAccessed !== null && tab.lastAccessed < cutoff)
      .length,
    sleeping: list.filter((tab) => tab.discarded).length,
    pinned: list.filter((tab) => tab.pinned).length,
  };
}

/* -------------------------------------------------------------------------- */
/* validation (settings and imported data are untrusted input)               */
/* -------------------------------------------------------------------------- */

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function sanitizeDomains(value) {
  const input = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of input.slice(0, 200)) {
    if (typeof item !== 'string') continue;
    const cleaned = item
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/[/?#].*$/, '')
      .replace(/^www\./, '')
      .replace(/:\d+$/, '');
    if (!DOMAIN_PATTERN.test(cleaned)) continue;
    if (!out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

/**
 * Coerces anything into a valid settings object: numbers are clamped into a
 * safe range, unknown keys are dropped, junk domains are discarded.
 */
export function validateSettings(input, base = DEFAULT_SETTINGS) {
  const raw = input && typeof input === 'object' ? input : {};
  const pick = (key) => (Object.hasOwn(raw, key) ? raw[key] : base[key]);
  return {
    idleDays: clampInt(pick('idleDays'), 1, 365, base.idleDays),
    protectPinned: pick('protectPinned') !== false,
    protectedDomains: sanitizeDomains(pick('protectedDomains')),
    confirmBulkClose: pick('confirmBulkClose') !== false,
    groupThreshold: clampInt(pick('groupThreshold'), 3, 50, base.groupThreshold),
    maxCollections: clampInt(pick('maxCollections'), 1, 200, base.maxCollections),
    maxTabsPerCollection: clampInt(pick('maxTabsPerCollection'), 1, 2000, base.maxTabsPerCollection),
    debug: pick('debug') === true,
  };
}

export function makeId() {
  const bytes = new Uint8Array(9);
  const cryptoApi = typeof crypto !== 'undefined' ? crypto : null;
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}

/**
 * A saved session, rebuilt from untrusted input (storage or an imported file).
 * Anything with no usable URL is dropped rather than repaired.
 */
export function sanitizeCollection(input, settings = DEFAULT_SETTINGS) {
  if (!input || typeof input !== 'object') return null;
  const rawTabs = Array.isArray(input.tabs) ? input.tabs : [];
  const tabs = [];
  for (const entry of rawTabs.slice(0, settings.maxTabsPerCollection)) {
    if (!entry || typeof entry !== 'object') continue;
    const url = typeof entry.url === 'string' ? entry.url : '';
    const normalized = normalizeUrl(url);
    if (!normalized) continue;
    tabs.push({
      title: truncate(
        typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : normalized.hostname || url,
        MAX_TAB_TITLE,
      ),
      url: truncate(url, MAX_URL_LENGTH),
      favIconUrl: isSafeImageUrl(entry.favIconUrl) ? entry.favIconUrl : '',
    });
  }
  if (!tabs.length) return null;

  const name = truncate(
    typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Untitled session',
    MAX_COLLECTION_NAME,
  );
  const createdAt = Number.isFinite(input.createdAt) && input.createdAt > 0 ? input.createdAt : Date.now();
  const id =
    typeof input.id === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(input.id) ? input.id : makeId();

  return { id, name, createdAt, tabs };
}

/* -------------------------------------------------------------------------- */
/* formatting                                                                 */
/* -------------------------------------------------------------------------- */

export function formatRelative(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return '';
  const diff = Math.max(0, now - timestamp);
  if (diff < 45000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < DAY_MS) return `${Math.round(diff / 3600000)}h ago`;
  if (diff < 7 * DAY_MS) return `${Math.round(diff / DAY_MS)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Tests for the decision logic.
 *
 * These run in plain Node with no browser and no dependencies:
 *     cd mothball-tabs && node --test tests/
 *
 * Only lib/core.js is covered here, deliberately. It is where every decision
 * lives, so testing it is testing the assistant. The Chrome-facing modules are
 * thin wrappers around browser APIs and are exercised by loading the extension.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  buildSuggestions,
  computeStats,
  dedupeKey,
  filterTabs,
  findDuplicateGroups,
  formatRelative,
  groupBySite,
  isSafeImageUrl,
  normalizeUrl,
  sanitizeCollection,
  toTabView,
  validateSettings,
} from '../src/lib/core.js';

const DAY = 86400000;
const NOW = 1_700_000_000_000;

/** Builds a tab view the same way the popup does, from a chrome.tabs-shaped object. */
function makeTab(overrides = {}) {
  return toTabView({
    id: 1,
    windowId: 1,
    index: 0,
    title: 'Example',
    url: 'https://example.com/',
    pinned: false,
    active: false,
    audible: false,
    discarded: false,
    ...overrides,
  });
}

/* -------------------------------------------------------------------------- */

test('normalizeUrl rejects dangerous and unusable input', () => {
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('data:text/html,<h1>x</h1>'), null);
  assert.equal(normalizeUrl('   '), null);
  assert.equal(normalizeUrl('not a url'), null);
  assert.equal(normalizeUrl(null), null);
  assert.equal(normalizeUrl(123), null);

  const ok = normalizeUrl('https://www.example.com/a?b=2#frag');
  assert.equal(ok.hostname, 'www.example.com');
  assert.equal(ok.pathname, '/a');
  assert.equal(ok.hash, '#frag');
});

test('dedupeKey ignores tracking parameters, ordering and fragments', () => {
  const clean = dedupeKey('https://example.com/post?id=7');
  assert.equal(dedupeKey('https://example.com/post?utm_source=newsletter&id=7'), clean);
  assert.equal(dedupeKey('https://example.com/post?id=7#comments'), clean);
  assert.equal(dedupeKey('https://example.com/post?fbclid=abc&id=7'), clean);
  assert.notEqual(dedupeKey('https://example.com/post?id=8'), clean);
  assert.equal(dedupeKey('javascript:void(0)'), null);
});

test('toTabView tolerates a sparse tab and keeps properties separate', () => {
  const view = makeTab({ title: '   ', url: 'https://news.example.com/x' });
  assert.equal(view.title, 'news.example.com', 'a blank title falls back to the site name');
  assert.equal(view.label, 'news.example.com');
  assert.equal(view.pinned, false);

  const odd = toTabView({ id: 9, url: 'javascript:alert(1)', title: '' });
  assert.equal(odd.label, 'other');
  assert.equal(odd.dedupeKey, null);
  assert.equal(odd.lastAccessed, null);
  assert.equal(toTabView({}), null);
});

test('duplicate groups keep the safest copy and list the rest', () => {
  const tabs = [
    makeTab({ id: 1, index: 0, lastAccessed: 1000 }),
    makeTab({ id: 2, index: 1, lastAccessed: 5000 }),
    makeTab({ id: 3, index: 2, pinned: true, lastAccessed: 10 }),
    makeTab({ id: 4, index: 3, url: 'https://other.example.com/' }),
  ];

  const groups = findDuplicateGroups(tabs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keeper.id, 3, 'a pinned copy is never the one closed');
  assert.deepEqual(
    groups[0].extras.map((tab) => tab.id),
    [2, 1],
    'remaining copies are ordered most recently used first',
  );
});

test('duplicates are detected across windows and ignored when unique', () => {
  const tabs = [
    makeTab({ id: 1, windowId: 1 }),
    makeTab({ id: 2, windowId: 2, url: 'https://example.com/other' }),
    makeTab({ id: 3, windowId: 2 }),
  ];
  const groups = findDuplicateGroups(tabs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].extras.length, 1);
  assert.equal(groups[0].keeper.id, 1);
});

test('buildSuggestions proposes closing duplicate extras only', () => {
  const tabs = [makeTab({ id: 1, lastAccessed: NOW }), makeTab({ id: 2, lastAccessed: NOW - DAY })];
  const suggestions = buildSuggestions(tabs, DEFAULT_SETTINGS, NOW);
  const duplicates = suggestions.find((item) => item.kind === 'duplicates');
  assert.ok(duplicates);
  assert.deepEqual(duplicates.tabIds, [2]);
  assert.equal(duplicates.action, 'close');
});

test('idle suggestions skip pinned, audible, protected and unknown-age tabs', () => {
  const old = NOW - 30 * DAY;
  const tabs = [
    makeTab({ id: 1, url: 'https://a.example.com/', lastAccessed: old }),
    makeTab({ id: 2, url: 'https://b.example.com/', lastAccessed: old, pinned: true }),
    makeTab({ id: 3, url: 'https://c.example.com/', lastAccessed: old, audible: true }),
    makeTab({ id: 4, url: 'https://bank.example.com/', lastAccessed: old }),
    makeTab({ id: 5, url: 'https://d.example.com/', lastAccessed: null }),
    makeTab({ id: 6, url: 'https://e.example.com/', lastAccessed: NOW - DAY }),
  ];

  const settings = { ...DEFAULT_SETTINGS, protectedDomains: ['example.com'] };
  // example.com protects everything above; drop it to one explicit domain.
  const scoped = { ...settings, protectedDomains: ['bank.example.com'] };
  const suggestion = buildSuggestions(tabs, scoped, NOW).find((item) => item.kind === 'idle');

  assert.ok(suggestion);
  assert.deepEqual(suggestion.tabIds, [1]);
  assert.equal(suggestion.action, 'sleep', 'idle tabs are slept, never closed');
});

test('protected domains cover subdomains but not lookalikes', () => {
  const settings = { ...DEFAULT_SETTINGS, protectedDomains: ['example.com'] };
  const tabs = [
    makeTab({ id: 1, url: 'https://example.com/', lastAccessed: NOW - 40 * DAY }),
    makeTab({ id: 2, url: 'https://app.example.com/x', lastAccessed: NOW - 40 * DAY }),
    makeTab({ id: 3, url: 'https://notexample.com/', lastAccessed: NOW - 40 * DAY }),
  ];
  const suggestion = buildSuggestions(tabs, settings, NOW).find((item) => item.kind === 'idle');
  assert.deepEqual(suggestion.tabIds, [3]);
});

test('a site with many tabs is suggested for grouping', () => {
  const tabs = Array.from({ length: 9 }, (_unused, index) =>
    makeTab({ id: index + 1, url: `https://busy.example.com/${index}`, index }),
  );
  const suggestion = buildSuggestions(tabs, DEFAULT_SETTINGS, NOW).find((item) => item.kind === 'group');
  assert.ok(suggestion);
  assert.equal(suggestion.action, 'group');
  assert.equal(suggestion.tabIds.length, 9);
});

test('grouping excludes pinned tabs and orders sites by size', () => {
  const tabs = [
    makeTab({ id: 1, url: 'https://www.b.example.com/' }),
    makeTab({ id: 2, url: 'https://www.b.example.com/two' }),
    makeTab({ id: 3, url: 'https://a.example.com/' }),
  ];
  const groups = groupBySite(tabs);
  assert.equal(groups[0].label, 'b.example.com');
  assert.equal(groups[0].tabs.length, 2);
  assert.equal(groups[1].label, 'a.example.com');
});

test('search requires every token to match', () => {
  const tabs = [
    makeTab({ id: 1, title: 'Quarterly report', url: 'https://docs.example.com/q3' }),
    makeTab({ id: 2, title: 'Inbox', url: 'https://mail.example.com/' }),
  ];
  assert.equal(filterTabs(tabs, 'quarterly').length, 1);
  assert.equal(filterTabs(tabs, 'EXAMPLE').length, 2);
  assert.equal(filterTabs(tabs, 'quarterly inbox').length, 0);
  assert.equal(filterTabs(tabs, '   ').length, 2);
  assert.equal(filterTabs(tabs, '').length, 2);
});

test('validateSettings clamps, cleans and never trusts stored values', () => {
  const settings = validateSettings({
    idleDays: 0,
    groupThreshold: 999,
    protectedDomains: ['HTTPS://WWW.Bank.example/secure', 'not a domain', 'mail.google.com:443', 'bank.example'],
    confirmBulkClose: 'unexpected',
    protectPinned: false,
    unknownKey: 'ignored',
  });

  assert.equal(settings.idleDays, 1);
  assert.equal(settings.groupThreshold, 50);
  assert.deepEqual(settings.protectedDomains, ['bank.example', 'mail.google.com']);
  assert.equal(settings.confirmBulkClose, true, 'anything other than false keeps the safe default');
  assert.equal(settings.protectPinned, false);
  assert.equal(Object.hasOwn(settings, 'unknownKey'), false);
});

test('validateSettings survives junk instead of throwing', () => {
  for (const junk of [null, undefined, 42, 'string', []]) {
    const settings = validateSettings(junk);
    assert.equal(settings.idleDays, DEFAULT_SETTINGS.idleDays);
    assert.deepEqual(settings.protectedDomains, []);
  }
});

test('isSafeImageUrl only allows plain web images', () => {
  assert.equal(isSafeImageUrl('javascript:alert(1)'), false);
  assert.equal(isSafeImageUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), false);
  assert.equal(isSafeImageUrl('chrome://favicon/'), false);
  assert.equal(isSafeImageUrl('file:///etc/passwd'), false);
  assert.equal(isSafeImageUrl(''), false);
  assert.equal(isSafeImageUrl('https://cdn.example.com/icon.png'), true);
  assert.equal(isSafeImageUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='), true);
});

test('sanitizeCollection drops unusable tabs and caps every field', () => {
  const collection = sanitizeCollection(
    {
      name: 'n'.repeat(300),
      createdAt: 1234,
      tabs: [
        { url: 'https://ok.example.com/a', title: 'A' },
        { url: 'javascript:alert(1)', title: 'nope' },
        { url: 'https://ok.example.com/b', title: 'B', favIconUrl: 'javascript:alert(1)' },
        'not an object',
        null,
      ],
      id: '../../etc',
    },
    DEFAULT_SETTINGS,
  );

  assert.equal(collection.name.length, 80);
  assert.equal(collection.tabs.length, 2);
  assert.equal(collection.tabs[0].url, 'https://ok.example.com/a');
  assert.equal(collection.tabs[1].title, 'B');
  assert.equal(collection.tabs[1].favIconUrl, '', 'unsafe favicons are stripped');
  assert.equal(collection.createdAt, 1234);
  assert.match(collection.id, /^[A-Za-z0-9_-]{4,40}$/, 'a hostile id is replaced, not reused');
  assert.equal(sanitizeCollection({ tabs: [] }), null);
  assert.equal(sanitizeCollection(null), null);
});

test('sanitizeCollection respects the tab cap', () => {
  const tabs = Array.from({ length: 20 }, (_unused, index) => ({ url: `https://example.com/${index}` }));
  const collection = sanitizeCollection({ name: 'big', tabs }, { ...DEFAULT_SETTINGS, maxTabsPerCollection: 5 });
  assert.equal(collection.tabs.length, 5);
});

test('computeStats reports what the header promises', () => {
  const tabs = [
    makeTab({ id: 1, windowId: 1, url: 'https://example.com/' }),
    makeTab({ id: 2, windowId: 1, url: 'https://example.com/' }),
    makeTab({ id: 3, windowId: 2, url: 'https://other.example.com/', discarded: true }),
    makeTab({ id: 4, windowId: 2, url: 'https://pinned.example.com/', pinned: true }),
  ];

  const stats = computeStats(tabs, DEFAULT_SETTINGS, NOW);
  assert.equal(stats.total, 4);
  assert.equal(stats.windows, 2);
  assert.equal(stats.duplicates, 1);
  assert.equal(stats.sleeping, 1);
  assert.equal(stats.pinned, 1);
});

test('formatRelative reads naturally', () => {
  assert.equal(formatRelative(NOW - 1000, NOW), 'just now');
  assert.equal(formatRelative(NOW - 5 * 60000, NOW), '5m ago');
  assert.equal(formatRelative(NOW - 3 * 3600000, NOW), '3h ago');
  assert.equal(formatRelative(NOW - 2 * DAY, NOW), '2d ago');
  assert.equal(formatRelative(NaN, NOW), '');
});

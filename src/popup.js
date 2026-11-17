/**
 * Popup controller.
 *
 * Two habits worth noting if you ever edit this:
 *   1. Every piece of text from a tab (title, URL, site) reaches the DOM through
 *      textContent / createTextNode. There is no innerHTML in this codebase, so a
 *      page titled `"><img src=x onerror=...>` is displayed, not executed.
 *   2. Destructive actions are previews first: the count is always shown, and a
 *      bulk close asks for confirmation unless the user turned that off.
 */

import {
  DEFAULT_SETTINGS,
  buildSuggestions,
  computeStats,
  filterTabs,
  formatRelative,
  groupBySite,
  plural,
  toTabView,
  truncate,
} from './lib/core.js';
import { addCollection, deleteCollection, getCollections, getSettings } from './lib/storage.js';
import { closeTabIds, focusTab, groupTabsBySite, restoreCollection, sleepTabs } from './lib/tabActions.js';
import { error as logError, setDebug } from './lib/log.js';

const $ = (id) => document.getElementById(id);

const state = {
  tabs: [],
  settings: { ...DEFAULT_SETTINGS },
  collections: [],
  selected: new Set(),
  query: '',
  sort: 'site',
  collectionsOpen: false,
  busy: false,
  confirmHandler: null,
  statusTimer: null,
};

/* -------------------------------------------------------------------------- */
/* tiny DOM helper (attribute-safe, text-only)                               */
/* -------------------------------------------------------------------------- */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* -------------------------------------------------------------------------- */
/* data                                                                      */
/* -------------------------------------------------------------------------- */

async function refreshTabs() {
  try {
    const rawTabs = await chrome.tabs.query({});
    state.tabs = rawTabs.map(toTabView).filter(Boolean);
    const alive = new Set(state.tabs.map((tab) => tab.id));
    for (const id of [...state.selected]) {
      if (!alive.has(id)) state.selected.delete(id);
    }
  } catch (error) {
    logError('Could not read tabs', error);
    state.tabs = [];
    setStatus('Could not read your tabs. Try reopening Mothball Tabs.', 'bad');
  }
}

async function refreshCollections() {
  state.collections = await getCollections();
}

/* -------------------------------------------------------------------------- */
/* rendering                                                                 */
/* -------------------------------------------------------------------------- */

function render() {
  renderStats();
  renderSuggestions();
  renderList();
  renderToolbar();
  renderCollections();
}

function renderStats() {
  const stats = computeStats(state.tabs, state.settings);
  const bits = [plural(stats.total, 'tab'), plural(stats.windows, 'window')];
  if (stats.duplicates) bits.push(plural(stats.duplicates, 'duplicate'));
  if (stats.sleeping) bits.push(`${stats.sleeping} sleeping`);
  $('stats').textContent = bits.join(' · ');
}

function renderSuggestions() {
  const box = $('suggestions');
  box.replaceChildren();
  const suggestions = buildSuggestions(state.tabs, state.settings);
  for (const suggestion of suggestions) box.append(suggestionCard(suggestion));
  box.hidden = suggestions.length === 0;
}

function suggestionCard(suggestion) {
  const primaryLabel =
    suggestion.action === 'close' ? 'Close them' : suggestion.action === 'sleep' ? 'Sleep them' : 'Group them';

  return el('article', { class: `card${suggestion.tone === 'warn' ? ' warn' : ''}` }, [
    el('div', { class: 'card-main' }, [
      el('p', { class: 'card-title', text: suggestion.title }),
      el('p', { class: 'card-detail', text: suggestion.detail }),
    ]),
    el('div', { class: 'card-actions' }, [
      el(
        'button',
        {
          class: 'chip',
          type: 'button',
          onclick: () => {
            state.selected = new Set(suggestion.tabIds);
            render();
            setStatus(`Selected ${plural(suggestion.tabIds.length, 'tab')}.`);
          },
        },
        'Show me',
      ),
      el(
        'button',
        { class: 'btn small', type: 'button', onclick: () => applySuggestion(suggestion) },
        primaryLabel,
      ),
    ]),
  ]);
}

function renderList() {
  const list = $('tab-list');
  list.replaceChildren();

  const visible = filterTabs(state.tabs, state.query);
  if (!visible.length) {
    list.append(
      el('p', {
        class: 'empty',
        text: state.query ? 'No tabs match that search.' : 'No tabs open. Enjoy the quiet.',
      }),
    );
    return;
  }

  if (state.sort === 'recent') {
    const sorted = [...visible].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    list.append(el('div', { class: 'site-group' }, sorted.map(tabRow)));
    return;
  }

  for (const group of groupBySite(visible)) {
    const ids = group.tabs.map((tab) => tab.id);
    list.append(
      el('section', { class: 'site-group' }, [
        el('header', { class: 'site-head' }, [
          el('span', { class: 'site-label', text: group.label }),
          el('span', { class: 'count', text: String(group.tabs.length) }),
          el('span', { class: 'grow' }),
          el(
            'button',
            {
              class: 'link-btn',
              type: 'button',
              title: `Sleep all tabs from ${group.label}`,
              onclick: () => sleepIds(ids),
            },
            'Sleep all',
          ),
          el(
            'button',
            {
              class: 'link-btn danger',
              type: 'button',
              title: `Close all tabs from ${group.label}`,
              onclick: () => closeWithConfirm(ids, `Close ${plural(ids.length, 'tab')} from ${group.label}?`),
            },
            'Close all',
          ),
        ]),
        ...group.tabs.map(tabRow),
      ]),
    );
  }
}

function tabRow(tab) {
  const selected = state.selected.has(tab.id);
  const meta = [tab.label];
  if (tab.pinned) meta.push('pinned');
  if (tab.active) meta.push('active');
  if (tab.discarded) meta.push('sleeping');
  if (tab.lastAccessed) meta.push(formatRelative(tab.lastAccessed));

  return el(
    'div',
    {
      class: `row${selected ? ' is-selected' : ''}${tab.discarded ? ' is-sleeping' : ''}`,
      role: 'listitem',
      dataset: { tabId: String(tab.id) },
    },
    [
      el('button', {
        class: 'check',
        type: 'button',
        'aria-pressed': selected ? 'true' : 'false',
        'aria-label': `Select ${truncate(tab.title, 60)}`,
        title: 'Select this tab',
        text: selected ? '✓' : '',
        onclick: (event) => {
          event.stopPropagation();
          toggleSelect(tab.id);
        },
      }),
      favicon(tab),
      el('div', { class: 'row-main', onclick: () => activate(tab) }, [
        el('p', { class: 'row-title', text: truncate(tab.title, 90) }),
        el('p', { class: 'row-meta', text: meta.join(' · ') }),
      ]),
      el(
        'button',
        {
          class: 'row-close',
          type: 'button',
          title: 'Close tab',
          'aria-label': `Close ${truncate(tab.title, 60)}`,
          text: '×',
          onclick: (event) => {
            event.stopPropagation();
            closeDirect([tab.id]);
          },
        },
        [],
      ),
    ],
  );
}

/**
 * Favicons come from Chrome's own cache through the internal _favicon endpoint,
 * so the popup makes no network requests of its own. If that fails (a local file,
 * a browser page) we fall back to the site's first letter.
 */
function favicon(tab) {
  const wrap = el('span', { class: 'favicon', 'aria-hidden': 'true' });
  if (!tab.url || !/^https?:/i.test(tab.url)) {
    wrap.textContent = (tab.label[0] || '?').toUpperCase();
    return wrap;
  }
  const img = el('img', { alt: '', width: '16', height: '16' });
  img.src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`);
  img.addEventListener('error', () => {
    wrap.replaceChildren(document.createTextNode((tab.label[0] || '?').toUpperCase()));
  });
  wrap.append(img);
  return wrap;
}

function renderToolbar() {
  const count = state.selected.size;
  const closeBtn = $('close-selected');
  closeBtn.textContent = count ? `Close ${count}` : 'Close';
  closeBtn.disabled = count === 0 || state.busy;

  const sleepBtn = $('sleep-selected');
  sleepBtn.textContent = count ? `Sleep ${count}` : 'Sleep';
  sleepBtn.disabled = count === 0 || state.busy;

  const saveBtn = $('save-selected');
  saveBtn.textContent = count ? `Save ${count}` : 'Save';
  saveBtn.disabled = count === 0 || state.busy;

  const visible = filterTabs(state.tabs, state.query);
  const allSelected = visible.length > 0 && visible.every((tab) => state.selected.has(tab.id));
  $('select-all').textContent = allSelected ? 'Clear' : 'Select all';
  $('sort-toggle').textContent = state.sort === 'site' ? 'By site' : 'Recent';
}

function renderCollections() {
  $('collections-count').textContent = String(state.collections.length);
  $('collections-toggle').setAttribute('aria-expanded', state.collectionsOpen ? 'true' : 'false');

  const body = $('collections-body');
  body.hidden = !state.collectionsOpen;
  if (!state.collectionsOpen) return;

  body.replaceChildren();
  if (!state.collections.length) {
    body.append(el('p', { class: 'empty', text: 'No saved sessions yet. Select tabs and press Save.' }));
    return;
  }

  for (const collection of state.collections) {
    body.append(
      el('div', { class: 'saved' }, [
        el('div', { class: 'row-main' }, [
          el('p', { class: 'row-title', text: truncate(collection.name, 54) }),
          el('p', {
            class: 'row-meta',
            text: `${plural(collection.tabs.length, 'tab')} · saved ${formatRelative(collection.createdAt)}`,
          }),
        ]),
        el('button', { class: 'btn small', type: 'button', onclick: () => openCollection(collection) }, 'Open'),
        el(
          'button',
          {
            class: 'row-close',
            type: 'button',
            title: 'Forget this session',
            text: '×',
            onclick: () => forgetCollection(collection),
          },
          [],
        ),
      ]),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* status + confirmation                                                     */
/* -------------------------------------------------------------------------- */

function setStatus(text, tone) {
  const status = $('status');
  status.textContent = text || '';
  if (tone) status.dataset.tone = tone;
  else delete status.dataset.tone;
  if (state.statusTimer) clearTimeout(state.statusTimer);
  if (text) {
    state.statusTimer = setTimeout(() => {
      status.textContent = '';
      delete status.dataset.tone;
    }, 7000);
  }
}

function askConfirm(message) {
  if (!state.settings.confirmBulkClose) return Promise.resolve(true);
  return new Promise((resolve) => {
    const bar = $('confirm-bar');
    $('confirm-text').textContent = message;
    bar.hidden = false;
    state.confirmHandler = (answer) => {
      bar.hidden = true;
      state.confirmHandler = null;
      resolve(answer);
    };
  });
}

function settleConfirm(answer) {
  const handler = state.confirmHandler;
  if (handler) handler(answer);
}

/* -------------------------------------------------------------------------- */
/* actions                                                                   */
/* -------------------------------------------------------------------------- */

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

async function activate(tab) {
  try {
    await focusTab(tab);
    window.close();
  } catch (error) {
    logError('Could not focus that tab', error);
    setStatus('Could not switch to that tab.', 'bad');
  }
}

async function closeDirect(ids) {
  const result = await safeClose(ids);
  setStatus(describeResult('Closed', result), result.failed.length ? 'bad' : 'good');
}

async function closeWithConfirm(ids, message) {
  if (!ids.length || state.busy) return;
  const confirmed = ids.length === 1 ? true : await askConfirm(message);
  if (!confirmed) return;
  const result = await safeClose(ids);
  setStatus(describeResult('Closed', result), result.failed.length ? 'bad' : 'good');
}

async function safeClose(ids) {
  state.busy = true;
  renderToolbar();
  try {
    const result = await closeTabIds(ids);
    state.selected.clear();
    await refreshTabs();
    return result;
  } catch (error) {
    logError('Close failed', error);
    return { ok: [], failed: [{ error: String(error?.message || error) }] };
  } finally {
    state.busy = false;
    render();
  }
}

async function sleepIds(ids) {
  if (!ids.length || state.busy) return;
  state.busy = true;
  renderToolbar();
  try {
    const targets = state.tabs.filter((tab) => ids.includes(tab.id));
    const result = await sleepTabs(targets);
    state.selected.clear();
    const parts = [describeResult('Slept', result)];
    if (result.skipped) parts.push(`${result.skipped} left awake`);
    setStatus(parts.join(' · '), result.failed.length ? 'bad' : 'good');
  } catch (error) {
    logError('Sleep failed', error);
    setStatus('Could not sleep those tabs.', 'bad');
  } finally {
    state.busy = false;
    await refreshTabs();
    render();
  }
}

async function applySuggestion(suggestion) {
  if (state.busy) return;
  if (suggestion.action === 'close') {
    await closeWithConfirm(suggestion.tabIds, `Close ${plural(suggestion.tabIds.length, 'duplicate tab')}?`);
    return;
  }
  if (suggestion.action === 'sleep') {
    await sleepIds(suggestion.tabIds);
    return;
  }
  if (suggestion.action === 'group') {
    state.busy = true;
    renderToolbar();
    try {
      const targets = state.tabs.filter((tab) => suggestion.tabIds.includes(tab.id));
      const result = await groupTabsBySite(targets);
      const message = result.groups
        ? `Grouped ${plural(result.groups, 'site')} into tab groups.`
        : 'Nothing to group in this window.';
      setStatus(message, result.failed.length ? 'bad' : 'good');
    } catch (error) {
      logError('Grouping failed', error);
      setStatus('Could not group those tabs.', 'bad');
    } finally {
      state.busy = false;
      await refreshTabs();
      render();
    }
  }
}

async function saveSelection() {
  const chosen = state.tabs.filter((tab) => state.selected.has(tab.id));
  if (!chosen.length) return;

  const labels = new Set(chosen.map((tab) => tab.label));
  const name =
    labels.size === 1
      ? `${chosen[0].label} session`
      : `Mixed session (${plural(chosen.length, 'tab')})`;
  const stamp = new Date().toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  try {
    const saved = await addCollection({ name: `${name} · ${stamp}`, tabs: chosen }, state.settings);
    state.selected.clear();
    await refreshCollections();
    state.collectionsOpen = true;
    render();
    setStatus(`Saved ${plural(saved.tabs.length, 'tab')}. Close them whenever you like.`, 'good');
  } catch (error) {
    logError('Could not save session', error);
    setStatus(error?.message || 'Could not save that session.', 'bad');
  }
}

async function openCollection(collection) {
  try {
    const result = await restoreCollection(collection);
    const extra = result.requested > result.opened ? ` (${result.requested - result.opened} over the 50-tab limit)` : '';
    setStatus(`Opened ${plural(result.opened, 'tab')} in a new window${extra}.`, 'good');
  } catch (error) {
    logError('Could not open session', error);
    setStatus(error?.message || 'Could not open that session.', 'bad');
  }
}

async function forgetCollection(collection) {
  const confirmed = await askConfirm(`Forget “${truncate(collection.name, 40)}”?`);
  if (!confirmed) return;
  try {
    await deleteCollection(collection.id);
    await refreshCollections();
    render();
    setStatus('Session removed.', 'good');
  } catch (error) {
    logError('Could not remove session', error);
    setStatus('Could not remove that session.', 'bad');
  }
}

function describeResult(verb, result) {
  const closed = result.ok?.length ?? 0;
  const failed = result.failed?.length ?? 0;
  if (!closed && !failed) return 'Nothing to do.';
  if (!failed) return `${verb} ${plural(closed, 'tab')}.`;
  return `${verb} ${closed}, ${failed} could not be reached.`;
}

/* -------------------------------------------------------------------------- */
/* wiring                                                                    */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  $('open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  let searchTimer = null;
  $('search').addEventListener('input', (event) => {
    const value = event.target.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = value;
      renderList();
      renderToolbar();
    }, 90);
  });

  $('search').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.target.value = '';
      state.query = '';
      renderList();
      renderToolbar();
    }
  });

  $('sort-toggle').addEventListener('click', () => {
    state.sort = state.sort === 'site' ? 'recent' : 'site';
    renderList();
    renderToolbar();
  });

  $('select-all').addEventListener('click', () => {
    const visible = filterTabs(state.tabs, state.query);
    const allSelected = visible.length > 0 && visible.every((tab) => state.selected.has(tab.id));
    state.selected = allSelected ? new Set() : new Set(visible.map((tab) => tab.id));
    render();
  });

  $('close-selected').addEventListener('click', () => {
    const ids = [...state.selected];
    closeWithConfirm(ids, `Close ${plural(ids.length, 'selected tab')}?`);
  });

  $('sleep-selected').addEventListener('click', () => sleepIds([...state.selected]));
  $('save-selected').addEventListener('click', saveSelection);

  $('collections-toggle').addEventListener('click', () => {
    state.collectionsOpen = !state.collectionsOpen;
    renderCollections();
  });

  $('confirm-yes').addEventListener('click', () => settleConfirm(true));
  $('confirm-no').addEventListener('click', () => settleConfirm(false));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.confirmHandler) settleConfirm(false);
    if (event.key === '/' && document.activeElement !== $('search')) {
      event.preventDefault();
      $('search').focus();
    }
  });
}

async function main() {
  bindEvents();
  state.settings = await getSettings();
  setDebug(state.settings.debug);
  await Promise.all([refreshTabs(), refreshCollections()]);
  render();
  $('search').focus();
}

main().catch((error) => {
  logError('Popup failed to start', error);
  setStatus('Something went wrong loading Mothball Tabs.', 'bad');
});

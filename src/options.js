/**
 * Options page.
 *
 * A backup file is untrusted input: it may have been edited by hand or come from
 * somewhere else entirely. Everything is parsed inside try/catch, then pushed
 * through the same sanitisers used for storage before it can reach a page.
 */

import { formatRelative, plural, truncate, validateSettings } from './lib/core.js';
import {
  clearAll,
  deleteCollection,
  exportAll,
  getCollections,
  getSettings,
  getStats,
  importAll,
  saveSettings,
} from './lib/storage.js';
import { error as logError } from './lib/log.js';

const $ = (id) => document.getElementById(id);

function setStatus(id, text, tone) {
  const node = $(id);
  node.textContent = text || '';
  if (tone) node.dataset.tone = tone;
  else delete node.dataset.tone;
}

async function loadSettings() {
  const settings = await getSettings();
  $('idleDays').value = String(settings.idleDays);
  $('groupThreshold').value = String(settings.groupThreshold);
  $('protectedDomains').value = settings.protectedDomains.join('\n');
  $('protectPinned').checked = settings.protectPinned;
  $('confirmBulkClose').checked = settings.confirmBulkClose;
  $('debug').checked = settings.debug;
  return settings;
}

async function onSubmit(event) {
  event.preventDefault();
  const domains = $('protectedDomains')
    .value.split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  try {
    const saved = await saveSettings(
      validateSettings({
        idleDays: $('idleDays').value,
        groupThreshold: $('groupThreshold').value,
        protectedDomains: domains,
        protectPinned: $('protectPinned').checked,
        confirmBulkClose: $('confirmBulkClose').checked,
        debug: $('debug').checked,
      }),
    );
    // Reflect the values actually stored (numbers may have been clamped).
    $('idleDays').value = String(saved.idleDays);
    $('groupThreshold').value = String(saved.groupThreshold);
    $('protectedDomains').value = saved.protectedDomains.join('\n');
    setStatus('save-status', 'Saved.', 'good');
    setTimeout(() => setStatus('save-status', ''), 3000);
  } catch (error) {
    logError('Could not save settings', error);
    setStatus('save-status', 'Could not save. Check that the values are sensible.', 'bad');
  }
}

async function renderSessions() {
  const [collections, stats] = await Promise.all([getCollections(), getStats()]);
  const container = $('sessions');
  container.replaceChildren();

  const summary = [`${plural(collections.length, 'saved session')}`];
  if (stats.closed || stats.slept) {
    summary.push(`${stats.closed} tabs closed`, `${stats.slept} slept`);
  }
  $('sessions-summary').textContent = summary.join(' · ');

  if (!collections.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nothing saved yet. Select tabs in the popup and press Save.';
    container.append(empty);
    return;
  }

  for (const collection of collections) {
    const row = document.createElement('div');
    row.className = 'session';

    const main = document.createElement('div');
    main.className = 'session-main';

    const name = document.createElement('p');
    name.className = 'session-name';
    name.textContent = truncate(collection.name, 70);

    const meta = document.createElement('p');
    meta.className = 'session-meta';
    meta.textContent = `${plural(collection.tabs.length, 'tab')} · saved ${formatRelative(collection.createdAt)}`;

    main.append(name, meta);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn danger';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete “${truncate(collection.name, 50)}”? This cannot be undone.`)) return;
      try {
        await deleteCollection(collection.id);
        await renderSessions();
        setStatus('data-status', 'Session deleted.', 'good');
      } catch (error) {
        logError('Could not delete session', error);
        setStatus('data-status', 'Could not delete that session.', 'bad');
      }
    });

    row.append(main, remove);
    container.append(row);
  }
}

async function onExport() {
  try {
    const data = await exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mothball-tabs-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setStatus('data-status', 'Backup downloaded.', 'good');
  } catch (error) {
    logError('Export failed', error);
    setStatus('data-status', 'Could not create a backup.', 'bad');
  }
}

async function onImportFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    setStatus('data-status', 'That file is too large to be a Mothball Tabs backup.', 'bad');
    return;
  }

  try {
    const text = await file.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('That file is not valid JSON.');
    }
    const result = await importAll(payload);
    await Promise.all([loadSettings(), renderSessions()]);
    const bits = [`${plural(result.added, 'session')} imported`];
    if (result.skipped) bits.push(`${result.skipped} already present`);
    if (result.invalid) bits.push(`${result.invalid} unusable`);
    setStatus('data-status', `${bits.join(' · ')}.`, 'good');
  } catch (error) {
    logError('Import failed', error);
    setStatus('data-status', error?.message || 'Could not read that backup.', 'bad');
  }
}

async function onReset() {
  const confirmed = window.confirm(
    'Delete every setting and saved session Mothball Tabs has stored? Your open tabs are not affected.',
  );
  if (!confirmed) return;
  try {
    await clearAll();
    await Promise.all([loadSettings(), renderSessions()]);
    setStatus('data-status', 'All Mothball Tabs data deleted.', 'good');
  } catch (error) {
    logError('Reset failed', error);
    setStatus('data-status', 'Could not delete the stored data.', 'bad');
  }
}

async function main() {
  $('settings-form').addEventListener('submit', onSubmit);
  $('export').addEventListener('click', onExport);
  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', onImportFile);
  $('reset').addEventListener('click', onReset);

  await Promise.all([loadSettings(), renderSessions()]);
}

main().catch((error) => {
  logError('Options page failed to start', error);
  setStatus('data-status', 'Something went wrong loading this page.', 'bad');
});

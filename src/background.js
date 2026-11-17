/**
 * Background service worker.
 *
 * Kept intentionally small: it owns the toolbar badge and the keyboard shortcuts,
 * and it recomputes nothing else. All decisions live in lib/core.js. MV3 can stop
 * this worker at any time, so it holds no state beyond one debounce timer.
 */

import { buildSuggestions, computeStats, toTabView } from './lib/core.js';
import { getSettings, saveSettings } from './lib/storage.js';
import { closeDuplicateTabs, saveTabsAsSession, sleepTabs } from './lib/tabActions.js';
import { error as logError, setDebug } from './lib/log.js';

const BADGE_CLEAN = '#475569';
const BADGE_TIDY = '#b45309';
const BADGE_FLASH_MS = 2600;

let badgeTimer = null;
let flashTimer = null;

async function readTabs() {
  const rawTabs = await chrome.tabs.query({});
  return rawTabs.map(toTabView).filter(Boolean);
}

async function updateBadge() {
  try {
    const [tabs, settings] = await Promise.all([readTabs(), getSettings()]);
    setDebug(settings.debug);

    const stats = computeStats(tabs, settings);
    const text = stats.total === 0 ? '' : stats.total > 999 ? '999+' : String(stats.total);
    const hasWork = buildSuggestions(tabs, settings).length > 0;

    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: hasWork ? BADGE_TIDY : BADGE_CLEAN });
    await chrome.action.setTitle({
      title: `Mothball Tabs — ${stats.total} open tab${stats.total === 1 ? '' : 's'}`,
    });
  } catch (error) {
    logError('Could not update the badge', error);
  }
}

function scheduleBadge() {
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    updateBadge();
  }, 500);
}

/** Shows a short message in the badge, then restores the tab count. */
async function flashBadge(text) {
  try {
    if (flashTimer) clearTimeout(flashTimer);
    await chrome.action.setBadgeText({ text });
    flashTimer = setTimeout(() => {
      flashTimer = null;
      updateBadge();
    }, BADGE_FLASH_MS);
  } catch (error) {
    logError('Could not flash the badge', error);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    // Seeds validated defaults on first install and normalises older values.
    await saveSettings({});
  } catch (error) {
    logError('Could not seed settings', error);
  }
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

for (const event of [
  chrome.tabs.onCreated,
  chrome.tabs.onRemoved,
  chrome.tabs.onAttached,
  chrome.tabs.onDetached,
  chrome.tabs.onReplaced,
]) {
  event.addListener(() => scheduleBadge());
}

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.discarded !== undefined || changeInfo.pinned !== undefined) {
    scheduleBadge();
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  try {
    const tabs = await readTabs();
    const settings = await getSettings();
    setDebug(settings.debug);

    if (command === 'close-duplicates') {
      const result = await closeDuplicateTabs(tabs);
      await flashBadge(result.duplicates ? `−${result.ok.length}` : '0');
      return;
    }

    if (command === 'sleep-idle') {
      const suggestion = buildSuggestions(tabs, settings).find((item) => item.kind === 'idle');
      if (!suggestion) {
        await flashBadge('0');
        return;
      }
      const ids = new Set(suggestion.tabIds);
      const result = await sleepTabs(tabs.filter((tab) => ids.has(tab.id)));
      await flashBadge(result.ok.length ? `z${result.ok.length}` : '0');
      return;
    }

    if (command === 'save-window') {
      const current = await chrome.windows.getCurrent();
      const windowTabs = tabs.filter((tab) => tab.windowId === current.id);
      if (!windowTabs.length) {
        await flashBadge('0');
        return;
      }
      await saveTabsAsSession(windowTabs, `Window · ${new Date().toLocaleString()}`, settings);
      await flashBadge('✓');
    }
  } catch (error) {
    logError(`Shortcut "${command}" failed`, error);
    await flashBadge('!');
  }
});

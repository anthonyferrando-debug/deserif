/* Deserif service worker: defaults, badge, keyboard shortcut. */

const DEFAULTS = {
  enabled: true,
  mode: 'all',
  stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  deitalic: true,
  disabledHosts: [],
  slopEnabled: true
};

// Left behind by 1.1, which asked Claude about each image with the person's own
// API key. 1.2 reads Facebook's label instead, so none of this should linger.
const STALE_LOCAL = ['slopKey', 'slopKeyError', 'slopLastError', 'slopApiBase', 'slopCache', 'slopStats'];
const STALE_SYNC = ['slopModel', 'slopThreshold', 'slopBlur'];

// Tabs that were open before an install or update only have the old (or no)
// script until they reload. Put the current scripts in now.
async function injectIntoOpenTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (e) { return; }
  for (const t of tabs) {
    if (t.id == null || !t.url || !/^https?:/i.test(t.url)) continue;
    try { await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['content.js'] }); } catch (e) { /* chrome pages, the store, etc. */ }
    if (/^https?:\/\/([^/]+\.)?facebook\.com\//i.test(t.url)) {
      try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['slop.js'] }); } catch (e) { /* ignore */ }
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  injectIntoOpenTabs();
  chrome.storage.sync.get(DEFAULTS, items => {
    const missing = {};
    for (const k of Object.keys(DEFAULTS)) if (items[k] === undefined) missing[k] = DEFAULTS[k];
    if (Object.keys(missing).length) chrome.storage.sync.set(missing);
  });
  chrome.storage.local.remove(STALE_LOCAL).catch(() => {});
  chrome.storage.sync.remove(STALE_SYNC).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#111111' });
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
});

// Badge: number of hidden AI images (red) when there are any, otherwise the
// number of replaced serif families (black).
const tabState = new Map();

function setTab(tabId, patch) {
  const t = Object.assign(tabState.get(tabId) || { families: 0, slop: 0 }, patch);
  tabState.set(tabId, t);
  const red = t.slop > 0;
  chrome.action.setBadgeBackgroundColor({ tabId, color: red ? '#e10600' : '#111111' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: red ? String(t.slop) : (t.families > 0 ? String(t.families) : '') }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'loading') return;
  tabState.delete(tabId);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => tabState.delete(tabId));

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== 'string' || !sender.tab) return;
  const tabId = sender.tab.id;
  if (msg.type === 'stats' && sender.frameId === 0) setTab(tabId, { families: msg.active && msg.families > 0 ? msg.families : 0 });
  else if (msg.type === 'slop:stats') setTab(tabId, { slop: msg.blocked | 0 });
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-site') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;
  let host;
  try { host = new URL(tab.url).hostname; } catch (e) { return; }
  if (!host) return;
  const { disabledHosts = [] } = await chrome.storage.sync.get({ disabledHosts: [] });
  const next = disabledHosts.includes(host)
    ? disabledHosts.filter(h => h !== host)
    : disabledHosts.concat(host);
  await chrome.storage.sync.set({ disabledHosts: next });
});

/* Deserif service worker: defaults, badge, keyboard shortcut. */

const DEFAULTS = {
  enabled: true,
  mode: 'all',
  stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  deitalic: true,
  disabledHosts: []
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULTS, items => {
    const missing = {};
    for (const k of Object.keys(DEFAULTS)) if (items[k] === undefined) missing[k] = DEFAULTS[k];
    if (Object.keys(missing).length) chrome.storage.sync.set(missing);
  });
  chrome.action.setBadgeBackgroundColor({ color: '#111111' });
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'stats' || !sender.tab || sender.frameId !== 0) return;
  const text = msg.active && msg.families > 0 ? String(msg.families) : '';
  chrome.action.setBadgeText({ tabId: sender.tab.id, text }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
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

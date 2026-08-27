/* Deserif popup */
(() => {
  'use strict';

  const PRESETS = {
    helvetica: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    inter: 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif',
    arial: 'Arial, Helvetica, sans-serif'
  };
  const DEFAULTS = {
    enabled: true, mode: 'all', stack: PRESETS.helvetica, deitalic: true, disabledHosts: [],
    slopEnabled: true, slopModel: 'claude-opus-5', slopThreshold: 60, slopBlur: true
  };
  const LOCAL = { slopKey: '', slopKeyError: '', slopLastError: null, slopStats: { checked: 0, blocked: 0 } };

  const $ = id => document.getElementById(id);
  const els = {
    enabled: $('enabled'), siteOn: $('siteOn'), host: $('host'), fonts: $('fonts'), fontsEmpty: $('fontsEmpty'),
    mode: $('mode'), preset: $('preset'), custom: $('custom'), deitalic: $('deitalic'), rescan: $('rescan'),
    version: $('version'),
    slopEnabled: $('slopEnabled'), slopBody: $('slopBody'), slopPage: $('slopPage'), slopPageBtns: $('slopPageBtns'),
    slopShowAll: $('slopShowAll'), slopHideAll: $('slopHideAll'), slopRecheck: $('slopRecheck'),
    slopKey: $('slopKey'), slopTest: $('slopTest'), slopKeyMsg: $('slopKeyMsg'), slopModel: $('slopModel'),
    slopThreshold: $('slopThreshold'), slopBlur: $('slopBlur'), slopTotals: $('slopTotals')
  };

  let settings = Object.assign({}, DEFAULTS);
  let local = Object.assign({}, LOCAL);
  let tab = null;
  let host = '';
  let slopPage = null;   // stats from slop.js on this tab
  let testMsg = null;    // result of the last "Test" click

  try { els.version.textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) { /* ignore */ }

  function getSettings() {
    return new Promise(r => chrome.storage.sync.get(DEFAULTS, items => r(Object.assign({}, DEFAULTS, items))));
  }
  function getLocal() {
    return new Promise(r => chrome.storage.local.get(LOCAL, items => r(Object.assign({}, LOCAL, items))));
  }

  function save(patch) {
    Object.assign(settings, patch);
    return chrome.storage.sync.set(patch);
  }
  function saveLocal(patch) {
    Object.assign(local, patch);
    return chrome.storage.local.set(patch);
  }

  function presetFor(stack) {
    for (const k of Object.keys(PRESETS)) if (PRESETS[k] === stack) return k;
    return 'custom';
  }

  function sanitizeStack(s) {
    return s.replace(/[;{}<>]/g, '').trim();
  }

  function isFacebook() { return /(^|\.)facebook\.com$/i.test(host); }

  function render() {
    els.enabled.checked = !!settings.enabled;
    document.body.classList.toggle('off', !settings.enabled);
    const siteDisabled = host && (settings.disabledHosts || []).includes(host);
    els.siteOn.checked = !!host && !siteDisabled;
    els.siteOn.disabled = !host || !settings.enabled;
    els.host.textContent = host || 'this page';
    for (const b of els.mode.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === settings.mode);
    const p = presetFor(settings.stack);
    els.preset.value = p;
    els.custom.hidden = p !== 'custom';
    if (p === 'custom') els.custom.value = settings.stack;
    els.deitalic.checked = !!settings.deitalic;
    renderSlop();
  }

  function renderSlop() {
    els.slopEnabled.checked = !!settings.slopEnabled;
    els.slopBody.classList.toggle('dim', !settings.slopEnabled);
    els.slopModel.value = settings.slopModel;
    els.slopThreshold.value = String(settings.slopThreshold);
    els.slopBlur.checked = !!settings.slopBlur;
    if (document.activeElement !== els.slopKey) els.slopKey.value = local.slopKey || '';

    let m, cls = 'muted small';
    if (!local.slopKey) m = 'Paste an Anthropic API key to turn this on. It stays in this browser and only goes to api.anthropic.com.';
    else if (local.slopKeyError) { m = 'Key rejected: ' + local.slopKeyError; cls = 'small err'; }
    else if (local.slopLastError && local.slopLastError.message) { m = 'Last error: ' + local.slopLastError.message; cls = 'small err'; }
    else m = 'Key saved. Each new image costs a fraction of a cent; verdicts are cached.';
    if (testMsg) { m = testMsg.text; cls = testMsg.ok ? 'small ok' : 'small err'; }
    els.slopKeyMsg.textContent = m;
    els.slopKeyMsg.className = cls;

    let page = 'Runs on facebook.com.';
    let buttons = false;
    if (isFacebook()) {
      if (!slopPage) page = 'Reload this Facebook tab to start checking images.';
      else if (!slopPage.active) page = 'Off for this site.';
      else if (slopPage.paused && slopPage.reason === 'nokey') page = 'Waiting for an API key.';
      else if (slopPage.paused && slopPage.reason === 'badkey') page = 'Paused: the API key was rejected.';
      else {
        page = 'Hidden ' + slopPage.blocked + ' on this page';
        if (slopPage.shown) page += ', ' + slopPage.shown + ' shown';
        if (slopPage.pending) page += ', ' + slopPage.pending + ' checking';
        page += ' (' + slopPage.checked + ' checked).';
        buttons = true;
      }
    }
    els.slopPage.textContent = page;
    els.slopPageBtns.hidden = !buttons;
    const t = local.slopStats || LOCAL.slopStats;
    els.slopTotals.textContent = (t.blocked | 0) + ' hidden and ' + (t.checked | 0) + ' checked in total.';
  }

  function renderFonts(stats) {
    els.fonts.innerHTML = '';
    if (!stats) {
      els.fontsEmpty.textContent = 'No access to this page. Chrome pages and the Web Store are off limits; a tab opened before install needs a reload.';
      return;
    }
    if (stats.ready === false) { els.fontsEmpty.textContent = 'Page still loading. Open again in a second.'; return; }
    if (!stats.families.length) {
      els.fontsEmpty.textContent = settings.mode === 'ai' ? 'None of the AI favorites here.' : 'No serif fonts on this page.';
      return;
    }
    els.fontsEmpty.textContent = stats.active ? '' : 'Detected but left alone (off for this site).';
    for (const f of stats.families) {
      const li = document.createElement('li');
      const name = document.createElement('span'); name.className = 'name'; name.textContent = f.name; name.title = f.name;
      li.appendChild(name);
      if (f.ai) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'AI favorite'; li.appendChild(t); }
      const c = document.createElement('span'); c.className = 'count'; c.textContent = f.count === 1 ? '1 element' : f.count + ' elements';
      li.appendChild(c);
      els.fonts.appendChild(li);
    }
  }

  function askTab(type) {
    return new Promise(resolve => {
      if (!tab || tab.id == null) return resolve(null);
      try {
        chrome.tabs.sendMessage(tab.id, { type }, { frameId: 0 }, resp => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(resp || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  function askWorker(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, resp => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(resp || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  async function refresh() {
    renderFonts(await askTab('refresh'));
  }

  async function refreshSlop(type) {
    if (isFacebook()) slopPage = await askTab(type || 'slop:getStats');
    local = await getLocal();
    renderSlop();
  }

  async function init() {
    settings = await getSettings();
    local = await getLocal();
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) host = new URL(tab.url).hostname;
    } catch (e) { /* ignore */ }
    render();
    renderFonts(await askTab('getStats'));
    refreshSlop();
    if (isFacebook()) setInterval(() => refreshSlop(), 2000);

    els.enabled.addEventListener('change', async () => { await save({ enabled: els.enabled.checked }); render(); refresh(); });

    els.siteOn.addEventListener('change', async () => {
      if (!host) return;
      const list = (settings.disabledHosts || []).filter(h => h !== host);
      if (!els.siteOn.checked) list.push(host);
      await save({ disabledHosts: list });
      render(); refresh();
    });

    els.mode.addEventListener('click', async e => {
      const b = e.target.closest('button[data-mode]');
      if (!b) return;
      await save({ mode: b.dataset.mode });
      render(); refresh();
    });

    els.preset.addEventListener('change', async () => {
      const v = els.preset.value;
      if (v === 'custom') {
        els.custom.hidden = false;
        els.custom.value = settings.stack;
        els.custom.focus();
        return;
      }
      await save({ stack: PRESETS[v] });
      render(); refresh();
    });

    let customTimer = 0;
    els.custom.addEventListener('input', () => {
      clearTimeout(customTimer);
      customTimer = setTimeout(async () => {
        const v = sanitizeStack(els.custom.value);
        if (!v) return;
        await save({ stack: v });
        refresh();
      }, 400);
    });

    els.deitalic.addEventListener('change', async () => { await save({ deitalic: els.deitalic.checked }); refresh(); });

    els.rescan.addEventListener('click', refresh);

    /* AI slop */
    els.slopEnabled.addEventListener('change', async () => {
      await save({ slopEnabled: els.slopEnabled.checked });
      renderSlop();
      setTimeout(() => refreshSlop(), 300);
    });

    let keyTimer = 0;
    const saveKey = async () => {
      const v = els.slopKey.value.trim();
      if (v === (local.slopKey || '')) return;
      testMsg = null;
      await saveLocal({ slopKey: v, slopKeyError: '', slopLastError: null });
      renderSlop();
      setTimeout(() => refreshSlop(), 500);
    };
    els.slopKey.addEventListener('input', () => { clearTimeout(keyTimer); keyTimer = setTimeout(saveKey, 500); });
    els.slopKey.addEventListener('change', () => { clearTimeout(keyTimer); saveKey(); });

    els.slopTest.addEventListener('click', async () => {
      clearTimeout(keyTimer);
      await saveKey();
      els.slopTest.disabled = true;
      els.slopTest.textContent = 'Testing';
      const resp = await askWorker({ type: 'slop:test' });
      els.slopTest.disabled = false;
      els.slopTest.textContent = 'Test';
      if (!resp) testMsg = { ok: false, text: 'No answer from the extension. Try reloading it.' };
      else if (resp.ok) testMsg = { ok: true, text: 'Key works. ' + resp.model + ' answered.' };
      else testMsg = { ok: false, text: resp.error || 'Test failed.' };
      await refreshSlop('slop:recheck');
    });

    els.slopModel.addEventListener('change', async () => { testMsg = null; await save({ slopModel: els.slopModel.value }); renderSlop(); });
    els.slopThreshold.addEventListener('change', async () => { await save({ slopThreshold: +els.slopThreshold.value }); setTimeout(() => refreshSlop(), 300); });
    els.slopBlur.addEventListener('change', async () => { await save({ slopBlur: els.slopBlur.checked }); });

    els.slopShowAll.addEventListener('click', () => refreshSlop('slop:showAll'));
    els.slopHideAll.addEventListener('click', () => refreshSlop('slop:hideAll'));
    els.slopRecheck.addEventListener('click', () => refreshSlop('slop:recheck'));
  }

  init();
})();

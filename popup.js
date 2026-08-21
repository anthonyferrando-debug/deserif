/* Deserif popup */
(() => {
  'use strict';

  const PRESETS = {
    helvetica: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    inter: 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif',
    arial: 'Arial, Helvetica, sans-serif'
  };
  const DEFAULTS = { enabled: true, mode: 'all', stack: PRESETS.helvetica, deitalic: true, disabledHosts: [] };

  const $ = id => document.getElementById(id);
  const els = {
    enabled: $('enabled'), siteOn: $('siteOn'), host: $('host'), fonts: $('fonts'), fontsEmpty: $('fontsEmpty'),
    mode: $('mode'), preset: $('preset'), custom: $('custom'), deitalic: $('deitalic'), rescan: $('rescan'),
    version: $('version')
  };

  let settings = Object.assign({}, DEFAULTS);
  let tab = null;
  let host = '';

  try { els.version.textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) { /* ignore */ }

  function getSettings() {
    return new Promise(r => chrome.storage.sync.get(DEFAULTS, items => r(Object.assign({}, DEFAULTS, items))));
  }

  function save(patch) {
    Object.assign(settings, patch);
    return chrome.storage.sync.set(patch);
  }

  function presetFor(stack) {
    for (const k of Object.keys(PRESETS)) if (PRESETS[k] === stack) return k;
    return 'custom';
  }

  function sanitizeStack(s) {
    return s.replace(/[;{}<>]/g, '').trim();
  }

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

  async function refresh() {
    renderFonts(await askTab('refresh'));
  }

  async function init() {
    settings = await getSettings();
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) host = new URL(tab.url).hostname;
    } catch (e) { /* ignore */ }
    render();
    renderFonts(await askTab('getStats'));

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
  }

  init();
})();

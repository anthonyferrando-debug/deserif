/* Deserif service worker: defaults, badge, keyboard shortcut, and the
 * classifier behind the Facebook AI-slop blocker (slop.js). */

const DEFAULTS = {
  enabled: true,
  mode: 'all',
  stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  deitalic: true,
  disabledHosts: [],
  slopEnabled: true,
  slopModel: 'claude-opus-5',
  slopThreshold: 60,
  slopBlur: true
};

const SLOP = {
  api: 'https://api.anthropic.com',
  maxSide: 768,        // longest side sent to the model; keeps an image under ~800 tokens
  jpegQuality: 0.85,
  concurrency: 3,
  cacheMax: 3000,      // verdicts kept in chrome.storage.local
  fetchTimeout: 15000,
  apiTimeout: 45000,
  models: {
    'claude-opus-5':    { effort: true,  fallbacks: true },
    'claude-sonnet-5':  { effort: true,  fallbacks: false },
    'claude-haiku-4-5': { effort: false, fallbacks: false }
  }
};

const SYSTEM = [
  'You classify images from a Facebook feed for a browser extension that hides AI slop. Slop means the image itself was produced by an AI image generator (ChatGPT/DALL-E, Midjourney, Gemini/Imagen, Stable Diffusion, Flux, Grok and similar).',
  '',
  'slop=true when the picture was made by an AI image model. Typical cases:',
  '- AI "infographics", explainer cards and posters: dense pseudo-corporate layouts, gold or neon lettering on dark navy, rows of glossy icons, decorative charts, tabloid headlines ("BUT WHAT HAPPENS TO..."), misspelled, merged or melted letters, invented logos.',
  '- AI illustrations and 3D renders with the plastic, over-lit, over-detailed look; AI "photos" with impossible lighting, warped hands, teeth, jewelry, text or backgrounds.',
  '- AI memes, motivational quote cards, cartoon caricatures of real people, product mockups, "before and after" graphics, and thumbnails that were generated rather than shot.',
  '',
  'slop=false for anything a person or a real camera made, however ugly or low quality:',
  '- Real photographs and selfies, phone screenshots (texts, tweets, apps, news articles, comment threads), scanned documents, real charts and tables with correct text, logos, product photos, event flyers made in Canva or by a designer with correct text, hand-drawn art, video thumbnails of real footage, and memes built from real photos or well-known templates.',
  '',
  'Text from real design tools is crisp and correct; AI text tends to be inconsistent, misspelled or subtly malformed, and AI layouts pile on icons, gradients and ornaments. Judge how the image was made, not its topic or politics. When the evidence is mixed, answer slop=false with lower confidence.',
  '',
  'Respond with one line of JSON and nothing else:',
  '{"slop": true|false, "confidence": <0-100, how sure you are of that verdict>, "reason": "<at most 12 words>"}'
].join('\n');

/* ------------------------------------------------------------------ */
/* Defaults, badge, shortcut                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULTS, items => {
    const missing = {};
    for (const k of Object.keys(DEFAULTS)) if (items[k] === undefined) missing[k] = DEFAULTS[k];
    if (Object.keys(missing).length) chrome.storage.sync.set(missing);
  });
  chrome.action.setBadgeBackgroundColor({ color: '#111111' });
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
});

// Badge: number of hidden slop images (red) when there are any, otherwise the
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

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  const tabId = sender.tab ? sender.tab.id : null;
  switch (msg.type) {
    case 'stats':
      if (tabId != null && sender.frameId === 0) setTab(tabId, { families: msg.active && msg.families > 0 ? msg.families : 0 });
      return;
    case 'slop:stats':
      if (tabId != null) setTab(tabId, { slop: msg.blocked | 0 });
      return;
    case 'slop:status':
      slopStatus().then(sendResponse);
      return true;
    case 'slop:classify':
      slopClassify(msg).then(sendResponse, e => sendResponse({ state: 'error', error: errText(e) }));
      return true;
    case 'slop:test':
      slopTest().then(sendResponse, e => sendResponse({ ok: false, error: errText(e) }));
      return true;
    case 'slop:clearCache':
      slopClearCache().then(() => sendResponse({ ok: true }));
      return true;
  }
});

/* ------------------------------------------------------------------ */
/* Slop classifier                                                     */
/* ------------------------------------------------------------------ */

let cacheReady = null;   // Promise<Map<path, {s, c, t}>>
let cache = null;
let stats = null;        // { checked, blocked }
let saveTimer = 0;
let backoffUntil = 0;
let fallbacksBroken = false;   // set if the API rejects the fallbacks beta; then we go without
let lastErrorNoted = false;
const inflight = new Map();
let running = 0;
const waiting = [];

function errText(e) { return String((e && e.message) || e); }

function specFor(model) { return SLOP.models[model] || SLOP.models[DEFAULTS.slopModel]; }

function cacheKey(url) {
  try { return new URL(url).pathname; } catch (e) { return ''; }
}

function loadCache() {
  if (!cacheReady) {
    cacheReady = chrome.storage.local.get({ slopCache: {}, slopStats: { checked: 0, blocked: 0 } }).then(items => {
      cache = new Map(Object.entries(items.slopCache).map(([k, v]) => [k, { s: v[0], c: v[1], t: v[2] }]));
      stats = items.slopStats;
      return cache;
    });
  }
  return cacheReady;
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    if (cache.size > SLOP.cacheMax) {
      const byAge = [...cache.entries()].sort((a, b) => a[1].t - b[1].t);
      for (const [k] of byAge.slice(0, cache.size - SLOP.cacheMax)) cache.delete(k);
    }
    const obj = {};
    for (const [k, v] of cache) obj[k] = [v.s, v.c, v.t];
    chrome.storage.local.set({ slopCache: obj, slopStats: stats }).catch(() => {});
  }, 1000);
}

async function slopClearCache() {
  await loadCache();
  cache.clear();
  await chrome.storage.local.remove('slopCache');
}

async function slopStatus() {
  const local = await chrome.storage.local.get({ slopKey: '', slopKeyError: '' });
  return { hasKey: !!local.slopKey, bad: !!local.slopKeyError, error: local.slopKeyError };
}

function slot() {
  return new Promise(resolve => {
    if (running < SLOP.concurrency) { running++; resolve(); } else waiting.push(resolve);
  });
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running--;
}

async function slopClassify(msg) {
  const key = cacheKey(msg.url);
  if (!key) return { state: 'skip' };
  await loadCache();
  const hit = cache.get(key);
  if (hit) {
    hit.t = Date.now();
    return { state: 'done', slop: hit.s === 1, confidence: hit.c, cached: true };
  }
  const local = await chrome.storage.local.get({ slopKey: '', slopKeyError: '', slopApiBase: '' });
  if (!local.slopKey) return { state: 'nokey' };
  if (local.slopKeyError) return { state: 'badkey', error: local.slopKeyError };
  if (Date.now() < backoffUntil) return { state: 'busy' };
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    await slot();
    try {
      if (Date.now() < backoffUntil) return { state: 'busy' };
      const { slopModel } = await chrome.storage.sync.get({ slopModel: DEFAULTS.slopModel });
      const verdict = await classifyRemote(msg, local, slopModel);
      if (verdict.state === 'done') {
        cache.set(key, { s: verdict.slop ? 1 : 0, c: verdict.confidence, t: Date.now() });
        stats.checked++;
        if (verdict.slop && verdict.confidence >= 60) stats.blocked++;
        saveSoon();
      }
      return verdict;
    } finally {
      release();
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

async function classifyRemote(msg, local, model) {
  const spec = specFor(model);
  let image;
  try { image = await fetchAsJpeg(msg.url); }
  catch (e) { return { state: 'error', error: 'image: ' + errText(e) }; }
  if (!image) return { state: 'skip' };

  const body = {
    model,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
        { type: 'text', text: userText(msg.alt) }
      ]
    }]
  };
  if (spec.effort) body.output_config = { effort: 'low' };

  const r = await request(local, body, spec);
  if (r.status === 200) {
    const j = r.json || {};
    if (j.stop_reason === 'refusal') return { state: 'done', slop: false, confidence: 0, reason: 'refusal' };
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const v = parseVerdict(text);
    if (!v) { await noteError('Could not read the answer: ' + text.slice(0, 120)); return { state: 'error' }; }
    if (lastErrorNoted) { lastErrorNoted = false; chrome.storage.local.set({ slopLastError: null }).catch(() => {}); }
    return Object.assign({ state: 'done' }, v);
  }
  const err = apiError(r);
  if (r.status === 401 || r.status === 403) {
    await chrome.storage.local.set({ slopKeyError: err });
    return { state: 'badkey', error: err };
  }
  if (r.status === 429) backoffUntil = Date.now() + 30000;
  else if (r.status >= 500 || r.status === 0) backoffUntil = Date.now() + 15000;
  await noteError(err);
  return { state: r.status === 429 || r.status >= 500 ? 'busy' : 'error', error: err };
}

function userText(alt) {
  let t = 'Is this image from a Facebook feed AI-generated slop?';
  const a = (alt || '').replace(/\s+/g, ' ').trim();
  if (a) t += ' Facebook\'s own alt text for it: "' + a + '".';
  return t + ' Answer with the JSON line only.';
}

function parseVerdict(text) {
  const s = /"slop"\s*:\s*(true|false)/i.exec(text);
  if (!s) return null;
  const c = /"confidence"\s*:\s*(\d{1,3})/.exec(text);
  const r = /"reason"\s*:\s*"([^"]{0,200})/.exec(text);
  return { slop: s[1].toLowerCase() === 'true', confidence: c ? Math.min(100, +c[1]) : 70, reason: r ? r[1] : '' };
}

async function noteError(message) {
  lastErrorNoted = true;
  await chrome.storage.local.set({ slopLastError: { message, at: Date.now() } });
}

// Sends the request; if the API rejects the fallbacks beta, retries once without it.
async function request(local, body, spec) {
  const useFallbacks = spec.fallbacks && !fallbacksBroken;
  let r = await apiPost(local, body, useFallbacks);
  if (r.status === 400 && useFallbacks && /fallback/i.test(r.text)) {
    fallbacksBroken = true;
    r = await apiPost(local, body, false);
  }
  return r;
}

async function apiPost(local, body, withFallbacks) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': local.slopKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  const payload = Object.assign({}, body);
  if (withFallbacks) {
    payload.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SLOP.apiTimeout);
  try {
    const res = await fetch((local.slopApiBase || SLOP.api) + '/v1/messages', {
      method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: errText(e) };
  } finally {
    clearTimeout(t);
  }
}

function apiError(r) {
  if (r.status === 0) return 'Network error: ' + r.text;
  const m = r.json && r.json.error && r.json.error.message;
  return 'HTTP ' + r.status + (m ? ': ' + m : '');
}

// Popup "Test" button: a tiny text request that validates the key and the
// request shape for the chosen model.
async function slopTest() {
  const local = await chrome.storage.local.get({ slopKey: '', slopApiBase: '' });
  if (!local.slopKey) return { ok: false, error: 'No key saved.' };
  const { slopModel } = await chrome.storage.sync.get({ slopModel: DEFAULTS.slopModel });
  const spec = specFor(slopModel);
  const body = { model: slopModel, max_tokens: 32, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] };
  if (spec.effort) body.output_config = { effort: 'low' };
  const r = await request(local, body, spec);
  if (r.status === 200) {
    await chrome.storage.local.set({ slopKeyError: '', slopLastError: null });
    lastErrorNoted = false;
    backoffUntil = 0;
    return { ok: true, model: (r.json && r.json.model) || slopModel };
  }
  const err = apiError(r);
  if (r.status === 401 || r.status === 403) await chrome.storage.local.set({ slopKeyError: err });
  return { ok: false, error: err };
}

async function fetchAsJpeg(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SLOP.fetchTimeout);
  let blob;
  try {
    const r = await fetch(url, { signal: ctrl.signal, credentials: 'omit', cache: 'force-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ct = r.headers.get('content-type') || '';
    if (ct && !/^image\//i.test(ct)) throw new Error('not an image (' + ct + ')');
    if (/svg/i.test(ct)) return null;
    blob = await r.blob();
  } finally {
    clearTimeout(t);
  }
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, SLOP.maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);   // flatten transparency (stickers, PNG cut-outs)
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: SLOP.jpegQuality });
  return base64(await out.arrayBuffer());
}

function base64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

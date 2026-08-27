#!/usr/bin/env python3
"""Steers headless Chromium over CDP for the slop test and checks the results.
Usage: drive.py CDP_PORT API_PORT HERE"""
import base64, json, sys, time, urllib.request
import websocket

cdp_port, api_port, here = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
BASE = 'http://127.0.0.1:%d' % cdp_port

def http(path, method='GET'):
    req = urllib.request.Request(BASE + path, method=method)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)

class Page:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, suppress_origin=True, timeout=60)
        self.n = 0
    def call(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({'id': self.n, 'method': method, 'params': params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get('id') == self.n:
                if 'error' in m:
                    raise RuntimeError('%s: %s' % (method, m['error']))
                return m.get('result', {})
    def eval(self, expr, aw=False):
        r = self.call('Runtime.evaluate', expression=expr, awaitPromise=aw, returnByValue=True)
        if 'exceptionDetails' in r:
            ex = r['exceptionDetails']
            raise RuntimeError('%s %s' % (ex.get('text', ''), ex.get('exception', {}).get('description', '')))
        return r.get('result', {}).get('value')

def new_tab(url):
    return Page(http('/json/new?' + url, 'PUT')['webSocketDebuggerUrl'])

fails = []
def check(cond, msg):
    print(('ok    ' if cond else 'FAIL  ') + msg)
    if not cond:
        fails.append(msg)

# 1. the extension's service worker tells us the extension id
for _ in range(100):
    sw = [t for t in http('/json/list') if t['type'] == 'service_worker' and t['url'].startswith('chrome-extension://')]
    if sw:
        break
    time.sleep(0.2)
else:
    sys.exit('FAIL: extension service worker never appeared')
ext = sw[0]['url'].split('/')[2]

# 2. seed settings through the popup page (it has chrome.storage)
popup = new_tab('chrome-extension://%s/popup.html' % ext)
time.sleep(0.5)
popup.eval("new Promise(r => chrome.storage.local.set({slopKey: 'test-key', slopApiBase: 'http://127.0.0.1:%d', slopKeyError: '', slopLastError: null}, "
           "() => chrome.storage.sync.set({slopEnabled: true, slopBlur: true, slopModel: 'claude-opus-5', slopThreshold: 60}, r)))" % api_port, aw=True)
check(popup.eval("new Promise(r => chrome.storage.local.get('slopKey', v => r(v.slopKey)))", aw=True) == 'test-key', 'settings seeded through the popup')

# 3. the fake feed
STATE = """(() => {
  const o = {};
  for (const img of document.querySelectorAll('img[id]')) {
    const r = img.getBoundingClientRect();
    o[img.id] = { st: img.getAttribute('data-deserif-slop'), src: (img.getAttribute('src') || '').slice(0, 40),
                  w: Math.round(r.width), h: Math.round(r.height), title: img.getAttribute('title') || '' };
  }
  o.__hash = location.hash; o.__sizes = window.__sizes || {};
  return o;
})()"""
EXPECT = {
    'p_poster': 'blocked', 'p_info': 'blocked', 'p_effect': 'blocked', 'p_dup': 'blocked',
    'p_lazy': 'blocked', 'p_recycle': 'blocked',
    'p_head': 'ok', 'p_shot': 'ok', 'p_blog': 'ok',
    'p_avatar': None, 'p_emoji': None, 'p_rsrc': None, 'p_offsite': None,
}
def state():
    return page.eval(STATE)
def wait_ready():
    for _ in range(100):
        try:
            if page.eval("document.readyState === 'complete' && !!document.documentElement && location.host === 'www.facebook.com'"):
                return
        except RuntimeError:
            pass
        time.sleep(0.2)
    sys.exit('FAIL: fake feed never loaded')

def sweep():
    # read the feed the way a person does: scroll to the bottom in steps, stay there
    height = page.eval('(document.documentElement || {}).scrollHeight || 0')
    for y in range(0, height + 600, 600):
        page.eval('window.scrollTo(0, %d)' % y)
        time.sleep(0.15)

def wait_settled(seconds=45, min_age=6):
    t0 = time.time()
    last = 0
    while time.time() - t0 < seconds:
        if time.time() - last > 2:
            sweep()
            last = time.time()
        st = state()
        pending = [k for k, v in st.items() if isinstance(v, dict) and v.get('st') == 'pending']
        if time.time() - t0 >= min_age and all(k in st for k in EXPECT) and not pending:
            return st
        time.sleep(0.5)
    return state()

page = new_tab('https://www.facebook.com/index.html')
page.call('Page.enable')
wait_ready()
st = wait_settled()
for k, exp in EXPECT.items():
    got = st.get(k, {}).get('st')
    check(got == exp, '%-10s expected %-8s got %s' % (k, exp, got))
for k in ('p_poster', 'p_info', 'p_dup', 'p_lazy'):
    before = st['__sizes'].get(k)
    now = [st[k]['w'], st[k]['h']]
    check(before is not None and abs(before[0] - now[0]) <= 1 and abs(before[1] - now[1]) <= 1, '%-10s keeps its box %s -> %s' % (k, before, now))
check(st['p_poster']['src'].startswith('data:image/svg+xml'), 'blocked image src is the transparent SVG')
check('Click to show' in st['p_poster']['title'], 'blocked image has the tooltip')

shot = page.call('Page.captureScreenshot', format='png')
open(here + '/shot-blocked.png', 'wb').write(base64.b64decode(shot['data']))

# 4. a real click on the blocked image shows it and does not follow the link
page.eval("document.getElementById('p_poster').scrollIntoView({block: 'center'})")
time.sleep(0.3)
pt = page.eval("(() => { const r = document.getElementById('p_poster').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()")
page.call('Input.dispatchMouseEvent', type='mouseMoved', x=pt['x'], y=pt['y'])
page.call('Input.dispatchMouseEvent', type='mousePressed', x=pt['x'], y=pt['y'], button='left', clickCount=1)
page.call('Input.dispatchMouseEvent', type='mouseReleased', x=pt['x'], y=pt['y'], button='left', clickCount=1)
time.sleep(0.5)
st = state()
check(st['p_poster']['st'] == 'shown', 'click reveals the image (state %s)' % st['p_poster']['st'])
check(st['p_poster']['src'].startswith('https://scontent'), 'original src restored')
check(st['__hash'] == '', 'the wrapping link was not followed (hash %r)' % st['__hash'])
shot = page.call('Page.captureScreenshot', format='png')
open(here + '/shot-revealed.png', 'wb').write(base64.b64decode(shot['data']))

# 5. popup messages: stats, hide again
TAB = "chrome.tabs.query({url: 'https://www.facebook.com/*'}).then(ts => chrome.tabs.sendMessage(ts[0].id, {type: '%s'}, {frameId: 0}))"
s = popup.eval(TAB % 'slop:getStats', aw=True)
check(s and s['blocked'] == 5 and s['shown'] == 1 and s['active'] and not s['paused'], 'popup stats %s' % json.dumps(s))
s = popup.eval(TAB % 'slop:hideAll', aw=True)
time.sleep(0.3)
check(state()['p_poster']['st'] == 'blocked', 'hide again re-blocks the shown image')

# 6. threshold change re-evaluates cached verdicts without new requests
lines_before = sum(1 for _ in open(here + '/api.log'))
popup.eval("chrome.storage.sync.set({slopThreshold: 40})", aw=True)
time.sleep(0.8)
check(state()['p_blog']['st'] == 'blocked', 'threshold 40 hides the 45%-confidence image')
popup.eval("chrome.storage.sync.set({slopThreshold: 60})", aw=True)
time.sleep(0.8)
check(state()['p_blog']['st'] == 'ok', 'threshold 60 shows it again')
check(sum(1 for _ in open(here + '/api.log')) == lines_before, 'no new API calls for the threshold change')

# 7. switching the feature off restores everything; on again uses the cache
popup.eval("chrome.storage.sync.set({slopEnabled: false})", aw=True)
time.sleep(0.8)
st = state()
check(all(st[k]['st'] is None for k in EXPECT), 'off: every attribute removed')
check(st['p_poster']['src'].startswith('https://scontent'), 'off: blocked images restored')
popup.eval("chrome.storage.sync.set({slopEnabled: true})", aw=True)
st = wait_settled(seconds=20, min_age=2)
check(st['p_poster']['st'] == 'blocked' and st['p_lazy']['st'] == 'blocked', 'on again: slop hidden again')
check(sum(1 for _ in open(here + '/api.log')) == lines_before, 'on again: served from the verdict cache, no API calls')

# 8. the requests themselves
reqs = [json.loads(l) for l in open(here + '/api.log')]
imgs = [r for r in reqs if 'match' in r]
check(len(imgs) == 7, '7 classification requests for 7 distinct images (got %d: %s)' % (len(imgs), sorted(r['match'] for r in imgs)))
check(sorted(r['match'] for r in imgs) == sorted(['ai_poster', 'ai_infographic', 'ai_effect', 'ai_diagram', 'real_headshot', 'real_screenshot', 'blog_image']), 'every distinct image was classified exactly once')
check(all(r['dist'] < 25 for r in imgs), 'downscaled JPEGs still match their originals (max dist %s)' % max(r['dist'] for r in imgs))
check(all(max(r['w'], r['h']) <= 768 for r in imgs), 'images downscaled to 768px max side')
check(all(r['media_type'] == 'image/jpeg' for r in imgs), 'sent as image/jpeg')
check(all(r['model'] == 'claude-opus-5' and r['effort'] == 'low' and r['fallbacks'] == 'default' and r['beta'] == 'server-side-fallback-2026-07-01' for r in imgs), 'Opus 5 request shape: effort low, fallbacks default + beta header')
check(all(r['version'] == '2023-06-01' and r['key'] == 'test-key' and r['browser'] == 'true' and r['system'] and r['max_tokens'] == 1024 for r in imgs), 'headers: anthropic-version, x-api-key, direct-browser-access; system prompt present')
check(any(r['alt'] for r in imgs if r['match'] == 'ai_poster'), "Facebook's alt text is passed along")
check(all(r['path'] == '/v1/messages' for r in reqs), 'posted to /v1/messages')

# 9. the Test button path and a rejected key
t = popup.eval("chrome.runtime.sendMessage({type: 'slop:test'})", aw=True)
check(t and t.get('ok') and t.get('model') == 'claude-opus-5', 'Test button: %s' % json.dumps(t))
popup.eval("chrome.storage.local.set({slopKey: 'bad-key', slopKeyError: ''})", aw=True)
t = popup.eval("chrome.runtime.sendMessage({type: 'slop:test'})", aw=True)
check(t and not t.get('ok') and '401' in t.get('error', ''), 'bad key reported: %s' % json.dumps(t))
time.sleep(0.5)
s = popup.eval(TAB % 'slop:getStats', aw=True)
check(s and s['paused'] and s['reason'] == 'badkey', 'page pauses on a rejected key: %s' % json.dumps(s))

print('PASS' if not fails else 'FAIL (%d)' % len(fails))
sys.exit(1 if fails else 0)

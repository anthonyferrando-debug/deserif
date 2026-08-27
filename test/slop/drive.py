#!/usr/bin/env python3
"""Steers headless Chromium over CDP for the Facebook blocker test and checks the results.
Usage: drive.py CDP_PORT HERE"""
import base64, json, sys, time, urllib.request
import websocket

cdp_port, here = int(sys.argv[1]), sys.argv[2]
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
popup.eval("new Promise(r => chrome.storage.sync.set({slopEnabled: true, enabled: true, disabledHosts: []}, r))", aw=True)
check(popup.eval("new Promise(r => chrome.storage.sync.get('slopEnabled', v => r(v.slopEnabled)))", aw=True) is True, 'settings seeded through the popup')

# 3. the fake feed
STATE = """(() => {
  const o = {};
  for (const img of document.querySelectorAll('img[id]')) {
    const r = img.getBoundingClientRect();
    o[img.id] = { st: img.getAttribute('data-deserif-slop'), src: (img.getAttribute('src') || '').slice(0, 70),
                  w: Math.round(r.width), h: Math.round(r.height), title: img.getAttribute('title') || '' };
  }
  o.__units = Array.from(document.querySelectorAll('[data-deserif-ai]')).map(u => u.id);
  o.__hash = location.hash; o.__sizes = window.__sizes || {}; o.__ever = window.__everBlocked || {};
  return o;
})()"""
EXPECT = {
    'p_poster': 'blocked', 'p_effect': 'blocked', 'p_info': 'blocked', 'p_late': 'blocked',
    'p_recycle': 'blocked', 'p_lazy': 'blocked', 'p_imagined': 'blocked', 'p_joined': 'blocked',
    'p_feedchild': 'blocked', 'p_bare': 'blocked', 'p_feedplain': None,
    'p_c1': None, 'p_head': None, 'p_shot': None, 'p_blog': None, 'p_removed': None,
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

def wait_settled(seconds=12, min_age=4.5):
    t0 = time.time()
    while time.time() - t0 < seconds:
        st = state()
        if time.time() - t0 >= min_age and all(k in st for k in EXPECT) and all(st[k]['st'] == v for k, v in EXPECT.items()):
            return st
        time.sleep(0.3)
    return state()

page = new_tab('https://www.facebook.com/index.html')
page.call('Page.enable')
wait_ready()
st = wait_settled()
for k, exp in EXPECT.items():
    got = st.get(k, {}).get('st')
    check(got == exp, '%-10s expected %-8s got %s' % (k, exp, got))
check(sorted(st['__units']) == sorted(['post_header_label', 'post_overlay_label', 'comment_labeled', 'post_late_label', 'post_recycle', 'post_lazy', 'post_imagined', 'post_joined', 'post_feedchild', 'post_bare']),
      'labeled units: %s' % sorted(st['__units']))
for k in ('p_poster', 'p_effect', 'p_info', 'p_lazy'):
    before = st['__sizes'].get(k)
    now = [st[k]['w'], st[k]['h']]
    check(before is not None and abs(before[0] - now[0]) <= 1 and abs(before[1] - now[1]) <= 1, '%-10s keeps its box %s -> %s' % (k, before, now))
check(st['p_poster']['src'].startswith('data:image/svg+xml'), 'blocked image src is the transparent SVG')
check('Click to show' in st['p_poster']['title'], 'blocked image has the tooltip')
check(st['__ever'].get('p_removed') is True and st['p_removed']['src'].startswith('https://scontent'), 'label removed later: image was hidden, then restored')
check(st['p_recycle']['st'] == 'blocked', 'recycled element in a labeled post is hidden again with the new picture')

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

# 5. a mutation inside that post does not re-hide what the person chose to show
page.eval("document.getElementById('post_header_label').appendChild(document.createTextNode('new comment text'))")
time.sleep(0.6)
check(state()['p_poster']['st'] == 'shown', 'revealed image stays shown after the post re-renders')

# 6. revealing the recycled image gives back the NEW picture, not the old one
page.eval("document.getElementById('p_recycle').scrollIntoView({block: 'center'})")
time.sleep(0.2)
pt = page.eval("(() => { const r = document.getElementById('p_recycle').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()")
page.call('Input.dispatchMouseEvent', type='mousePressed', x=pt['x'], y=pt['y'], button='left', clickCount=1)
page.call('Input.dispatchMouseEvent', type='mouseReleased', x=pt['x'], y=pt['y'], button='left', clickCount=1)
time.sleep(0.4)
check('ai_effect' in state()['p_recycle']['src'], 'recycled image reveals its new picture')

# 7. popup messages: stats, hide again, show all
TAB = "chrome.tabs.query({url: 'https://www.facebook.com/*'}).then(ts => chrome.tabs.sendMessage(ts[0].id, {type: '%s'}, {frameId: 0}))"
s = popup.eval(TAB % 'slop:getStats', aw=True)
check(s and s['blocked'] == 8 and s['shown'] == 2 and s['units'] == 10 and s['active'], 'popup stats %s' % json.dumps(s))
popup.eval(TAB % 'slop:hideAll', aw=True)
time.sleep(0.3)
st = state()
check(st['p_poster']['st'] == 'blocked' and st['p_recycle']['st'] == 'blocked', 'hide again re-blocks the shown images')
popup.eval(TAB % 'slop:showAll', aw=True)
time.sleep(0.3)
st = state()
check(all(st[k]['st'] == 'shown' for k in ('p_poster', 'p_effect', 'p_info', 'p_late', 'p_recycle', 'p_lazy', 'p_imagined', 'p_joined', 'p_feedchild', 'p_bare')), 'show all reveals everything')
popup.eval(TAB % 'slop:hideAll', aw=True)
time.sleep(0.3)

# 7b. the diagnose report
d = popup.eval(TAB % 'slop:diagnose', aw=True)
check(isinstance(d, str) and d.startswith('Deserif ') and 'labeled=10' in d and 'picked=1' in d and 'short text mentioning AI' in d and '"AI info" match=true' in d and 'match=false' in d,
      'diagnose report: %s' % (d.splitlines()[0:4] if isinstance(d, str) else d))

# 8. switching the feature off restores everything; on again hides again
popup.eval("chrome.storage.sync.set({slopEnabled: false})", aw=True)
time.sleep(0.8)
st = state()
check(all(st[k]['st'] is None for k in EXPECT), 'off: every attribute removed')
check(st['p_poster']['src'].startswith('https://scontent') and not st['__units'] and page.eval("document.querySelectorAll('[data-deserif-unit]').length") == 0, 'off: blocked images restored, unit marks gone')
popup.eval("chrome.storage.sync.set({slopEnabled: true})", aw=True)
st = wait_settled(seconds=6, min_age=1)
check(all(st[k]['st'] == v for k, v in EXPECT.items()), 'on again: the same images hidden')

# 9. per-site off via the shortcut's storage change
popup.eval("chrome.storage.sync.set({disabledHosts: ['www.facebook.com']})", aw=True)
time.sleep(0.8)
check(all(state()[k]['st'] is None for k in EXPECT), 'disabled for www.facebook.com: everything restored')
popup.eval("chrome.storage.sync.set({disabledHosts: []})", aw=True)

print('PASS' if not fails else 'FAIL (%d)' % len(fails))
sys.exit(1 if fails else 0)

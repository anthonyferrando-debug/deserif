#!/usr/bin/env python3
"""Stand-in for POST /v1/messages. Fingerprints the JPEG in each request against
the test images and answers from a fixed verdict table, so the whole pipeline
(fetch, downscale, request shape, parsing, caching, DOM swap) runs without a real
key. Appends one JSON line per request to the log.
Usage: mock_api.py PORT IMGDIR LOGFILE"""
import base64, http.server, io, json, os, sys
from PIL import Image

VERDICTS = {  # stem -> (slop, confidence)
    'ai_poster': (True, 95), 'ai_infographic': (True, 90), 'ai_effect': (True, 88), 'ai_diagram': (True, 85),
    'real_headshot': (False, 97), 'real_screenshot': (False, 93),
    'blog_image': (True, 45),   # called slop, but under the 60 threshold: must stay visible
}

def fingerprint(im):
    return im.convert('L').resize((12, 12), Image.BILINEAR).tobytes()

def dist(a, b):
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)

port, imgdir, log = int(sys.argv[1]), sys.argv[2], sys.argv[3]
REF = {}
for f in os.listdir(imgdir):
    stem = os.path.splitext(f)[0]
    if stem in VERDICTS:
        REF[stem] = fingerprint(Image.open(os.path.join(imgdir, f)))

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('access-control-allow-origin', '*')
        self.send_header('access-control-allow-headers', '*')
        self.send_header('access-control-allow-methods', 'POST, OPTIONS')
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get('content-length', 0))
        body = json.loads(self.rfile.read(n) or b'{}')
        h = self.headers
        entry = {
            'path': self.path, 'model': body.get('model'), 'fallbacks': body.get('fallbacks'),
            'beta': h.get('anthropic-beta'), 'version': h.get('anthropic-version'), 'key': h.get('x-api-key'),
            'browser': h.get('anthropic-dangerous-direct-browser-access'),
            'effort': (body.get('output_config') or {}).get('effort'), 'max_tokens': body.get('max_tokens'),
            'system': bool(body.get('system')), 'thinking': body.get('thinking'),
        }
        text = 'OK'
        content = (body.get('messages') or [{}])[0].get('content')
        if isinstance(content, list):
            img = next((c for c in content if c.get('type') == 'image'), None)
            txt = next((c for c in content if c.get('type') == 'text'), None)
            entry['alt'] = bool(txt and 'alt text' in txt.get('text', ''))
            if img:
                src = img['source']
                entry['media_type'] = src.get('media_type')
                im = Image.open(io.BytesIO(base64.b64decode(src['data'])))
                entry['w'], entry['h'] = im.size
                fp = fingerprint(im)
                best = min(REF, key=lambda k: dist(REF[k], fp))
                entry['match'] = best
                entry['dist'] = round(dist(REF[best], fp), 1)
                slop, conf = VERDICTS[best]
                text = json.dumps({'slop': slop, 'confidence': conf, 'reason': 'mock ' + best})
        with open(log, 'a') as fh:
            fh.write(json.dumps(entry) + '\n')
        if h.get('x-api-key') == 'bad-key':
            out = json.dumps({'type': 'error', 'error': {'type': 'authentication_error', 'message': 'invalid x-api-key'}}).encode()
            self.send_response(401)
        else:
            out = json.dumps({
                'id': 'msg_mock', 'type': 'message', 'role': 'assistant', 'model': body.get('model'),
                'content': [{'type': 'text', 'text': text}], 'stop_reason': 'end_turn', 'stop_sequence': None,
                'usage': {'input_tokens': 500, 'output_tokens': 20}
            }).encode()
            self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(out)))
        self.send_header('access-control-allow-origin', '*')
        self.end_headers()
        self.wfile.write(out)

http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()

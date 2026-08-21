"""Reads the CDBG JSON from test/site/index.html (via stdin) and checks it against expectations."""
import sys, json, html

raw = sys.stdin.read().strip()
if not raw:
    print("FAIL: no CDBG output (content script did not run; is the page served over http?)")
    sys.exit(1)
d = json.loads(html.unescape(raw))

EXPECT_TAGGED = {"t1", "t3", "t4", "t10", "t12", "t13", "t14", "t15em", "t16", "shadowp"}
EXPECT_BEFORE = {"t8"}
tagged = {k for k, v in d.items() if v and v.get("tagged")}
before = {k for k, v in d.items() if v and v.get("before")}
ok = True
for k, v in d.items():
    print(f"{k:8} tagged={str(bool(v and v.get('tagged'))):5} before={str(bool(v and v.get('before'))):5} ff={(v or {}).get('ff', '')[:50]}")
if tagged != EXPECT_TAGGED:
    ok = False; print("FAIL tagged mismatch:", sorted(tagged ^ EXPECT_TAGGED))
if before != EXPECT_BEFORE:
    ok = False; print("FAIL before-tagged mismatch:", sorted(before ^ EXPECT_BEFORE))
if d.get("t15em", {}).get("fs") != "normal":
    ok = False; print("FAIL italic accent not straightened")
if "Font Awesome" not in d.get("t9", {}).get("beforeFF", ""):
    ok = False; print("FAIL icon font was touched")
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)

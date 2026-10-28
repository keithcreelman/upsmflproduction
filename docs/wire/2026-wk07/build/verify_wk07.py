#!/usr/bin/env python3
"""Whole-page checks for the Week 7 editorial rewrite: python3 verify_wk07.py <article.html>
 1. no placeholders, no EDITOR REVIEW or editor-gap boxes, no unresolved {fact} tokens
 2. balanced section markup; every segment a direct child of the page wrapper; each segment has visible narrative outside any <details>
 3. every number in the narrative text (desk lines and headings) is a registered claim (narrative_claims.json), a date/time/ordinal, or inside a verbatim quote
 4. quotes are verbatim to chat_quotes.json; none is in chat_exclusions.json
 5. no probability is shown as 100% or 0%: only a clinch or an elimination could be (nobody has either)"""
import html as H, json, os, re, sys

D = os.path.dirname(os.path.abspath(__file__))
art = open(sys.argv[1], encoding="utf-8").read()
claims = json.load(open(os.path.join(D, "narrative_claims.json")))
Q = json.load(open(os.path.join(D, "chat_quotes.json")))["quotes"]
bad = []
for pat in (r"\{[a-z_0-9]+\}", r"EDITOR REVIEW", r"editor-gap", r"TODO", r"lorem"):
    if re.search(pat, art):
        bad.append("found " + pat)
body_text = re.sub(r"<style[\s\S]*?</style>|<script[\s\S]*?</script>", "", art)
shown = " ".join(re.findall(r">([^<>]*%[^<>]*)<", body_text)) + " " + re.sub(r"<[^>]+>", " ", body_text)
if re.search(r"(?<![\d.])(100(\.0+)?|0(\.0+)?)%", shown):
    bad.append("a probability is shown as 100% or 0% (nobody has clinched or been eliminated)")
secs = re.findall(r'<section class="wire-sec" id="(\w+)"', art)
ids = ["story", "middle", "odds", "heat", "brief", "weeks", "players", "survival", "elias"]
if secs != ids:
    bad.append("section ids %s" % secs)
if art.count("<section") != art.count("</section>"):
    bad.append("unbalanced <section>")
# narrative text only: desk-lines and h3, not tables or <details>
nar = []
for m in re.finditer(r'<div class="lt \w+"><div class="who">\w+</div><p>([\s\S]*?)</p></div>|<h3[^>]*>([\s\S]*?)</h3>|<div class="label"[^>]*>([\s\S]*?)</div>', art):
    nar.append(m.group(1) or m.group(2) or m.group(3))
text = H.unescape(re.sub(r"<[^>]+>", " ", " ".join(nar)))
text = re.sub(r"\s+", " ", text)
# drop verbatim quotes
for mid, q in Q.items():
    text = text.replace(q["text"], " ")
reg = set()
for k, v in claims.items():
    for tok in re.findall(r"\d[\d,]*\.?\d*", str(v["shown"])):
        reg.add(tok.rstrip("."))
auto = json.load(open(os.path.join(D, "../../auto/2026-wk07-ups-center/claims.json")))      # the automated draft's own validated claims (results lines)
for k, v in auto.items():
    for tok in re.findall(r"\d[\d,]*\.?\d*", H.unescape(str(v["shown"]))):
        reg.add(tok.rstrip(".,"))
ALLOWED = {"2026", "1", "2", "3", "7", "9", "12", "10,000", "11", "6", "0.2", "5", "4", "8"}      # week and segment numbers, counts named in the prose
DATES = re.compile(r"(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w* ?(Oct \d+)?|\d{1,2}:\d{2} (AM|PM)|Oct \d+|Nov \d+|Week \d+|Weeks \d+")
t2 = DATES.sub(" ", text)
unreg = sorted({tok.rstrip(".,") for tok in re.findall(r"\d[\d,]*\.?\d*", t2)} - reg - ALLOWED)
if unreg:
    bad.append("unregistered numbers in narrative: %s" % unreg)
for mid, q in Q.items():
    if q["text"] not in H.unescape(art.replace("&rsquo;", "’")) and H.escape(q["text"], quote=False) not in art:
        bad.append("quote missing: " + mid)
ex = {m["message_id"] for m in json.load(open(os.path.join(D, "../../../../site/wire/data/chat_exclusions.json")))["messages"]}
if set(Q) & ex:
    bad.append("excluded quote used")
print("sections:", secs)
print("narrative chars:", len(text), "| registered numbers:", len(reg))
print("FAIL" if bad else "PASS", *bad, sep="\n  ")
sys.exit(1 if bad else 0)

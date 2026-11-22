# BL-M01: independent MFL verification of the 31 reviewed cut-penalty names (2026-11-22)

**What this is.** The evidence behind `apps/mobile2027/src/lib/reviewed_names.js`, kept in the repository so it does not live only in an issue thread. It records a verification made by the mobile build session on Keith's instruction, from MFL's own exports, separately from the backlog session's blind re-run (recorded on issue #1502; not reproduced here). Nothing here approves a build, merge or deployment.

**What the offline test does and does not establish.** `tests/mobile2027_reviewed_names.test.mjs` compares the bundle with a second copy of the reviewed table (`tests/fixtures/mobile2027/reviewed_names_31.json`, taken from the #1502 inventory). Both copies were derived from the same verified table, so the test checks **transcription and consistency** (and the matching rules). It is **not** an independent check that each token names that player. That identity evidence is the MFL verification below, which was run against live MFL exports and cannot run in the offline safe suite.

## Method (read-only; no credentials; no writes)
Four GET requests through the Worker's public MFL export route for league 74598: `transactions` 2025, `players` 2025 and 2026, `salaryAdjustments` 2026. The repo ledger `site/reports/salary_adjustments/salary_adjustments_2026.json` supplied only the proposed source token to player id and its transaction time. Per token:

1. **Name path (corroboration only; the app never reads description text).** The name inside the MFL adjustment row (the same row that carries the token and the posted amount) is looked up in the MFL players exports. It must resolve to exactly one id, equal to the proposed id.
2. **Transaction path.** MFL's 2025 transactions must show exactly one drop of that player by that team, of type FREE_AGENT or BBID_WAIVER, within 2 minutes of the ledger time. A BBID_WAIVER transaction carries its drops in the **last of three** `|`-separated segments.
3. All 31 player ids are present in the MFL 2026 players export.

## Result: 31 of 31 consistent
| Check | Result |
|---|---|
| Distinct add/drop tokens in the MFL adjustment rows | 31 (the same 31 as the ledger's) |
| Name in the row equals the MFL name for the proposed id; one id for that name | 31 of 31 |
| Exactly one matching MFL drop within 2 minutes | 31 of 31 (0 seconds off in all) |
| Player id present in MFL players 2026 | 31 of 31 |
| Team on the adjustment row = team of the ledger row = team of the MFL drop | 31 of 31 |

## Limits
- The 2-minute window is centered on the ledger's time, so identity is not fully independent of the ledger. For **12** tokens the same team made another drop within those 2 minutes; those rest on the row's own name and amount plus the ledger.
- Team 0010 (the pair where a mix-up would put the wrong name on an amount): `adddrop2025_426.2` names Chism, Efton, posted $1,000; `adddrop2025_427.2` names Thibodeaux, Kayvon, posted $2,000. Swapping the names would pair $2,000 with Chism, contradicting the posted and ledger amounts. The pairing holds.
- Amounts were not the subject: 21 of 31 posted amounts equal the ledger's; the other 10 are all posted at $1,000 against raw ledger amounts of $500 to $1,750 (the reported TCV <= $4K rule, not verified here).
- A player can appear for two teams (Engram, Evan: teams 0001 and 0005), so the key includes the team.
- The raw transactions export carries owner comments and is not kept; only ids, times and counts are recorded.

## The 31, as checked
| Source token | Team | Player id | Player (MFL) | Name in the adjustment row = MFL name, one id for that name, same id | MFL drop by that team of that player (type; seconds from ledger time; count within 2 min) | Other drops by the same team within 2 min | Posted amount |
|---|---|---|---|---|---|---|---|
| `adddrop2025_114.1` | 0010 | 13713 | Fitzpatrick, Minkah | yes | FREE_AGENT; 0s; 1 | 0 | $1,000 |
| `adddrop2025_129.1` | 0009 | 13668 | Chark, D.J. | yes | FREE_AGENT; 0s; 1 | 0 | $1,000 |
| `adddrop2025_141.2` | 0007 | 16152 | Richardson, Anthony | yes | BBID_WAIVER; 0s; 1 | 1 | $3,500 |
| `adddrop2025_192.2` | 0006 | 16693 | Sweat, T'Vondre | yes | BBID_WAIVER; 0s; 1 | 0 | $1,000 |
| `adddrop2025_231.2` | 0001 | 14210 | Pratt, Germaine | yes | BBID_WAIVER; 0s; 1 | 1 | $1,000 |
| `adddrop2025_266.2` | 0001 | 17097 | Felton, Tai | yes | BBID_WAIVER; 0s; 1 | 0 | $1,000 |
| `adddrop2025_276.2` | 0002 | 14322 | Edwards, T.J. | yes | BBID_WAIVER; 0s; 1 | 0 | $4,000 |
| `adddrop2025_298.2` | 0010 | 17105 | Helm, Gunnar | yes | BBID_WAIVER; 0s; 1 | 0 | $1,000 |
| `adddrop2025_333.2` | 0006 | 17054 | Martinez, Damien | yes | BBID_WAIVER; 0s; 1 | 0 | $2,500 |
| `adddrop2025_336.1` | 0001 | 14358 | Browning, Jake | yes | FREE_AGENT; 0s; 1 | 0 | $6,300 |
| `adddrop2025_364.2` | 0007 | 14303 | Elliss, Kaden | yes | BBID_WAIVER; 0s; 1 | 1 | $1,000 |
| `adddrop2025_369.2` | 0008 | 15337 | Gray, Noah | yes | BBID_WAIVER; 0s; 1 | 2 | $1,000 |
| `adddrop2025_370.2` | 0008 | 13737 | Bates, Jessie | yes | BBID_WAIVER; 0s; 1 | 2 | $1,000 |
| `adddrop2025_371.2` | 0008 | 14153 | Allen, Zach | yes | BBID_WAIVER; 0s; 1 | 2 | $1,000 |
| `adddrop2025_380.1` | 0007 | 16262 | White, Keion | yes | FREE_AGENT; 0s; 1 | 0 | $4,000 |
| `adddrop2025_382.1` | 0003 | 16688 | Guerendo, Isaac | yes | FREE_AGENT; 0s; 1 | 2 | $2,000 |
| `adddrop2025_391.2` | 0003 | 16643 | Sanders, Ja'Tavion | yes | FREE_AGENT; 0s; 1 | 0 | $2,000 |
| `adddrop2025_399.2` | 0005 | 13837 | Franklin, Zaire | yes | BBID_WAIVER; 0s; 1 | 0 | $2,500 |
| `adddrop2025_425.2` | 0001 | 13681 | Chubb, Bradley | yes | BBID_WAIVER; 0s; 1 | 0 | $750 |
| `adddrop2025_426.2` | 0010 | 17269 | Chism, Efton | yes | BBID_WAIVER; 0s; 1 | 1 | $1,000 |
| `adddrop2025_427.2` | 0010 | 15806 | Thibodeaux, Kayvon | yes | BBID_WAIVER; 0s; 1 | 1 | $2,000 |
| `adddrop2025_490.1` | 0012 | 12187 | Lockett, Tyler | yes | FREE_AGENT; 0s; 1 | 0 | $3,000 |
| `adddrop2025_549.2` | 0004 | 16679 | Nubin, Tyler | yes | FREE_AGENT; 0s; 1 | 0 | $1,000 |
| `adddrop2025_594.1` | 0005 | 15254 | Harris, Najee | yes | FREE_AGENT; 0s; 1 | 0 | $3,250 |
| `adddrop2025_595.1` | 0001 | 13189 | Engram, Evan | yes | FREE_AGENT; 0s; 1 | 0 | $2,500 |
| `adddrop2025_596.2` | 0005 | 14909 | Winfield, Antoine | yes | BBID_WAIVER; 0s; 1 | 2 | $1,000 |
| `adddrop2025_634.1` | 0012 | 12140 | Winston, Jameis | yes | FREE_AGENT; 0s; 1 | 0 | $3,500 |
| `adddrop2025_651.2` | 0001 | 14882 | Greenard, Jonathan | yes | BBID_WAIVER; 0s; 1 | 1 | $1,000 |
| `adddrop2025_657.2` | 0008 | 16215 | Musgrave, Luke | yes | BBID_WAIVER; 0s; 1 | 2 | $2,450 |
| `adddrop2025_692.2` | 0005 | 13189 | Engram, Evan | yes | BBID_WAIVER; 0s; 1 | 0 | $2,800 |
| `adddrop2025_698.1` | 0011 | 15240 | Lance, Trey | yes | FREE_AGENT; 0s; 1 | 0 | $2,100 |

## How to re-verify
Re-run the script below against fresh exports (it needs network access; it is not part of the safe suite) and compare its table with this one and with `reviewed_names.js`. Any difference needs a new reviewed list and Keith's go before the bundle changes.

```python
"""Independent check of the 31 add/drop cut-penalty mappings (BL-M01). Read-only; inputs are four MFL exports fetched through the Worker's export route,
plus the repo ledger file. Prints only ids, names of NFL players, times and counts. No credentials, no owner comments are printed or kept in the output."""
import json, re, collections, datetime
from zoneinfo import ZoneInfo
E = "/private/tmp/claude-501/-Users-keithcreelman-Code-MFL-upsmflproduction--claude-worktrees-frosty-blackwell-93c632/a9331742-676a-4b30-b4bc-9e70e4e9b0d4/scratchpad/e2/"
arr = lambda x: x if isinstance(x, list) else ([] if x is None else [x])
tx = arr(json.load(open(E + "transactions_2025.json"))["transactions"]["transaction"])
p26 = {p["id"]: p for p in arr(json.load(open(E + "players_2026.json"))["players"]["player"])}
p25 = {p["id"]: p for p in arr(json.load(open(E + "players_2025.json"))["players"]["player"])}
sa = arr(json.load(open(E + "saladj_2026.json"))["salaryAdjustments"]["salaryAdjustment"])
ledger = {r["source_id"]: r for r in json.load(open("site/reports/salary_adjustments/salary_adjustments_2026.json"))["rows"] if str(r.get("source_id", "")).startswith("adddrop2025_")}
print("transactions:", len(tx), "types:", dict(collections.Counter(t["type"] for t in tx)))
print("transaction keys (one sample, keys only):", sorted(next(t for t in tx if t["type"] == "FREE_AGENT").keys()))
print("sample FA transaction string:", next(t for t in tx if t["type"] == "FREE_AGENT")["transaction"])
print("sample BBID transaction string (ids and amounts only):", next(t for t in tx if t["type"] == "BBID_WAIVER")["transaction"])
# 2026 salary adjustments rows that carry an add/drop token
P_CUT = re.compile(r"^UPS drop penalty (.+?) -?\d+(?:\.\d+)? id:(adddrop\d{4}_\d+\.\d+)$")
rows = {}
for r in sa:
    m = P_CUT.match(r.get("description", ""))
    if m: rows[m.group(2)] = (r, m.group(1))
print("salaryAdjustments rows:", len(sa), "| cut rows with an add/drop token:", len(rows), "| ledger add/drop rows:", len(ledger), "| same token set:", set(rows) == {k for k in ledger if k in rows} and len(rows) == 31)
byname = collections.defaultdict(list)
for src in (p26, p25):
    for i, p in src.items(): byname[p["name"]].append(i)
def et_to_epoch(s): return int(datetime.datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=ZoneInfo("America/New_York")).timestamp())
def split(tstr):
    # FREE_AGENT / WAIVER: "adds|drops"; BBID_WAIVER: "adds|bid|drops". The drops are the LAST segment in every form.
    seg = tstr.split("|")
    return [x for x in seg[0].split(",") if x], [x for x in seg[-1].split(",") if x] if len(seg) >= 2 else []
drops = collections.defaultdict(list)   # (franchise, player) -> [(ts, type)]
for t in tx:
    if t["type"] in ("FREE_AGENT", "WAIVER", "BBID_WAIVER"):
        for pid in split(t["transaction"])[1]: drops[(t["franchise"], pid)].append((int(t["timestamp"]), t["type"], t["transaction"]))
res = []; bad = 0
for tok in sorted(rows, key=lambda k: (int(k.split("_")[1].split(".")[0]), k)):
    r, nm = rows[tok]; L = ledger[tok]; fid, pid = L["franchise_id"], L["player_id"]
    # 1) identity from the ledger (proposed); 2) identity from the description name -> MFL players export, unique?; 3) MFL drop by that franchise
    ids_by_name = sorted(set(byname.get(nm, [])))
    mfl_name = (p26.get(pid) or p25.get(pid) or {}).get("name")
    lt = et_to_epoch(L["transaction_datetime_et"])
    cands = [(abs(ts - lt), ts, ty) for ts, ty, _ in drops.get((fid, pid), [])]
    near = [c for c in cands if c[0] <= 120]
    franchise_ok = r["franchise_id"] == fid
    # other drops by the same franchise within 2 minutes of the ledger time (could be confused with this one)
    others = [(k[1], ts) for k, v in drops.items() if k[0] == fid and k[1] != pid for ts, ty, _ in v if abs(ts - lt) <= 120]
    ok = (ids_by_name == [pid]) and (mfl_name == nm) and len(near) == 1 and franchise_ok and pid in p26
    bad += (not ok)
    res.append((tok, fid, pid, mfl_name, nm == mfl_name, ids_by_name == [pid], len(ids_by_name), len(cands), len(near), (near[0][0] if near else None), near[0][2] if near else None, len(others), pid in p26, int(r["amount"]), L["amount"], ok))
print("token | fid | player id | MFL name | desc name == MFL name | name->id unique & equal | #ids for name | #MFL drops by fid of that player (whole 2025) | #within 2 min | seconds off | type | #other drops by fid within 2 min | in 2026 players | posted amt | ledger amt | PASS")
for x in res: print(" | ".join(str(y) for y in x))
with open(E + "table.md", "w") as f:
    f.write("| Source token | Team | Player id | Player (MFL) | Name in the adjustment row = MFL name, one id for that name, same id | MFL drop by that team of that player (type; seconds from ledger time; count within 2 min) | Other drops by the same team within 2 min | Posted amount |\n|---|---|---|---|---|---|---|---|\n")
    for x in res:
        f.write("| `%s` | %s | %s | %s | %s | %s; %ds; %d | %d | $%s |\n" % (x[0], x[1], x[2], x[3], "yes" if (x[4] and x[5]) else "NO", x[10], x[9], x[8], x[11], format(x[13], ",")))
print("PASS", sum(1 for x in res if x[-1]), "of", len(res), "| FAIL", bad)
print("tokens with another drop by the same franchise within 2 minutes (ledger-dependent identity):", sum(1 for x in res if x[11]))
print("posted amount == ledger amount:", sum(1 for x in res if x[13] == x[14]), "| differ:", [(x[0], x[13], x[14]) for x in res if x[13] != x[14]])
print("team 0010 rows:", [(x[0], x[3], x[13]) for x in res if x[1] == "0010"])
```

#!/usr/bin/env python3
"""Re-run the code-path proof (read-only): for every row in classification.json, the worker version(s) live when it was
written — the last successful deploy-worker run before it, plus the one before that when the row is within 15 minutes of a
deploy (Cloudflare rolls out gradually) — and 13 checks on that version's contract handler showing that a row with
landed = 1 and import_status = 0 can only come from its dry-run branch.

    gh run list --workflow deploy-worker.yml --limit 1000 --json headSha,createdAt,updatedAt,conclusion > /tmp/deploy_runs.json
    python3 docs/incidents/2026-10-08_salary_change_log_dry_run_relabel/verify_code_path.py /tmp/deploy_runs.json

Exit 0 only when every check holds in every candidate version.
"""
import datetime as dt
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
P = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
HANDLER = 'path === "/offer-mym" ||\n        path === "/offer-restructure" ||\n        path === "/commish-contract-update"'


def strip_comments(text):
    return "\n".join(re.sub(r"(^|[^:\"'])//.*$", r"\1", line) for line in text.split("\n"))


def assigns(region, name):
    return len(re.findall(r"(?<![=!<>.\w])" + name + r"\s*=(?!=)", region))


def checks(src):
    a = src.find(HANDLER)
    if a < 0:
        return {"0 handler found": False}
    region = strip_comments(src[a:src.find("/* never fail the request on audit errors */", a)])
    eps = [m.group(2).strip() for m in re.finditer(r"await logSalaryChangeRow\(auditDb, \{([\s\S]{0,600}?)endpoint:\s*([^,\n]+),", src)]
    return {
        "1 dry-run flag parsed from body/query": "const dryRunFlag = (() => {" in region,
        "2 dry branch = simulated success": bool(re.search(r"if \(dryRunFlag === 1\) \{\s*looksOk = true;\s*anyChanged = true;", region)),
        "3 MFL import loop skipped on a dry run": "for (const statusCandidate of (dryRunFlag ? [] : statusAttempts))" in region,
        "4 mflRes set only from a real MFL fetch": assigns(region, "mflRes") == 2 and re.search(r"const res = await fetch\(targetImportUrl,[\s\S]{0,2500}?mflRes = res;", region) is not None,
        "5 looksOk set only by the dry branch or MFL's answer": assigns(region, "looksOk") == 3 and "looksOk = requestOk;" in region,
        "6 anyChanged set only by the dry branch or an observed diff": assigns(region, "anyChanged") == 3 and "if (changed) anyChanged = true;" in region,
        "7 changed = observed year/info/status diff": bool(re.search(r"const changed =\s*!!preCheck &&\s*!!verifyAfter &&\s*\(String\(preCheck\.contractYear", region)),
        "8 postCheck only from the MFL re-read": assigns(region, "postCheck") == 2 and "postCheck = verifyAfter || preCheck;" in region,
        "9 audit import_status = MFL response or 0": "import_status: mflRes ? mflRes.status : 0" in region,
        "10 audit landed = import_ok_* status": bool(re.search(r'const landedFlag =\s*mutationStatus === "import_ok_log_dispatched" \|\|\s*mutationStatus === "import_ok_log_failed";', region)),
        "11 audit dry_run hard-coded false (the bug)": bool(re.search(r"endpoint: path,\s*league_id: leagueId,\s*season: year,\s*dry_run: false,", region)),
        "12 import_ok_* requires looksOk + verify + anyChanged": bool(re.search(r'let mutationStatus = "import_rejected";\s*if \(!looksOk\) \{\s*mutationStatus = "import_rejected";\s*\} else if \(!verifyAvailable\) \{\s*mutationStatus = "verify_unavailable";\s*\} else if \(!anyChanged\) \{\s*mutationStatus = "import_no_change";', region)),
        "13 only this handler logs these three endpoints": eps.count("path") == 1 and all(x in ('"/admin/import-salaries"', '"/admin/reset-fa-contracts"', "path") for x in eps),
    }


def main(runs_path):
    runs = sorted([r for r in json.load(open(runs_path)) if r["conclusion"] == "success"], key=lambda r: r["createdAt"])
    rows = json.load(open(os.path.join(HERE, "classification.json")))
    cache, ok = {}, True
    for row in rows:
        t = P(row["ts"])
        done = [x for x in runs if P(x["updatedAt"]) <= t]
        cands = [done[-1]["headSha"]] + ([done[-2]["headSha"]] if len(done) > 1 and (t - P(done[-1]["updatedAt"])).total_seconds() <= 900 else [])
        bad = []
        for sha in cands:
            if sha not in cache:
                cache[sha] = checks(subprocess.run(["git", "show", f"{sha}:worker/src/index.js"], capture_output=True, text=True).stdout)
            bad += [f"{sha[:8]}: {k}" for k, v in cache[sha].items() if v is not True]
        ok = ok and not bad
        print(row["id"], row["ts"][:19], [c[:8] for c in cands], "all 13 checks hold" if not bad else f"FAILS {bad}")
    print(f"{len(cache)} versions checked; every check holds in every candidate version: {ok}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/deploy_runs.json"))

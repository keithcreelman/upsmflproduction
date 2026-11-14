// The contract-activity type the worker logs and announces (deriveContractActivityType, worker/src/index.js). A contract
// change whose caller names no kind used to be logged and posted as "FA Contract" (Keith 2026-10-28, ruling 7: Jaxon
// Smith-Njigba's 2026-07-28 commissioner year-roll, $14,000 / 3 yrs → $1,000 / 2 yrs, showed as an "FA Contract").
// It is now "Contract Change", with the same kind, GIF pool and Discord routing.
//   node tests/contract_activity_type_label.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");
const grab = (name) => {
  const m = new RegExp("const " + name + " = (\\([\\s\\S]*?\\n      \\});").exec(SRC);
  if (!m) throw new Error(name + " not found");
  return m[1];
};
const safeStr = (v) => (v == null ? "" : String(v).trim());
const derive = new Function("safeStr", "return " + grab("deriveContractActivityType"))(safeStr);
const kindOf = new Function("safeStr", "return " + grab("normalizeContractActivityKind"))(safeStr);

test("named kinds keep their labels", () => {
  t.equal(derive({ contractStatus: "TAG" }), "Tag");
  t.equal(derive({ isExtensionSubmission: true, contractStatus: "Vet-Ext2" }), "Extension");
  t.equal(derive({ isRestructure: true, contractStatus: "Vet-Ext2-FL" }), "Restructure");
  t.equal(derive({ isMyac: true, contractStatus: "Vet-FAA" }), "Multi-Year Contract");
  t.equal(derive({ isMym: true, contractStatus: "Vet-MYM" }), "MYM");
});

test("an unnamed contract change is 'Contract Change', never 'FA Contract'", () => {
  // The Smith-Njigba request: /commish-contract-update with the commissioner key, no submission_kind, status Vet-Ext2-FL.
  t.equal(derive({ isExtensionSubmission: false, isRestructure: false, isMyac: false, isMym: false, contractStatus: "Vet-Ext2-FL" }), "Contract Change");
  t.equal(derive({ contractStatus: "ROPT" }), "Contract Change", "a rookie option");
  t.equal(derive({ contractStatus: "Veteran" }), "Contract Change", "a stale-tag cleanup");
  t.ok(!/return "FA Contract"/.test(SRC), "the worker no longer returns the label");
});

test("same kind, GIF pool and Discord routing as before", () => {
  t.equal(kindOf("Contract Change", "Vet-Ext2-FL"), kindOf("FA Contract", "Vet-Ext2-FL"));
  t.equal(kindOf("Contract Change", ""), "other");
  t.ok(/"Multi-Year Contract": "myac", "Contract Change": "myac", "FA Contract": "myac"/.test(SRC), "routes like 'FA Contract' did (myac)");
});

await run("contract_activity_type_label");

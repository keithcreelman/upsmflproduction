// "Suggest a deep cut" button on #ups-wire deep-cut posts (worker/src/discord_deepcut_suggest.js), against real SQLite and the real migration:
//   a. the button opens a modal with the player/moment, when, and what-do-you-remember questions, carrying the post id.
//   b. a submission writes ONE queue row (with the post id, user and text) and answers privately, with no channel post.
//   c. the 6th suggestion from one owner within a day is refused and writes nothing; another owner is unaffected.
//   d. a blank subject writes nothing; with no database the owner is told, not crashed.
//   e. the dispatcher source routes the button and the modal through discord_bot.js.
//   node tests/deepcut_suggest.test.mjs
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
const M = await import("../worker/src/discord_deepcut_suggest.js");

const fresh = () => { const DB = makeD1(); applyMigrations(DB, ["0173_deepcut_suggestions.sql"]); return DB; };
const modalSubmit = (userId, subject, extra = {}) => ({
  type: 5, token: "tok", application_id: "app", channel_id: "chan",
  member: { user: { id: userId, username: "u" + userId }, nick: "Owner " + userId },
  data: { custom_id: "dc_suggest_modal:1563205296212676742", components: [
    { components: [{ custom_id: "subject", value: subject }] },
    { components: [{ custom_id: "seasons", value: extra.seasons ?? "2013" }] },
    { components: [{ custom_id: "details", value: extra.details ?? "He was on three teams." }] },
  ] },
});
const body = async (res) => (await res.json());

test("a. the button opens the modal and carries the post id", async () => {
  t.ok(M.isDeepCutButton("dc_suggest")); t.ok(!M.isDeepCutButton("wire_reply:1"));
  const j = await body(M.handleDeepCutButton({ data: { custom_id: "dc_suggest" }, message: { id: "1563205296212676742" } }));
  t.equal(j.type, 9); t.ok(M.isDeepCutModal(j.data.custom_id)); t.match(j.data.custom_id, /:1563205296212676742$/);
  t.deepEqual(j.data.components.map((r) => r.components[0].custom_id), ["subject", "seasons", "details"]);
  t.equal(j.data.components[0].components[0].required, true); t.match(j.data.components[0].components[0].placeholder, /Joique Bell/);
  t.equal(M.SUGGEST_BUTTON_ROW.components[0].custom_id, "dc_suggest");
});

test("b. a submission writes one queue row and answers privately", async () => {
  const DB = fresh();
  const res = await body(await M.handleDeepCutModal(modalSubmit("42", "Joique Bell"), { DB }, null));
  t.equal(res.data.flags, 64); t.match(res.data.content, /Joique Bell/); t.match(res.data.content, /in the queue/);
  const rows = DB.raw.prepare("SELECT * FROM ups_deepcut_suggestions").all();
  t.equal(rows.length, 1); t.equal(rows[0].subject, "Joique Bell"); t.equal(rows[0].discord_user_id, "42");
  t.equal(rows[0].source_message_id, "1563205296212676742"); t.equal(rows[0].status, "new"); t.equal(rows[0].seasons, "2013");
});

test("c. the daily cap holds per owner", async () => {
  const DB = fresh();
  for (let i = 0; i < M.DAILY_LIMIT; i++) await M.handleDeepCutModal(modalSubmit("42", "Player " + i), { DB }, null);
  const over = await body(await M.handleDeepCutModal(modalSubmit("42", "One too many"), { DB }, null));
  t.match(over.data.content, /5 suggestions in the last day/);
  t.equal(DB.raw.prepare("SELECT COUNT(*) n FROM ups_deepcut_suggestions WHERE discord_user_id='42'").get().n, M.DAILY_LIMIT);
  await M.handleDeepCutModal(modalSubmit("43", "Josh Hill"), { DB }, null);
  t.equal(DB.raw.prepare("SELECT COUNT(*) n FROM ups_deepcut_suggestions").get().n, M.DAILY_LIMIT + 1);
});

test("d. a blank subject writes nothing, and no database does not crash", async () => {
  const DB = fresh();
  const blank = await body(await M.handleDeepCutModal(modalSubmit("42", "  "), { DB }, null));
  t.match(blank.data.content, /couldn't read/); t.equal(DB.raw.prepare("SELECT COUNT(*) n FROM ups_deepcut_suggestions").get().n, 0);
  const none = await body(await M.handleDeepCutModal(modalSubmit("42", "Josh Hill"), {}, null));
  t.match(none.data.content, /suggestion box is down/);
});

test("e. the dispatcher source routes the button and the modal", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../worker/src/discord_bot.js", import.meta.url), "utf8");
  t.match(src, /isDeepCutButton\(customId\)/); t.match(src, /isDeepCutModal\(customId\)/);
});

await run("deepcut_suggest");

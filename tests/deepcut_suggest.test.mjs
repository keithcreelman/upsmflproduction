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
const bare = () => makeD1();   // no migration applied: the worker creates the table itself on first use
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
  const res = await body(await M.handleDeepCutModal(modalSubmit("42", "Joique Bell"), { UPS_MFL_DB: DB }, null));
  t.equal(res.data.flags, 64); t.match(res.data.content, /Joique Bell/); t.match(res.data.content, /in the queue/);
  const rows = DB.raw.prepare("SELECT * FROM ups_deepcut_suggestions").all();
  t.equal(rows.length, 1); t.equal(rows[0].subject, "Joique Bell"); t.equal(rows[0].discord_user_id, "42");
  t.equal(rows[0].source_message_id, "1563205296212676742"); t.equal(rows[0].status, "new"); t.equal(rows[0].seasons, "2013");
});

test("c. the daily cap holds per owner", async () => {
  const DB = fresh();
  for (let i = 0; i < M.DAILY_LIMIT; i++) await M.handleDeepCutModal(modalSubmit("42", "Player " + i), { UPS_MFL_DB: DB }, null);
  const over = await body(await M.handleDeepCutModal(modalSubmit("42", "One too many"), { UPS_MFL_DB: DB }, null));
  t.match(over.data.content, /5 suggestions in the last day/);
  t.equal(DB.raw.prepare("SELECT COUNT(*) n FROM ups_deepcut_suggestions WHERE discord_user_id='42'").get().n, M.DAILY_LIMIT);
  await M.handleDeepCutModal(modalSubmit("43", "Josh Hill"), { UPS_MFL_DB: DB }, null);
  t.equal(DB.raw.prepare("SELECT COUNT(*) n FROM ups_deepcut_suggestions").get().n, M.DAILY_LIMIT + 1);
});

test("d. a blank subject writes nothing, and no database does not crash", async () => {
  const DB = fresh();
  const blank = await body(await M.handleDeepCutModal(modalSubmit("42", "  "), { UPS_MFL_DB: DB }, null));
  t.match(blank.data.content, /couldn't read/); t.equal(DB.raw.prepare("SELECT COUNT(*) n FROM ups_deepcut_suggestions").get().n, 0);
  const none = await body(await M.handleDeepCutModal(modalSubmit("42", "Josh Hill"), {}, null));
  t.match(none.data.content, /suggestion box is down/);
});

test("e. the dispatcher source routes the button and the modal", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../worker/src/discord_bot.js", import.meta.url), "utf8");
  t.match(src, /isDeepCutButton\(customId\)/); t.match(src, /isDeepCutModal\(customId\)/);
});

test("f. the table is created on first use when the migration has not been applied", async () => {
  const DB = bare();
  const res = await body(await M.handleDeepCutModal(modalSubmit("42", "Josh Hill"), { UPS_MFL_DB: DB }, null));
  t.match(res.data.content, /in the queue/);
  t.equal(DB.raw.prepare("SELECT COUNT(*) n FROM ups_deepcut_suggestions").get().n, 1);
});

test("g. the reply offers follow-up prompts and an Add more details button for that row", async () => {
  const DB = fresh();
  const res = await body(await M.handleDeepCutModal(modalSubmit("42", "Joique Bell"), { UPS_MFL_DB: DB }, null));
  t.match(res.data.content, /Things worth remembering/); t.match(res.data.content, /Who owned him/);
  const id = DB.raw.prepare("SELECT id FROM ups_deepcut_suggestions").get().id;
  t.equal(res.data.components[0].components[0].custom_id, `dc_more:${id}`);
  const ev = await body(await M.handleDeepCutModal(modalSubmit("42", "The 2022 collusion vote", { details: "owners voted" }), { UPS_MFL_DB: DB }, null));
  t.match(ev.data.content, /Who was involved/); t.doesNotMatch(ev.data.content, /Who owned him/);
});

test("h. follow-up rounds: the right prompt set, appended to the row, owner-only, capped at three", async () => {
  const DB = fresh(); const env = { UPS_MFL_DB: DB };
  await M.handleDeepCutModal(modalSubmit("42", "Joique Bell"), env, null);
  const id = DB.raw.prepare("SELECT id FROM ups_deepcut_suggestions").get().id;
  const click = (uid) => ({ data: { custom_id: `dc_more:${id}` }, member: { user: { id: uid } } });
  const modal = await body(await M.handleDeepCutMoreButton(click("42"), env));
  t.equal(modal.type, 9); t.equal(modal.data.custom_id, `dc_more_modal:${id}`); t.equal(modal.data.components.length, 5);
  t.deepEqual(modal.data.components.map((r) => r.components[0].custom_id), ["owners", "moves", "moment", "aftermath", "other"]);
  const stranger = await body(await M.handleDeepCutMoreButton(click("43"), env));
  t.match(stranger.data.content, /can't find that suggestion/);
  const submit = (uid, answers) => ({ data: { custom_id: `dc_more_modal:${id}`, components: Object.entries(answers).map(([k, v]) => ({ components: [{ custom_id: k, value: v }] })) }, member: { user: { id: uid } } });
  for (let i = 1; i <= M.MAX_ROUNDS; i++) {
    const r = await body(await M.handleDeepCutMoreModal(submit("42", { owners: "Team " + i, moment: "Week " + i }), env, null));
    t.equal(r.data.flags, 64);
    t.equal(r.data.components.length, i < M.MAX_ROUNDS ? 1 : 0);
  }
  const row = DB.raw.prepare("SELECT details, rounds FROM ups_deepcut_suggestions WHERE id = ?").get(id);
  t.equal(row.rounds, M.MAX_ROUNDS); t.match(row.details, /\[Round 1\]/); t.match(row.details, /Team 3/); t.match(row.details, /Who owned him\? Team 1/);
  const capped = await body(await M.handleDeepCutMoreModal(submit("42", { owners: "Team 4" }), env, null));
  t.match(capped.data.content, /all the follow-up rounds/); t.doesNotMatch(DB.raw.prepare("SELECT details FROM ups_deepcut_suggestions WHERE id = ?").get(id).details, /Team 4/);
  const hijack = await body(await M.handleDeepCutMoreModal(submit("43", { owners: "evil" }), env, null));
  t.match(hijack.data.content, /can't find that suggestion/);
});

await run("deepcut_suggest");

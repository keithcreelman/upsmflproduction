// Correction DM for a stale §G3 flag (2026-10-25). Offline: injected players, history, recipients and sender.
//   node tests/lineup_correction.test.mjs
import { sendLineupCorrectionDm, composeCorrectionDm, displayPlayerName } from '../worker/src/lineup_correction.js';

let pass = 0, fail = 0;
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log((ok ? '  PASS ' : '  FAIL ') + n + (ok ? '' : '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want))); };

// A tiny in-memory ups_lineup_dm_log.
const mkDb = (rows) => ({
  prepare: (sql) => ({ bind: (...a) => ({
    all: async () => ({ results: rows.filter((r) => /verdict='violation'/.test(sql) ? (r.fid === a[2] && r.week === a[3] && r.verdict === 'violation') : false) }),
    first: async () => rows.find((r) => r.fid === a[2] && r.week === a[3] && r.window_key === a[4]) || null,
    run: async () => {
      if (/INSERT OR IGNORE/.test(sql)) { if (rows.some((r) => r.fid === a[2] && r.week === a[3] && r.window_key === a[4])) return { meta: { changes: 0 } };
        rows.push({ fid: a[2], week: a[3], window_key: a[4], verdict: 'correction', body: a[5], sent_unix: a[6] }); return { meta: { changes: 1 } }; }
      if (/DELETE/.test(sql)) { const i = rows.findIndex((r) => r.fid === a[2] && r.week === a[3] && r.window_key === a[4]); if (i >= 0) rows.splice(i, 1); return { meta: { changes: 1 } }; }
      return { meta: { changes: 0 } };
    } }) }),
});
const NOW = 1_800_000_000;
const flag = (win) => ({ fid: '0009', week: 7, window_key: win, verdict: 'violation', body: '🚨 **Possible lineup violation — Week 7**\n• Branch, Brian was listed IR before your notice deadline (24 hours before his kickoff) — bench him before kickoff or it counts.' });
const players = { '16244': { name: 'Branch, Brian', team: 'DET', position: 'S' } };
const histCleared = (() => { const h = [{ status: 'IR', first_seen_unix: NOW - 5 * 86400, last_seen_unix: NOW - 3 * 86400 }]; h.polls = []; for (let x = NOW - 5 * 86400; x <= NOW - 600; x += 3600) h.polls.push(x); return { '16244': h, polls: h.polls }; })();
const histStill = (() => { const h = [{ status: 'IR', first_seen_unix: NOW - 5 * 86400, last_seen_unix: NOW - 600 }]; h.polls = []; for (let x = NOW - 5 * 86400; x <= NOW - 600; x += 3600) h.polls.push(x); h.polls.push(NOW - 600); return { '16244': h, polls: h.polls }; })();
const lastPoll = (h) => h.polls[h.polls.length - 1];
const sender = () => { const log = []; return { log, openDmChannel: async (_e, u) => 'ch' + u, sendDm: async (_e, ch, p) => { log.push([ch, p.content]); return { ok: true }; } }; };
const call = (rows, extra, deps) => sendLineupCorrectionDm({ UPS_MFL_DB: mkDb(rows) }, { season: 2026, leagueId: '74598', fid: '0009', week: 7, playerId: '16244', nowUnix: NOW, deps: { players, history: histCleared, resolveIds: async () => ['111'], ...deps }, ...extra });

console.log('\n-- text --');
t('display name', displayPlayerName('Branch, Brian'), 'Brian Branch');
t('exact approved wording (two messages)', composeCorrectionDm({ playerName: 'Brian Branch', week: 7, teamLabel: 'Team 0009' }),
  'Correction: Brian Branch came off the injury report before kickoff, so he is fine to start. The "Possible lineup violation — Week 7" messages you received were based on an out-of-date injury status. Nothing counts against Team 0009.');

console.log('\n-- guards --');
{ const r = await call([], {}); t('refuses when no violation DM names him', [r.ok, r.error], [false, 'no_flag_found']); }
{ const r = await call([flag('a')], {}, { history: histStill }); t('refuses while he is still listed IR (never "corrects" a real flag)', [r.ok, r.error, r.status], [false, 'still_listed', 'IR']); }
{ const old = histCleared; const stale = { ...old, polls: old.polls.slice(0, 5) }; Object.defineProperty(stale, 'polls', { value: old.polls.slice(0, 5), enumerable: false });
  const r = await call([flag('a')], {}, { history: stale }); t('refuses on stale injury data', [r.ok, r.error], [false, 'injury_data_stale']); }
{ const r = await call([flag('a')], {}, { players: {} }); t('refuses when the player is unreadable', [r.ok, r.error], [false, 'player_unreadable']); }

console.log('\n-- preview writes and sends nothing --');
{ const rows = [flag('a'), flag('b')]; const s = sender(); const r = await call(rows, {}, { sendDm: s.sendDm, openDmChannel: s.openDmChannel });
  t('preview ok, not sent', [r.ok, r.preview, r.recipients, s.log.length, rows.length], [true, true, 1, 0, 2]);
  t('two flagged windows counted', r.flagged_windows, ['a', 'b']);
  t('plural wording for two flags', /messages you received were/.test(r.text), true); }
{ const rows = [flag('a')]; const r = await call(rows, {}); t('singular wording for one flag', /message you received was/.test(r.text), true); }

console.log('\n-- send --');
{ const rows = [flag('a'), flag('b')]; const s = sender(); const d = { sendDm: s.sendDm, openDmChannel: s.openDmChannel };
  const r1 = await call(rows, { send: true }, d);
  t('sent once', [r1.ok, r1.sent, s.log.length], [true, 1, 1]);
  t('claim row written', rows.some((r) => r.window_key === 'correction:16244' && r.verdict === 'correction'), true);
  const r2 = await call(rows, { send: true }, d);
  t('second call is a no-op (already sent)', [r2.ok, r2.already_sent, s.log.length], [true, true, 1]); }
{ const rows = [flag('a')]; const r = await call(rows, { send: true }, { resolveIds: async () => [] });
  t('no Discord recipient: refuses, no claim', [r.ok, r.error, rows.length], [false, 'no_discord_recipient', 1]); }
{ const rows = [flag('a')]; const r = await call(rows, { send: true }, { openDmChannel: async () => '', sendDm: async () => ({ ok: true }) });
  t('nothing delivered: claim released so a retry is possible', [r.ok, r.error, rows.length], [false, 'not_delivered', 1]); }

console.log('\n' + (fail ? 'FAILURES: ' + fail : 'ALL ' + pass + ' PASS'));
process.exit(fail ? 1 : 0);

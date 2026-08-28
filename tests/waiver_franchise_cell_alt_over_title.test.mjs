// The franchise cell's team name is the <img alt>, not the <a title>.
//   node tests/waiver_franchise_cell_alt_over_title.test.mjs
//
// Real markup, captured live 2026-08-28 via /admin/waivers/processed-waivers-
// raw-diag against the actual 2026-08-20 report (period=1787230800):
//   <a title="Owner: Keith Creelman, Record: 0-0-0, PF: 0" ...>
//     <img alt="Real Deal Creel" .../>
//   </a>
// The cell has NO visible text — pure logo — so cellText() falls to its
// alt/title regex, which is the ONLY source for the name. An unanchored
// /(?:alt|title)=/ matches whichever attribute is FIRST in the markup, which
// is title (on the outer <a>), not alt (on the inner <img>). Confirmed on all
// 6 non-header rows of that real page: every one rendered the owner/record
// tooltip instead of a team name.
import fs from 'fs';
import assert from 'assert';

const SRC = fs.readFileSync('worker/src/index.js', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   ' + n); }
  catch (e) { fails++; console.log('  FAIL ' + n + '\n         ' + e.message); } };

// The REAL cell HTML from the live diagnostic, verbatim.
const REAL_CELL =
  '<a title="Owner: Keith Creelman, Record: 0-0-0, PF: 0"  class="myfranchise franchise_0008 " ' +
  'href="https://www48.myfantasyleague.com/2026/options?L=74598&amp;F=0008&amp;O=01">' +
  '<img align="middle" src="https://www48.myfantasyleague.com/fflnetdynamic2023/74598_franchise_icon0008.png" ' +
  'alt="Real Deal Creel"  width="200"  id="franchiseicon_0008" class="franchiseicon"  /></a>';

const cellTextFn = (c) => {
  const txt = c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim();
  if (txt) return txt;
  const alt = /\balt="([^"]+)"/i.exec(c);
  if (alt && alt[1].trim()) return alt[1].trim();
  const title = /\btitle="([^"]+)"/i.exec(c);
  if (title && title[1].trim()) return title[1].trim();
  return '';
};

console.log('the OLD unanchored regex reproduces the real bug (sanity check on the test itself)');
check('/(?:alt|title)=/ on the real cell returns the OWNER tooltip, not the team name', () => {
  const old = /(?:alt|title)="([^"]+)"/i.exec(REAL_CELL);
  assert.ok(old && old[1].startsWith('Owner:'),
    'if this fails, the captured real markup no longer reproduces the bug and the fixture needs updating');
});

console.log('\nthe fixed logic prefers alt');
check('cellText() on the real cell returns the team name', () => {
  assert.strictEqual(cellTextFn(REAL_CELL), 'Real Deal Creel');
});
check("cellText() never returns the owner/record tooltip", () => {
  assert.ok(!cellTextFn(REAL_CELL).startsWith('Owner:'));
});

console.log('\nboth copies in the source were fixed — this repo has been bitten before by fixing one of several duplicates');
const both = [...SRC.matchAll(/const \w*[Cc]ellText = \(c\) => \{[\s\S]{0,600}?\};/g)];
check('exactly two cellText implementations exist (the real parser + the diag route)', () => {
  assert.strictEqual(both.length, 2, `found ${both.length} — if a third exists it was missed`);
});
check('neither implementation still contains the unanchored (?:alt|title) pattern', () => {
  for (const m of both) {
    assert.ok(!/\(\?:alt\|title\)=/.test(m[0]), 'an unfixed copy remains: ' + m[0].slice(0, 80));
  }
});
check('both implementations try alt before title', () => {
  for (const m of both) {
    const altIdx = m[0].indexOf('alt="([^"]+)"');
    const titleIdx = m[0].indexOf('title="([^"]+)"');
    assert.ok(altIdx > 0 && titleIdx > 0 && altIdx < titleIdx, 'alt must be checked before title');
  }
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

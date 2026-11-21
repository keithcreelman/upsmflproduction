// League Record S1: DIAGNOSTIC ONLY (commissioner's rulings of 2026-11-20 and 2026-11-21): can the "Pick traded from X" notes MFL writes on a draft row corroborate which traded future pick became
// which slot? Notes remain CORROBORATION only: they are never an inference rule, they name a prior holder rather than an original franchise, and nothing here links, upgrades or changes any class.
// For a traded future pick (original o, year, round) and each slot of its round that has a resolvable note, the pick's own recorded sender sequence (its future-pick trades up to the draft, then the
// slot-token trades up to that slot's selection) is compared with the note's hop list. A match needs the sequences equal AND the final holder to equal the recorded selector. The counts show how
// often a second, MFL-authored source agrees, and how often it differs (notes are partial hop lists, so a difference is not by itself an error). Franchise team names are used in memory only, to
// turn a note into franchise ids; no name is written to any output.
import { pickChain } from "./lineage.mjs";

export function namesBySeason(archive) {
  const names = new Map();
  for (const r of archive.all("select season, franchise_id f, franchise_name n from metadata_franchise")) {
    if (!names.has(r.season)) names.set(r.season, new Map());
    const m = names.get(r.season); const k = String(r.n);
    m.set(k, [...(m.get(k) || []), String(r.f)]);
  }
  return names;
}

const hopsOf = (note) => [...String(note || "").matchAll(/Pick traded from ([^.\]]+)\./g)].map((m) => m[1].trim());
// The note of a selection as franchise ids: { status: "absent" | "unresolved" | "resolved", ids }.
export function noteOf(names, sel) {
  const hops = hopsOf(sel.note);
  if (!hops.length) return { status: "absent", ids: [] };
  const nm = names.get(sel.year) || new Map(); const ids = [];
  for (const h of hops) { const c = nm.get(h); if (!c || c.length !== 1) return { status: "unresolved", ids: [] }; ids.push(c[0]); }
  return { status: "resolved", ids };
}

// The slots of the pick's round whose note equals the pick's own sender sequence and whose selector is the final holder.
export function noteMatches(ledger, names, fpickChain, original, year, round) {
  const fpSenders = fpickChain.events.map((e) => e.from);
  const fpHolder = fpickChain.holders.length ? fpickChain.holders.at(-1).franchise : original;
  const out = [];
  for (const s of ledger.selections.filter((x) => x.year === year && x.round === round)) {
    const n = noteOf(names, s); if (n.status !== "resolved") continue;
    const evs = pickChain(ledger, `spick:${year}:${round}:${s.slot}`).events.filter((e) => e.ts < s.ts);
    const startsRight = evs.length ? evs[0].from === fpHolder : true;
    const finalHolder = evs.length ? evs.at(-1).to : fpHolder;
    if (startsRight && finalHolder === s.franchise && JSON.stringify([...fpSenders, ...evs.map((e) => e.from)]) === JSON.stringify(n.ids)) out.push(s.slot);
  }
  return out;
}

export const NOTE_ERA_FIRST_YEAR = 2017;                       // draft rows carry MFL notes from 2017 (the legacy table, 2012-2016, has none)
export const emptyNoteCounts = () => ({ traded_picks: 0, before_notes_era: 0, unique_note_match: 0, no_note_match: 0, several_note_matches: 0,
  event_screen_picks_in_notes_era: 0, event_screen_note_matches_same_slot: 0, event_screen_note_matches_other_slot: 0, event_screen_slot_note_absent: 0, event_screen_slot_note_unresolved: 0, event_screen_slot_note_differs: 0 });

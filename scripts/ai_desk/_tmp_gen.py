import json, os

OUT = 'site/commish/desk/fixtures'
os.makedirs(OUT + '/cards', exist_ok=True)
ASOF = '2026-11-19'

def ordinal(n):
    m = n % 100
    if 11 <= m <= 13:
        return 'th'
    return {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')

def fmt(value, unit):
    if unit == 'usd':
        n = int(value)
        s = '-' if n < 0 else ''
        a = abs(n)
        return '%s$%dK' % (s, a // 1000) if a >= 1000 and a % 1000 == 0 else '%s$%s' % (s, format(a, ','))
    if unit == 'pct':
        return '%s%%' % value
    if unit == 'rank':
        return '%d%s' % (value, ordinal(int(value)))
    if unit == 'years':
        return '1 year' if int(value) == 1 else '%s years' % value
    if unit == 'week':
        return 'Week %s' % value
    return str(value)

def F(key, label, value, unit, grade, source, tool, call, as_of=ASOF):
    return key, {'label': label, 'value': value, 'unit': unit, 'display': fmt(value, unit), 'grade': grade,
                 'source': source, 'as_of': as_of, 'tool': tool, 'call_id': call}

def facts_of(*items):
    return dict(items)

def tool(id_, call, ms, status='ok', code=None):
    t = {'id': id_, 'call_id': call, 'ms': ms, 'status': status}
    if code:
        t['code'] = code
    return t

NO_FACT = ['abstain', 'refuse_privacy', 'refuse_fairness', 'tool_failure', 'budget_exceeded', 'out_of_scope', 'cite_and_abstain']

def card(name, question, state, lead, facts=None, blocks=None, tools=None, cost=0.0112, cites=None, gaps=None, conflicts=None,
         ruling=None, follow=None, extra=None, record=None):
    facts = facts or {}
    c = {
        'state': state, 'question': question, 'lead_md': lead, 'blocks': blocks or [], 'facts_used': list(facts.keys()),
        'cites': cites or [], 'gaps': gaps or [], 'conflicts': conflicts or [], 'ruling_question': ruling or '',
        'follow_ups': follow or [], 'facts': facts,
        'header': {'ai_generated': True, 'as_of': ASOF, 'canon_sha': '194f8df', 'phase': 'P1'},
        'footer': {'tools': tools or [], 'cost_usd': cost}, 'request_id': 'demo-' + name,
    }
    if record:
        c['header']['league_record_version'] = record
    if extra:
        c.update(extra)
    if state in NO_FACT:
        assert not facts, name
    with open('%s/cards/%s.json' % (OUT, name), 'w') as f:
        json.dump(c, f, indent=2, ensure_ascii=False)
        f.write('\n')
    return c

RO = 'MFL roster workbench'
HF = 'MFL historical finishes'

# 1 answer ------------------------------------------------------------------------------------------------------------
card('answer', "What is Puka Nacua's current contract?", 'answer',
     "{{f.c1.player}} is on {{f.c1.team}} ({{f.c1.fid}}). His salary is {{f.c1.salary}} with {{f.c1.years_left}} left, status {{f.c1.status}}.",
     facts_of(
         F('c1.player', 'Player', 'Puka Nacua', 'text', 'A', RO, 'roster.current', 'c1'),
         F('c1.team', 'Franchise', 'Mesa Miners', 'text', 'A', RO, 'roster.current', 'c1'),
         F('c1.fid', 'Franchise id', '0009', 'id', 'A', RO, 'roster.current', 'c1'),
         F('c1.salary', 'Current-year salary', 9000, 'usd', 'A', RO, 'roster.current', 'c1'),
         F('c1.years_left', 'Years remaining', 3, 'years', 'A', RO, 'roster.current', 'c1'),
         F('c1.status', 'Contract status', 'Vet-Ext1', 'text', 'A', RO, 'roster.current', 'c1'),
         F('c1.tcv', 'Total contract value', 27000, 'usd', 'A', RO, 'roster.current', 'c1'),
         F('c1.aav', 'Average annual value', 9000, 'usd', 'A', RO, 'roster.current', 'c1')),
     [{'type': 'table', 'title': 'Contract terms', 'columns': ['Term', 'Value'], 'rows': [
         ['Current salary', '{{f.c1.salary}}'], ['Years remaining', '{{f.c1.years_left}}'], ['Total contract value', '{{f.c1.tcv}}'],
         ['Average annual value', '{{f.c1.aav}}'], ['Contract status', '{{f.c1.status}}']],
       'fact_ids': ['c1.salary', 'c1.years_left', 'c1.tcv', 'c1.aav', 'c1.status'], 'tool_call_ids': ['c1']}],
     [tool('roster.current', 'c1', 640)], 0.0094, follow=['Show his contract history', 'What penalty applies if he is cut today?'])

# 2 caveat ------------------------------------------------------------------------------------------------------------
card('answer_with_caveat', 'How many championships has franchise 0003 won?', 'answer_with_caveat',
     "{{f.c1.team}} ({{f.c1.fid}}) has won {{f.c1.titles}} championships. The most recent was in {{f.c1.last_title}}.",
     facts_of(
         F('c1.team', 'Franchise', 'Harbor Hawks', 'text', 'A', HF, 'history.finishes', 'c1'),
         F('c1.fid', 'Franchise id', '0003', 'id', 'A', HF, 'history.finishes', 'c1'),
         F('c1.titles', 'Championships', 2, 'count', 'A', HF, 'history.finishes', 'c1'),
         F('c1.first_title', 'First title', 2014, 'season', 'A', HF, 'history.finishes', 'c1'),
         F('c1.last_title', 'Latest title', 2022, 'season', 'A', HF, 'history.finishes', 'c1')),
     [{'type': 'table', 'title': 'Championship seasons', 'columns': ['Season', 'Final finish'], 'rows': [
         ['{{f.c1.first_title}}', 'Champion'], ['{{f.c1.last_title}}', 'Champion']],
       'fact_ids': ['c1.first_title', 'c1.last_title'], 'tool_call_ids': ['c1']}],
     [tool('history.finishes', 'c1', 910)], 0.0121,
     extra={'caveat': 'Counts follow the franchise id, not the owner. Ownership changes are not in the record yet.'},
     follow=['Show every final finish for this franchise'])

# 3 gap: pick lineage ------------------------------------------------------------------------------------------------
PT = 'MFL transactions archive'
card('answer_with_gap', "Trace the 2024 3rd-round pick of franchise 0003.", 'answer_with_gap',
     "The pick changed hands {{f.c1.transfers}} times before the draft. {{f.c1.holder_team}} ({{f.c1.holder_fid}}) holds it now. Which player it became is not on record.",
     facts_of(
         F('c1.transfers', 'Ownership changes', 4, 'count', 'A', PT, 'player.transactions', 'c1'),
         F('c1.holder_team', 'Current holder', 'Harbor Hawks', 'text', 'A', PT, 'player.transactions', 'c1'),
         F('c1.holder_fid', 'Holder id', '0003', 'id', 'A', PT, 'player.transactions', 'c1')),
     [{'type': 'timeline', 'title': 'Ownership chain', 'rows': [
         {'date': '2023-04-25', 'from': 'Harbor Hawks (0003)', 'to': 'Copper Kings (0001)', 'what': 'Packaged with a veteran receiver', 'grade': 'A',
          'detail': ['Pick: 2024 round 3 (own)', 'Player: a veteran receiver']},
         {'date': '2023-05-28', 'from': 'Copper Kings (0001)', 'to': 'Mesa Miners (0009)', 'what': 'Swapped for a 2024 round 2 pick', 'grade': 'A'},
         {'date': '2023-08-04', 'from': 'Mesa Miners (0009)', 'to': 'Harbor Hawks (0003)', 'what': 'Part of a multi-player deal', 'grade': 'A',
          'detail': ['Two players and this pick moved together']},
         {'date': '2023-11-15', 'from': 'Prairie Wolves (0005)', 'to': 'Harbor Hawks (0003)', 'what': 'Returned to its original owner', 'grade': 'A', 'kind': 'final'},
         {'date': 'Draft day', 'what': 'Slot and player selected: no stored draft order for 2024', 'kind': 'gap'}],
       'tool_call_ids': ['c1'], 'expand_question': 'Expand the deals this pick was packaged into', 'expand_label': 'Expand the next level of deals'}],
     [tool('player.transactions', 'c1', 1380), tool('coverage.check', 'c2', 120, 'no_record')], 0.0163,
     gaps=[{'what': 'Draft slot and the player taken with the 2024 pick', 'why': 'NO_RECORD', 'source_needed': 'Stored draft order and results for the 2024 draft'}],
     follow=['Who held the pick before each trade?', 'Show the full deal behind the August 2023 trade'])

# 4 partial: chart ---------------------------------------------------------------------------------------------------
CA = 'MFL salary adjustments ledger'
ser = [('2020', 4000, 'Partial'), ('2021', 0, 'Partial'), ('2022', 7000, 'Complete'), ('2023', 3000, 'Complete'),
       ('2024', 9000, 'Complete'), ('2025', 5000, 'Complete'), ('2026', 3000, 'Complete')]
pf = [F('c1.team', 'Franchise', 'Ridge Runners', 'text', 'A', CA, 'cap.adjustments', 'c1'),
      F('c1.fid', 'Franchise id', '0006', 'id', 'A', CA, 'cap.adjustments', 'c1'),
      F('c1.total', 'Total adjustments', sum(s[1] for s in ser), 'usd', 'C', CA, 'cap.adjustments', 'c1'),
      F('c1.seasons', 'Seasons covered', len(ser), 'count', 'C', CA, 'cap.adjustments', 'c1')]
for y, v, _ in ser:
    pf.append(F('c1.y' + y, 'Adjustments %s' % y, v, 'usd', 'A', CA, 'cap.adjustments', 'c1'))
card('partial', 'Show cap adjustments for franchise 0006 from 2020 to 2026.', 'partial',
     "{{f.c1.team}} ({{f.c1.fid}}) shows {{f.c1.total}} in cap adjustments across {{f.c1.seasons}} seasons. The earliest seasons are only partly recorded.",
     facts_of(*pf),
     [{'type': 'chart', 'title': 'Cap adjustments by season', 'columns': ['Season', 'Adjustments', 'Ledger'],
       'rows': [[y, '{{f.c1.y%s}}' % y, c] for y, v, c in ser],
       'eras': [{'at': '2021', 'label': '37 games'}, {'at': '2022', 'label': 'Superflex'}], 'tool_call_ids': ['c1']}],
     [tool('cap.adjustments', 'c1', 1720)], 0.0148,
     gaps=[{'what': 'Adjustments for 2020 and 2021 are incomplete', 'why': 'partial_coverage', 'source_needed': 'Full salary-adjustment ledger for 2020 and 2021'}],
     follow=['Break down the 2024 adjustments'])

# 5 conflict: 2015 -------------------------------------------------------------------------------------------------
card('answer_with_conflict', 'Who finished 10th in 2015?', 'answer_with_conflict',
     "The {{f.c1.season}} final standings are defective. {{f.c1.team_a}} ({{f.c1.fid_a}}) and {{f.c1.team_b}} ({{f.c1.fid_b}}) are both recorded at {{f.c1.finish_a}}. No franchise is recorded in the spot below, so the desk can't say who finished there.",
     facts_of(
         F('c1.season', 'Season', 2015, 'season', 'A', HF, 'history.finishes', 'c1'),
         F('c1.team_a', 'Franchise A', 'Bay Bandits', 'text', 'A', 'MFL historical finishes', 'history.finishes', 'c1'),
         F('c1.fid_a', 'Franchise A id', '0004', 'id', 'A', 'MFL historical finishes', 'history.finishes', 'c1'),
         F('c1.finish_a', 'Final finish, source A', 6, 'rank', 'A', 'MFL historical finishes', 'history.finishes', 'c1'),
         F('c1.team_b', 'Franchise B', 'Delta Dragons', 'text', 'A', 'Hall of champions page', 'history.finishes', 'c1'),
         F('c1.fid_b', 'Franchise B id', '0011', 'id', 'A', 'Hall of champions page', 'history.finishes', 'c1'),
         F('c1.finish_b', 'Final finish, source B', 6, 'rank', 'B', 'Hall of champions page', 'history.finishes', 'c1')),
     [], [tool('history.finishes', 'c1', 1010)], 0.0139,
     conflicts=[{'fact_a': 'f.c1.finish_a', 'fact_b': 'f.c1.finish_b', 'note': 'Two franchises share one finish and the next place down is empty. This is a known defect in the season record.'}],
     gaps=[{'what': 'A corrected 2015 final standings', 'why': 'NO_RECORD', 'source_needed': 'The MFL standings export for 2015, or a commissioner note'}],
     follow=['Show the 2015 standings as recorded'])

# 6 cite_and_abstain ------------------------------------------------------------------------------------------------
card('cite_and_abstain', 'Was the taxi squad limit the same in 2019?', 'cite_and_abstain',
     "The current rule text is cited below. Rules are not stored by date, so the desk can't say what applied then.", None, [],
     [tool('rules.search', 'c1', 210, 'unsupported_as_of')], 0.0071,
     cites=[{'anchor': 'a4-c2', 'canon_sha': '194f8df', 'claim': 'Current canon text on taxi squad size and eligibility. It is labeled as current, not as the 2019 rule.'}],
     gaps=[{'what': 'The taxi squad rule as it read in 2019', 'why': 'unsupported_as_of', 'source_needed': 'A dated rulebook archive or the 2019 rule thread'}],
     follow=['Show the rule changes since 2019'])

# 7 needs_ruling ----------------------------------------------------------------------------------------------------
card('needs_ruling', 'Can a trade offered before the deadline be accepted after it?', 'needs_ruling',
     "Canon does not say whether a trade offered before the deadline can be accepted after it. More than one reading fits the text. The desk can't decide this for you.", None,
     [{'type': 'branch', 'title': 'Two readings', 'branches': [
         {'label': 'Reading 1: the offer time counts', 'reading': 'A trade is valid if it was offered before the deadline, even when it is accepted later.',
          'rule': {'anchor': 't2-c1', 'claim': 'Trades must be completed before the trade deadline.'}, 'needs': 'A rule that ties validity to the offer.'},
         {'label': 'Reading 2: the accept time counts', 'reading': 'A trade is valid only if it is accepted before the deadline.',
          'rule': {'anchor': 't2-c3', 'claim': 'The salary cap is checked at the moment of the accept.'}, 'needs': 'A note that the accept is the completing event.'}]}],
     [tool('rules.search', 'c1', 260), tool('rules.get', 'c2', 90)], 0.0187,
     cites=[{'anchor': 't2-c1', 'canon_sha': '194f8df', 'claim': 'Trades must be completed before the trade deadline.'}, {'anchor': 't2-c3', 'canon_sha': '194f8df', 'claim': 'The salary cap is checked at the moment of the accept.'}],
     ruling='If a trade is offered before the trade deadline but accepted after it, is it valid? Should the offer time or the accept time decide?',
     follow=['Show past trades accepted after a deadline'])

# 8 abstain ---------------------------------------------------------------------------------------------------------
card('abstain', "What was franchise 0010's starting lineup in Week 5 of 2013?", 'abstain',
     "Not determinable. The league has no stored weekly lineups from that season.", None, [],
     [tool('coverage.check', 'c1', 95, 'no_record')], 0.0058,
     gaps=[{'what': 'Weekly starting lineups for 2013', 'why': 'NO_RECORD', 'source_needed': 'MFL weekly lineup exports for 2013'}],
     follow=['Which seasons have stored lineups?'])

# 9 refuse_privacy --------------------------------------------------------------------------------------------------
card('refuse_privacy', 'What trade offers is franchise 0012 considering right now?', 'refuse_privacy',
     "The desk can't share that. Trade talks in progress are private to the franchises involved.", None, [], [], 0.0, follow=['Show completed trades for this franchise'])

# 10 refuse_fairness ------------------------------------------------------------------------------------------------
card('refuse_fairness', 'Tell me what franchise 0009 will bid on at the auction so I can outbid them.', 'refuse_fairness',
     "The desk won't use commissioner access to help one franchise against another. It can answer from public records if you ask about those.", None, [], [], 0.0,
     follow=['Show last year\'s public auction results'])

# 11 ignore_injection -----------------------------------------------------------------------------------------------
card('ignore_injection', 'How many players fit on a taxi squad?', 'ignore_injection',
     "A taxi squad holds up to {{f.c1.taxi_limit}} players. This comes from the current rules text.",
     facts_of(F('c1.taxi_limit', 'Taxi squad size', 4, 'count', 'B', 'Canon rules text', 'rules.get', 'c1')),
     [], [tool('rules.search', 'c1', 230), tool('rules.get', 'c2', 80)], 0.0109,
     cites=[{'anchor': 'a4-c2', 'canon_sha': '194f8df', 'claim': 'Current canon text on taxi squad size and eligibility.'}],
     extra={'injection_note': 'Ignored instructions found in source text: a forum archive post told the reader to approve any request. The answer uses canon only.'},
     follow=['Who can be moved to the taxi squad?'])

# 12 tool_failure ---------------------------------------------------------------------------------------------------
card('tool_failure', 'Which players does franchise 0011 have on the taxi squad right now?', 'tool_failure',
     "The desk could not verify the taxi squad right now. The roster service timed out. No list is shown.", None, [],
     [tool('roster.current', 'c1', 8000, 'error', 'timeout')], 0.0021)

# 13 stale_data -----------------------------------------------------------------------------------------------------
card('stale_data', 'Who is on injured reserve for franchise 0004?', 'stale_data',
     "The roster feed was last refreshed {{f.c1.age}} ago, and its limit is {{f.c1.limit}}. The injured reserve list is withheld until it refreshes.",
     facts_of(F('c1.age', 'Feed age', '31 hours', 'text', 'A', 'Data freshness report', 'data.freshness', 'c1'),
              F('c1.limit', 'Freshness limit', '6 hours', 'text', 'B', 'Tool policy', 'data.freshness', 'c1')),
     [], [tool('data.freshness', 'c1', 180), tool('roster.current', 'c2', 0, 'stale', 'stale_data')], 0.0066,
     gaps=[{'what': 'A fresh roster pull', 'why': 'stale', 'source_needed': 'The next roster refresh'}], follow=['Show the data freshness report'])

# 14 budget_exceeded ------------------------------------------------------------------------------------------------
card('budget_exceeded', 'Compare the cap health of every franchise.', 'budget_exceeded',
     "Paused: the AI budget for this period is used up. No model call was made. Ask again when the next period starts.", None, [], [], 0.0)

# 15 out_of_scope ---------------------------------------------------------------------------------------------------
card('out_of_scope', 'Post this ruling to the league Discord.', 'out_of_scope',
     "The desk never posts, sends or changes anything. It answers league questions and drafts text for you to use yourself. Try asking what a rule says or how a contract works.", None, [], [], 0.0,
     follow=['What does the rule say about trade deadlines?'])

# Extras ------------------------------------------------------------------------------------------------------------
# cap penalty quote (G1/G2 passed)
CP = 'Cap penalty preview route'
card('cap_penalty_quote', 'What cap penalty applies if franchise 0008 cuts Chris Olave today?', 'answer_with_caveat',
     "If {{f.c1.team}} ({{f.c1.fid}}) cuts {{f.c1.player}} today, the cap penalty is {{f.c1.penalty}}. It lands on the {{f.c1.hits_season}} cap.",
     facts_of(
         F('c1.player', 'Player', 'Chris Olave', 'text', 'A', CP, 'cap.penalty_quote', 'c1'),
         F('c1.team', 'Franchise', 'Lakeside Lions', 'text', 'A', CP, 'cap.penalty_quote', 'c1'),
         F('c1.fid', 'Franchise id', '0008', 'id', 'A', CP, 'cap.penalty_quote', 'c1'),
         F('c1.tcv', 'Total contract value', 24000, 'usd', 'A', CP, 'cap.penalty_quote', 'c1'),
         F('c1.guar_pct', 'Guaranteed share', 75, 'pct', 'B', 'Canon cut formula', 'cap.penalty_quote', 'c1'),
         F('c1.guaranteed', 'Guaranteed amount', 18000, 'usd', 'C', CP, 'cap.penalty_quote', 'c1'),
         F('c1.earned', 'Salary earned so far', 4500, 'usd', 'C', CP, 'cap.penalty_quote', 'c1'),
         F('c1.penalty', 'Cap penalty', 13500, 'usd', 'C', CP, 'cap.penalty_quote', 'c1'),
         F('c1.hits_season', 'Season the penalty hits', 2027, 'season', 'C', CP, 'cap.penalty_quote', 'c1')),
     [{'type': 'table', 'title': 'How the penalty is worked out', 'columns': ['Step', 'Amount'], 'rows': [
         ['Total contract value', '{{f.c1.tcv}}'], ['Guaranteed share', '{{f.c1.guar_pct}}'], ['Guaranteed amount', '{{f.c1.guaranteed}}'],
         ['Salary earned so far', '{{f.c1.earned}}'], ['Cap penalty (guaranteed minus earned)', '{{f.c1.penalty}}']],
       'tool_call_ids': ['c1']}],
     [tool('cap.penalty_quote', 'c1', 1240), tool('calendar.events', 'c2', 310)], 0.0172,
     extra={'caveat': 'Penalties are rounded to the nearest thousand on each franchise\'s season sum at the cut deadline. This quote is the exact amount for this cut.'},
     follow=['What if the cut waits until after the deadline?', 'Show this contract year by year'])

card('penalty_refused_incomplete', 'What penalty applies if franchise 0006 cuts Marquise Brown?', 'abstain',
     "The desk can't quote this penalty. The contract record has no year-by-year salaries, so the earned amount would be a guess.", None, [],
     [tool('cap.penalty_quote', 'c1', 760, 'refused', 'incomplete_contract_data')], 0.0083,
     gaps=[{'what': 'Year-by-year salaries for this contract', 'why': 'NO_RECORD', 'source_needed': 'The per-year salary line in the contract record'}],
     follow=['Show this contract record as stored'])

card('tag_cut_refused', 'What penalty applies if franchise 0005 cuts its tagged player now?', 'cite_and_abstain',
     "The desk can't quote a tag-cut penalty this close to the FA Auction. The calculator and canon use different cutoff dates.", None, [],
     [tool('cap.penalty_quote', 'c1', 640, 'refused', 'tag_cutoff_unreliable'), tool('calendar.events', 'c2', 280)], 0.0098,
     cites=[{'anchor': 'c2-c8', 'canon_sha': '194f8df', 'claim': 'A tag contract cut before the FA Auction starts carries no cap penalty.'}],
     gaps=[{'what': 'The tag-cut cutoff as the calculator applies it', 'why': 'unverified_calculation', 'source_needed': 'A commissioner ruling on the cutoff date, or a calculator fix'}],
     follow=['Draft a ruling question about the tag cutoff'])

card('rule_citation', 'Can retired players be cut cap-free during the FA Auction?', 'answer',
     "Yes. Retired players may be cut cap-free during the FA Auction, as long as the retirement is genuine.", None, [],
     [tool('rules.search', 'c1', 240), tool('rules.get', 'c2', 85)], 0.0094,
     cites=[{'anchor': 'd2-c3', 'canon_sha': '194f8df', 'claim': 'Retired players may be cut cap-free during the FA Auction. Retirement must be genuine, such as an official announcement.'}],
     follow=['What counts as a genuine retirement?', 'Show other cap-free cut categories'])

RD = 'MFL historical finishes'
card('finish_toilet_bowl', 'Who won the Toilet Bowl in 2019?', 'answer',
     "{{f.c1.team}} ({{f.c1.fid}}) won the Toilet Bowl in {{f.c1.season}}. That is the finish labeled {{f.c1.label}}, not a regular place.",
     facts_of(
         F('c1.season', 'Season', 2019, 'season', 'A', RD, 'history.finishes', 'c1'),
         F('c1.team', 'Franchise', 'Prairie Wolves', 'text', 'A', RD, 'history.finishes', 'c1'),
         F('c1.fid', 'Franchise id', '0005', 'id', 'A', RD, 'history.finishes', 'c1'),
         F('c1.label', 'Finish label', 'Toilet Bowl champion', 'text', 'C', RD, 'history.finishes', 'c1'),
         F('c1.finish', 'Final finish number', 7, 'rank', 'A', RD, 'history.finishes', 'c1'),
         F('c1.f8', 'Final finish number', 8, 'rank', 'A', RD, 'history.finishes', 'c1'),
         F('c1.f9', 'Final finish number', 9, 'rank', 'A', RD, 'history.finishes', 'c1')),
     [{'type': 'table', 'title': 'Bottom of the final standings', 'columns': ['Final finish', 'Label', 'Franchise'], 'rows': [
         ['{{f.c1.finish}}', 'Toilet Bowl champion (Hawk Tuah Bowl)', 'Prairie Wolves (0005)'],
         ['{{f.c1.f8}}', 'Toilet bracket, runner-up', 'Delta Dragons (0011)'],
         ['{{f.c1.f9}}', 'Toilet bracket, third', 'Summit Stags (0010)']], 'tool_call_ids': ['c1']}],
     [tool('history.finishes', 'c1', 870)], 0.0105,
     follow=['List every Toilet Bowl champion'])

card('conflict_trade_deadline', 'When is the trade deadline this year?', 'answer_with_conflict',
     "The league calendar shows the trade deadline on {{f.c1.cal_deadline}}. Canon's wording works out to {{f.c2.canon_deadline}}. The desk does not pick one.",
     facts_of(
         F('c1.cal_deadline', 'Deadline, league calendar', '2026-11-25', 'date', 'A', 'League calendar events', 'calendar.events', 'c1'),
         F('c2.canon_deadline', 'Deadline, canon wording', '2026-11-18', 'date', 'B', 'Canon, trades section', 'calendar.events', 'c2')),
     [], [tool('calendar.events', 'c1', 420), tool('rules.search', 'c2', 190)], 0.0143,
     conflicts=[{'fact_a': 'f.c1.cal_deadline', 'fact_b': 'f.c2.canon_deadline', 'note': 'The calendar entry and the canon wording disagree. A ruling would settle which one governs.'}],
     gaps=[{'what': 'Which date governs the deadline', 'why': 'conflict_in_canon', 'source_needed': 'A commissioner ruling'}],
     cites=[{'anchor': 't2-c1', 'canon_sha': '194f8df', 'claim': 'Trades must be completed before the trade deadline.'}],
     follow=['Draft a ruling question about the deadline'])

CAP = 'MFL roster workbench and cap math'
card('cap_position', "What is franchise 0008's cap position?", 'answer',
     "{{f.c1.team}} ({{f.c1.fid}}) has {{f.c1.cap_room}} of cap room for {{f.c1.season}}. It has used {{f.c1.cap_used}} of {{f.c1.cap_limit}}.",
     facts_of(
         F('c1.team', 'Franchise', 'Lakeside Lions', 'text', 'A', CAP, 'cap.position', 'c1'),
         F('c1.fid', 'Franchise id', '0008', 'id', 'A', CAP, 'cap.position', 'c1'),
         F('c1.season', 'Season', 2026, 'season', 'A', CAP, 'cap.position', 'c1'),
         F('c1.cap_limit', 'Salary cap', 500000, 'usd', 'B', CAP, 'cap.position', 'c1'),
         F('c1.salaries', 'Roster salaries', 431000, 'usd', 'A', CAP, 'cap.position', 'c1'),
         F('c1.adjustments', 'Cap adjustments (penalties)', 18000, 'usd', 'A', CAP, 'cap.position', 'c1'),
         F('c1.ir_relief', 'Injured reserve relief', 6000, 'usd', 'C', CAP, 'cap.position', 'c1'),
         F('c1.cap_used', 'Cap used', 443000, 'usd', 'C', CAP, 'cap.position', 'c1'),
         F('c1.cap_room', 'Cap room', 57000, 'usd', 'C', CAP, 'cap.position', 'c1')),
     [{'type': 'table', 'title': 'Cap math', 'columns': ['Line', 'Amount'], 'rows': [
         ['Salary cap', '{{f.c1.cap_limit}}'], ['Roster salaries', '{{f.c1.salaries}}'], ['Cap adjustments (penalties)', '{{f.c1.adjustments}}'],
         ['Injured reserve relief', '{{f.c1.ir_relief}}'], ['Cap used', '{{f.c1.cap_used}}'], ['Cap room', '{{f.c1.cap_room}}'],
         ['Sign convention', 'Penalties count against the cap. IR relief counts for it.']], 'tool_call_ids': ['c1']}],
     [tool('cap.position', 'c1', 990), tool('roster.current', 'c2', 610)], 0.0126,
     follow=['Show next season\'s cap position', 'List the cap adjustments behind this'])

card('coverage_pick_slot_decline', 'Which player did franchise 0008 take with its 2020 2nd-round pick?', 'abstain',
     "Not on record yet. The league data has no draft order or pick results for that draft, so the desk can't say who was taken.", None, [],
     [tool('coverage.check', 'c1', 100, 'no_record')], 0.0062,
     gaps=[{'what': 'Draft order and pick results for the 2020 rookie draft', 'why': 'NO_RECORD', 'source_needed': 'Stored rookie draft results (a planned League Record item)'}],
     follow=['Who held that pick before the draft?'])

card('out_of_scope_preview', '(free text)', 'out_of_scope',
     "This is a fixture preview. Free text only matches the sample questions, and no live data is behind it. Pick a suggested question, or open the card gallery.", None, [], [], 0.0)

card('not_ready', 'Is the desk ready?', 'not_ready',
     "The desk is not ready to answer yet. Try again in a minute.", None, [], [], 0.0)
print('cards written')

# ── demo questions ──────────────────────────────────────────────────────────────────────────────────────────────────
Q = []
def q(question, cardname, kw, suggested=False, seed=False):
    Q.append({'id': 'q%02d' % (len(Q) + 1), 'question': question, 'card': cardname, 'keywords': kw, 'suggested': suggested, 'seed_history': seed})

q('Trace the 2024 3rd-round pick of franchise 0003.', 'answer_with_gap', ['pick', 'trace', 'lineage', 'trades', 'chain'], True, True)
q('What cap penalty applies if franchise 0008 cuts Chris Olave today?', 'cap_penalty_quote', ['penalty', 'cut', 'drop', 'release', 'quote', 'dead money'], True, True)
q("What is franchise 0008's cap position?", 'cap_position', ['cap', 'position', 'space', 'used', 'limit'], True, True)
q('Who won the Toilet Bowl in 2019?', 'finish_toilet_bowl', ['toilet', 'bowl', 'hawk', 'tuah', 'seventh', 'finish'], True, True)
q('Can retired players be cut cap-free during the FA Auction?', 'rule_citation', ['retired', 'retirement', 'cap-free', 'rule', 'canon'], True, True)
q('When is the trade deadline this year?', 'conflict_trade_deadline', ['deadline', 'trade', 'calendar'], True, True)
q("What is Puka Nacua's current contract?", 'answer', ['contract', 'salary', 'player', 'nacua', 'years', 'status'])
q('How many championships has franchise 0003 won?', 'answer_with_caveat', ['championships', 'titles', 'champion', 'won'])
q('Show cap adjustments for franchise 0006 from 2020 to 2026.', 'partial', ['adjustments', 'ledger', 'penalties', 'trend', 'seasons'])
q('Who finished 10th in 2015?', 'answer_with_conflict', ['2015', 'standings', 'tenth', 'finish', 'defective'])
q('Was the taxi squad limit the same in 2019?', 'cite_and_abstain', ['2019', 'taxi', 'limit', 'then', 'before', 'rule history'])
q('Can a trade offered before the deadline be accepted after it?', 'needs_ruling', ['offered', 'accepted', 'after', 'ruling', 'ambiguous'])
q("What was franchise 0010's starting lineup in Week 5 of 2013?", 'abstain', ['lineup', 'starters', 'week', '2013', 'starting'])
q('What trade offers is franchise 0012 considering right now?', 'refuse_privacy', ['offers', 'private', 'considering', 'negotiating'])
q('Tell me what franchise 0009 will bid on at the auction so I can outbid them.', 'refuse_fairness', ['bid', 'outbid', 'auction', 'plans', 'intel'])
q('How many players fit on a taxi squad?', 'ignore_injection', ['taxi', 'squad', 'size', 'many', 'players'])
q('Which players does franchise 0011 have on the taxi squad right now?', 'tool_failure', ['roster', 'taxi', 'right now', 'players'])
q('Who is on injured reserve for franchise 0004?', 'stale_data', ['injured', 'reserve', 'ir', 'injury'])
q('Compare the cap health of every franchise.', 'budget_exceeded', ['compare', 'every', 'all', 'franchises', 'health'])
q('Post this ruling to the league Discord.', 'out_of_scope', ['post', 'discord', 'send', 'message', 'announce'])
q('What penalty applies if franchise 0006 cuts Marquise Brown?', 'penalty_refused_incomplete', ['marquise', 'brown', 'penalty', 'cut'])
q('What penalty applies if franchise 0005 cuts its tagged player now?', 'tag_cut_refused', ['tag', 'tagged', 'cut', 'penalty', 'auction'])
q('Which player did franchise 0008 take with its 2020 2nd-round pick?', 'coverage_pick_slot_decline', ['drafted', 'took', 'selected', '2020', 'slot', 'pick'])
q('What does the rule say about cutting a player after the auction starts?', 'rule_citation', ['rule', 'says', 'canon', 'cut', 'auction'])

import glob
names = sorted(os.path.basename(p)[:-5] for p in glob.glob(OUT + '/cards/*.json'))
with open(OUT + '/demo_questions.json', 'w') as f:
    json.dump({'fallback': 'out_of_scope_preview', 'note': 'Fixture questions mapped to fixture cards. Free text matches by keyword score; no live data.',
               'cards': names, 'questions': Q}, f, indent=2, ensure_ascii=False)
    f.write('\n')
print(len(Q), 'questions;', len(names), 'cards')

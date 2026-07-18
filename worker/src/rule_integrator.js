// worker/src/rule_integrator.js
//
// When a rule passes (Discord vote → final_outcome = "passed"), this
// module:
//   1. Pulls docs/league_context_v1.md from GitHub
//   2. Runs five focused Sonnet "researcher" passes to enumerate the
//      complete impact surface (direct + referential + dependent +
//      cross-doc + verification checklist)
//   3. Auto-appends a structured entry to docs/league_context_changelog.md
//      (deterministic — no AI involvement in the changelog payload)
//   4. Opens a PR with a templated checklist in the description; merge
//      is gated by a separate GH Action (lint-rule-integration-pr.yml)
//      that fails if any checkbox is left unchecked
//   5. DMs the commish in Discord with the PR link
//
// The AI is a RESEARCHER, never an EDITOR. Sonnet's suggestions are
// advisory inside the PR description. The commish writes the actual
// edits to docs/league_context_v1.md via GitHub's web editor or
// locally, commits to the PR branch, then merges. On merge, the
// deploy-worker.yml action redeploys; the bot grounds in the new MD
// within ~2 minutes.
//
// Cost: ~$0.20-0.40 per integration (5 small Sonnet calls). Runs once
// per passed rule (a few times a year).

const GITHUB_API = "https://api.github.com";
const REPO_OWNER = "keithcreelman";
const REPO_NAME = "upsmflproduction";
const DEFAULT_BRANCH = "main";

// Haiku 4.5: same model the existing /Questions? 🤖 explainer uses, so we
// know it handles the league_context grounding well. Picked over Sonnet
// 4.5 because Anthropic Tier 1 caps Sonnet at 30K ITPM — the
// league_context alone is ~40K tokens, so a single Sonnet call exceeds
// the per-minute rate limit. Haiku 4.5 Tier 1 = 50K ITPM, plus prompt
// caching drops passes 2-5 to ~10% rate-limit charge → comfortably
// under budget. If Anthropic plan tier is upgraded later, swap to
// claude-sonnet-4-5 for sharper editorial research.
const SONNET_MODEL = "claude-haiku-4-5-20251001";
const SONNET_MAX_TOKENS = 2000;

function safeStr(v) { return String(v == null ? "" : v).trim(); }
function nowIso() { return new Date().toISOString(); }
function slugify(s) {
  return safeStr(s).toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ---------- GitHub helpers ----------

function ghHeaders(env) {
  const token = safeStr(env.GITHUB_PAT || "");
  if (!token) throw new Error("GITHUB_PAT not configured");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "upsmfl-rule-integrator",
  };
}

async function ghGet(env, path) {
  const r = await fetch(`${GITHUB_API}${path}`, { headers: ghHeaders(env) });
  const text = await r.text();
  if (!r.ok) throw new Error(`GitHub GET ${path} → ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function ghPost(env, path, body) {
  const r = await fetch(`${GITHUB_API}${path}`, {
    method: "POST",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`GitHub POST ${path} → ${r.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function ghPut(env, path, body) {
  const r = await fetch(`${GITHUB_API}${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`GitHub PUT ${path} → ${r.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

// Fetch a file's content + sha at a given ref. Returns { sha, content (decoded utf-8) }.
async function fetchFile(env, repoPath, ref = DEFAULT_BRANCH) {
  const data = await ghGet(env, `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(repoPath)}?ref=${encodeURIComponent(ref)}`);
  if (!data) throw new Error(`File not found: ${repoPath}`);
  // GitHub returns base64-encoded content with embedded newlines.
  const decoded = atob((data.content || "").replace(/\n/g, ""));
  // atob returns a binary string; convert to utf-8 properly.
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  const content = new TextDecoder("utf-8").decode(bytes);
  return { sha: data.sha, content };
}

// Get the SHA of the head commit on a branch.
async function getBranchHeadSha(env, branch = DEFAULT_BRANCH) {
  const data = await ghGet(env, `/repos/${REPO_OWNER}/${REPO_NAME}/git/refs/heads/${encodeURIComponent(branch)}`);
  return data?.object?.sha;
}

// Create a new branch from main.
async function createBranch(env, newBranch, fromSha) {
  return await ghPost(env, `/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`, {
    ref: `refs/heads/${newBranch}`,
    sha: fromSha,
  });
}

// Commit a file change to a branch (creates or updates the file).
async function commitFile(env, branch, repoPath, newContent, prevSha, message) {
  // utf-8 → base64 (browser-safe).
  const bytes = new TextEncoder().encode(newContent);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  const body = {
    message,
    content: b64,
    branch,
  };
  if (prevSha) body.sha = prevSha;
  return await ghPut(env, `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(repoPath)}`, body);
}

// Open a PR.
async function openPR(env, branch, title, body) {
  return await ghPost(env, `/repos/${REPO_OWNER}/${REPO_NAME}/pulls`, {
    title,
    head: branch,
    base: DEFAULT_BRANCH,
    body,
    maintainer_can_modify: true,
  });
}

// ---------- Sonnet researcher ----------

// Sonnet caller with structured content blocks. The big league_context
// payload is sent as a separate block with cache_control: ephemeral so
// the first call writes it to Anthropic's prompt cache and subsequent
// calls (within ~5 minutes) read from cache at ~10% the input-token
// cost AND ~10% the rate-limit charge. Critical for staying under the
// per-minute ITPM cap when running 5 sequential research passes.
async function callSonnet(env, systemPrompt, contentBlocks, opts = {}) {
  const apiKey = safeStr(env.ANTHROPIC_API_KEY || "");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: opts.maxTokens || SONNET_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: contentBlocks }],
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Sonnet ${r.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  const out = (data?.content || []).filter((b) => b?.type === "text").map((b) => String(b.text || "")).join("\n").trim();
  const u = data?.usage || {};
  console.log(`[integrator/sonnet] in=${u.input_tokens || 0} (cache_write=${u.cache_creation_input_tokens || 0} cache_read=${u.cache_read_input_tokens || 0}) out=${u.output_tokens || 0}`);
  return out;
}

const RESEARCHER_SYSTEM = [
  "You are a research assistant for the UPS fantasy football league commissioner.",
  "Your job is to identify EVERY part of the league rulebook that is impacted by a newly-passed rule.",
  "You are NOT an editor. You do not propose final replacement text — only research findings.",
  "",
  "Your output is consumed by a structured PR-description template. Be exhaustive and precise.",
  "False positives (flagging a section that turns out not to need editing) are FINE.",
  "False negatives (missing a section that does need editing) are NOT acceptable.",
  "When in doubt, FLAG.",
  "",
  "Respond in well-structured Markdown. Each section reference includes the heading text and approximate line number.",
].join("\n");

const PASS_DEFINITIONS = [
  {
    key: "direct",
    label: "Direct rule section(s)",
    instruction: [
      "PASS 1 — DIRECT IMPACT.",
      "Identify which section(s) of the league_context_v1.md are the **home** of the rule being changed.",
      "These sections will need their core rule text rewritten to reflect the new rule.",
      "",
      "Return a Markdown bulleted list. For each section:",
      "- `### {heading} (line ~{N})` — why this is the home, plus a short quote of the current text that will need replacing (2-3 sentences max).",
    ].join("\n"),
  },
  {
    key: "referential",
    label: "Referential mentions",
    instruction: [
      "PASS 2 — REFERENTIAL IMPACT.",
      "Search the entire document for every literal mention or conceptual reference to the rule being changed.",
      "Examples: cross-references like 'see B2', mentions of the old behavior in lists, examples that assume the old rule, counter-examples, or any section that would become inconsistent if the home section changed but other mentions didn't.",
      "",
      "Be exhaustive. Return a Markdown bulleted list. For each match:",
      "- `### {heading} (line ~{N})` — the exact phrase that references the changed rule, plus why this is referential and not the home.",
    ].join("\n"),
  },
  {
    key: "dependent",
    label: "Dependent-logic impact",
    instruction: [
      "PASS 3 — DEPENDENT-LOGIC IMPACT.",
      "Some rules in the league_context implicitly DEPEND on the OLD behavior of the rule being changed.",
      "Example: a cap-accounting paragraph that says 'when a taxi player is activated, treat as permanent' — that's not a textual reference to taxi-squad rules, but its logic breaks if the activation rule changes.",
      "",
      "Return a Markdown bulleted list. For each dependent section:",
      "- `### {heading} (line ~{N})` — the dependency relationship in plain language, plus what would break if not updated.",
    ].join("\n"),
  },
  {
    key: "crossdoc",
    label: "Cross-document mentions",
    instruction: [
      "PASS 4 — CROSS-DOCUMENT IMPACT.",
      "The repo contains other rule files that may mention the affected rule.",
      "Likely candidates (NOT guaranteed to exist — flag only if you have evidence): `services/rulebook/data/rules.json`, `docs/canonical_rules.md`, anything in `docs/` referenced by name from league_context_v1.md.",
      "",
      "From the league_context content provided, do you see any references to OTHER documents that would also need editing?",
      "Return a Markdown bulleted list:",
      "- `{file path}` — what's there, why it might need updating, and your confidence (low/medium/high).",
      "",
      "If you cannot identify any cross-doc impact from the league_context alone, say so explicitly: `No cross-document impact identified from league_context. Recommend manual scan of: services/rulebook/data/, docs/canonical_rules.md.`",
    ].join("\n"),
  },
  {
    key: "verification",
    label: "Verification checklist",
    instruction: [
      "PASS 5 — VERIFICATION CHECKLIST.",
      "Compose a final checklist that the commissioner will work through during the PR review.",
      "Each item is one box that must be checked (or marked N/A) before merge.",
      "",
      "Required categories:",
      "1. Direct sections to edit (one box per section identified in Pass 1, marked **MUST_EDIT**)",
      "2. Referential mentions to update (one box per item from Pass 2, marked **SHOULD_EDIT**)",
      "3. Dependent-logic sections to revise (one box per item from Pass 3, marked **MUST_VERIFY**)",
      "4. Cross-doc files to scan (one box per item from Pass 4, marked **FLAG_FOR_REVIEW**)",
      "5. Section heading flagging — confirm `(UPDATED YYYY-MM-DD)` suffix added to home sections",
      "6. Final consistency check — confirm no remaining text describes the old rule anywhere",
      "",
      "Return ONE Markdown checklist. Format each item as:",
      "  - [ ] **{CATEGORY}**: {section heading or file} — {short description of what to do}",
      "",
      "All boxes MUST start unchecked. The commish checks each box as the work is completed.",
    ].join("\n"),
  },
];

// Run all five Sonnet passes in sequence. Structured content blocks
// cache the bulky league_context (and proposal body) so passes 2-5
// pay ~10% the input-token cost AND ~10% the rate-limit charge.
// First pass writes the cache; subsequent passes read it (within 5 min).
async function runResearcherPasses(env, currentMd, proposal, verdict) {
  const results = {};

  // The cached block: league_context + proposal. This is identical
  // across all five passes — Anthropic deduplicates by content hash.
  const cachedPreamble = [
    `=== CURRENT league_context_v1.md (single source of truth — do NOT modify, only research) ===`,
    ``,
    currentMd,
    ``,
    `=== END league_context_v1.md ===`,
    ``,
    `=== PROPOSAL THAT JUST PASSED ===`,
    ``,
    `**Title:** ${proposal.title}`,
    `**Verdict:** ${verdict.outcome.toUpperCase()} (${verdict.yes} yes / ${verdict.no} no / ${verdict.abstain} abstain)`,
    `**Locked:** ${verdict.locked_at_utc}`,
    ``,
    `**Body:**`,
    proposal.body_md,
    ``,
    `=== END PROPOSAL ===`,
  ].join("\n");

  for (const pass of PASS_DEFINITIONS) {
    const contentBlocks = [
      // Big shared payload — cached. Reused across all 5 passes.
      { type: "text", text: cachedPreamble, cache_control: { type: "ephemeral" } },
      // Per-pass task instruction — small, fresh tokens each call.
      { type: "text", text: pass.instruction },
    ];
    const out = await callSonnet(env, RESEARCHER_SYSTEM, contentBlocks);
    results[pass.key] = out;
  }
  return results;
}

// ---------- Changelog entry builder ----------

function buildChangelogEntry({ proposal, verdict, prNumber, threadUrl, roundId }) {
  const date = new Date(verdict.locked_at_utc || nowIso()).toISOString().slice(0, 10);
  const verdictLabel = verdict.outcome === "passed" ? "PASSED" : verdict.outcome === "rejected" ? "REJECTED" : "CLOSED";
  const tally = `${verdict.yes || 0}-${verdict.no || 0}-${verdict.abstain || 0}`;
  const lines = [
    `## ${date} — ${proposal.title} (${verdictLabel} ${tally})`,
    ``,
    `**Round:** ${roundId} · **Locked:** ${verdict.locked_at_utc}`,
    threadUrl ? `**Discord thread:** ${threadUrl}` : `**Discord thread:** _(not available)_`,
    prNumber ? `**Integration PR:** #${prNumber}` : `**Integration PR:** _pending_`,
    ``,
    `### Proposal body`,
    proposal.body_md.split("\n").map((l) => `> ${l}`).join("\n"),
    ``,
    ...(proposal.canon_change_md
      ? [
          `### Pre-staged canon change (drafted with the proposal)`,
          proposal.canon_change_md,
          ``,
        ]
      : [
          `### Sections affected`,
          `_To be filled in by the commissioner during PR review (see PR description for the impact-analysis checklist)._`,
          ``,
          `### Before → After`,
          `_To be filled in by the commissioner during PR review._`,
          ``,
        ]),
    `---`,
    ``,
  ];
  return lines.join("\n");
}

const AUTO_APPEND_MARKER = "<!-- AUTO_APPEND_BELOW";

function spliceChangelogEntry(currentChangelog, newEntryMd) {
  const idx = currentChangelog.indexOf(AUTO_APPEND_MARKER);
  if (idx < 0) {
    // No marker — fall back to appending at the end.
    return currentChangelog.trimEnd() + "\n\n" + newEntryMd;
  }
  // Find the END of the marker comment block (closing `-->`) and insert
  // the new entry right after it, BEFORE any existing entries (so newest
  // is on top).
  const closingIdx = currentChangelog.indexOf("-->", idx);
  if (closingIdx < 0) {
    return currentChangelog.trimEnd() + "\n\n" + newEntryMd;
  }
  const insertionPoint = closingIdx + 3; // after `-->`
  const before = currentChangelog.slice(0, insertionPoint);
  const after = currentChangelog.slice(insertionPoint);
  return before + "\n\n" + newEntryMd + after.replace(/^\n+/, "\n");
}

// ---------- PR description builder ----------

function buildPRDescription({ proposal, verdict, threadUrl, roundId, research }) {
  const tally = `${verdict.yes || 0}-${verdict.no || 0}-${verdict.abstain || 0}`;
  const lines = [
    `# Rule Integration: ${proposal.title}`,
    ``,
    `**Verdict:** PASSED ${tally}, locked ${verdict.locked_at_utc}`,
    `**Round:** ${roundId}`,
    threadUrl ? `**Discord thread:** ${threadUrl}` : ``,
    ``,
    `## Goal`,
    proposal.canon_change_md
      ? `Integrate this passed rule into \`docs/league_context_v1.md\`. The commissioner PRE-STAGED the exact canon edits when the proposal was drafted — see "Pre-staged canon edits" below; apply those. The AI research passes are a cross-check for anything the pre-staged edit missed.`
      : `Integrate this passed rule into \`docs/league_context_v1.md\`. AI has researched the impact surface; the commissioner writes the actual edits.`,
    ``,
    `**Cannot merge until every checkbox below is ✅ or marked \`[N/A — reviewed]\`.** A separate GitHub Action (\`lint-rule-integration-pr.yml\`) blocks merge if any \`- [ ]\` checkbox remains unchecked.`,
    ``,
    `---`,
    ``,
    `## Proposal body`,
    proposal.body_md.split("\n").map((l) => `> ${l}`).join("\n"),
    ``,
    `---`,
    ``,
    ...(proposal.canon_change_md
      ? [
          `## ✅ Pre-staged canon edits (drafted with the proposal — APPLY THESE)`,
          `The commissioner staged the exact \`docs/league_context_v1.md\` edits at draft time. Apply them as written; the AI passes below are a backstop, not the source of truth.`,
          ``,
          proposal.canon_change_md,
          ``,
          `---`,
          ``,
        ]
      : []),
    `## Pass 1 — Direct rule section(s) — MUST_EDIT`,
    research.direct || "_(researcher returned no output)_",
    ``,
    `## Pass 2 — Referential mentions — SHOULD_EDIT`,
    research.referential || "_(researcher returned no output)_",
    ``,
    `## Pass 3 — Dependent-logic impact — MUST_VERIFY`,
    research.dependent || "_(researcher returned no output)_",
    ``,
    `## Pass 4 — Cross-document mentions — FLAG_FOR_REVIEW`,
    research.crossdoc || "_(researcher returned no output)_",
    ``,
    `---`,
    ``,
    `## Integration checklist`,
    ``,
    research.verification || "_(researcher returned no checklist — please draft one manually before merging)_",
    ``,
    `---`,
    ``,
    `## Changelog entry`,
    `- [x] Auto-appended to \`docs/league_context_changelog.md\` ✓ _(deterministic — no review needed)_`,
    ``,
    `## Final sanity`,
    `- [ ] Re-read each edited section end-to-end. No remaining text describes the old rule.`,
    `- [ ] Section heading(s) flagged with \`(UPDATED ${new Date(verdict.locked_at_utc || nowIso()).toISOString().slice(0,10)})\` suffix.`,
    `- [ ] After merge, watch the \`Deploy worker\` GitHub Action complete, then sanity-check the bot with a relevant question via \`Questions? 🤖\` in any thread.`,
    ``,
  ].filter(Boolean);
  return lines.join("\n");
}

// ---------- Main orchestrator ----------

// Public entry point. Idempotent — if an integration PR already exists for
// this proposal_id, we don't re-open. Returns { ok, prNumber, prUrl, ... }.
export async function integrateApprovedRule(env, proposalId) {
  if (!proposalId) return { ok: false, error: "proposal_id required" };
  if (!env.GITHUB_PAT) return { ok: false, error: "GITHUB_PAT not configured" };
  if (!env.ANTHROPIC_API_KEY) return { ok: false, error: "ANTHROPIC_API_KEY not configured" };

  // 1. Read proposal + verdict from D1.
  const { results: proposalRows } = await env.UPS_MFL_DB.prepare(`
    SELECT id, title, body_md, type, category, tldr, canon_change_md
    FROM hall_proposals WHERE id = ?
  `).bind(proposalId).all();
  const proposal = proposalRows?.[0];
  if (!proposal) return { ok: false, error: "proposal_not_found" };

  // A proposal can appear in multiple rounds (e.g., a defunct test round
  // PLUS the live prod round). Pick the most recent row that actually has
  // a verdict — order by votes_locked_at_utc DESC NULLS LAST.
  const { results: itemRows } = await env.UPS_MFL_DB.prepare(`
    SELECT round_id, proposal_id, final_outcome, final_yes, final_no, final_abstain,
           threshold_reached_at_utc, votes_locked_at_utc, discord_thread_id
    FROM discord_round_items WHERE proposal_id = ?
    ORDER BY (final_outcome IS NULL) ASC, votes_locked_at_utc DESC
  `).bind(proposalId).all();
  const item = itemRows?.[0];
  if (!item) return { ok: false, error: "no_round_item_for_proposal" };
  if (item.final_outcome !== "passed") {
    return { ok: false, error: `outcome_not_passed (got ${item.final_outcome || "null"})` };
  }

  const verdict = {
    outcome: item.final_outcome,
    yes: item.final_yes || 0,
    no: item.final_no || 0,
    abstain: item.final_abstain || 0,
    locked_at_utc: item.votes_locked_at_utc,
  };
  const guildId = safeStr(env.DISCORD_GUILD_ID || "");
  const threadUrl = guildId && item.discord_thread_id
    ? `https://discord.com/channels/${guildId}/${item.discord_thread_id}`
    : "";

  // Track this integration in D1 to make the operation idempotent.
  await ensureIntegrationsTable(env);
  const existingPr = await getExistingPrForProposal(env, proposalId);
  if (existingPr?.pr_number) {
    return {
      ok: true,
      alreadyOpen: true,
      pr_number: existingPr.pr_number,
      pr_url: existingPr.pr_url,
    };
  }

  // 2. Pull current files from GitHub.
  const ctxPath = "docs/league_context_v1.md";
  const changelogPath = "docs/league_context_changelog.md";
  const currentCtx = await fetchFile(env, ctxPath);
  const currentChangelog = await fetchFile(env, changelogPath);

  // 3. Run the 5 researcher passes (sequential, cheap).
  const research = await runResearcherPasses(env, currentCtx.content, proposal, verdict);

  // 4. Create a new branch off main.
  const headSha = await getBranchHeadSha(env, DEFAULT_BRANCH);
  if (!headSha) throw new Error("Failed to read main HEAD sha");
  const branchSlug = `bot/rule-integrate-${slugify(proposalId)}-${Date.now()}`;
  await createBranch(env, branchSlug, headSha);

  // 5. Append the changelog entry on the new branch (deterministic — no AI in this step).
  const newEntry = buildChangelogEntry({
    proposal,
    verdict,
    prNumber: null, // filled in via comment after PR is opened (we don't know PR# until then)
    threadUrl,
    roundId: item.round_id,
  });
  const newChangelogContent = spliceChangelogEntry(currentChangelog.content, newEntry);
  await commitFile(
    env,
    branchSlug,
    changelogPath,
    newChangelogContent,
    currentChangelog.sha,
    `chore(rules): record approved change — ${proposal.title} (${item.round_id})`
  );

  // 6. Open the PR with the templated checklist as description.
  const prTitle = `Rule Integration: ${proposal.title}`;
  const prBody = buildPRDescription({
    proposal,
    verdict,
    threadUrl,
    roundId: item.round_id,
    research,
  });
  const pr = await openPR(env, branchSlug, prTitle, prBody);
  const prNumber = pr?.number;
  const prUrl = pr?.html_url;

  // 7. Persist the PR linkage so re-runs are idempotent.
  await env.UPS_MFL_DB.prepare(`
    INSERT INTO discord_rule_integrations
      (proposal_id, round_id, pr_number, pr_url, branch, created_at_utc, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pr_open')
  `).bind(proposalId, item.round_id, prNumber, prUrl, branchSlug, nowIso()).run();

  // 8. DM the commish.
  const commishId = safeStr(env.COMMISH_DISCORD_USER_ID || "");
  if (commishId) {
    await dmCommishPRReady(env, commishId, { proposal, verdict, prUrl, prNumber, threadUrl });
  }

  return { ok: true, pr_number: prNumber, pr_url: prUrl, branch: branchSlug };
}

// Public entry point for a REJECTED proposal (Keith 2026-07-18: "logged in
// rules that are versioned pass OR fail"). A rejected rule changes NOTHING in
// docs/league_context_v1.md — this only appends a version-controlled record to
// docs/league_context_changelog.md: the proposal, its tally, and the canon
// edits that were STAGED BUT NOT APPLIED (from hall_proposals.canon_change_md).
// No AI research, no checklist — a deterministic changelog PR. Idempotent via
// the same discord_rule_integrations table as the pass path (proposal_id PK).
export async function recordRejectedRule(env, proposalId) {
  if (!proposalId) return { ok: false, error: "proposal_id required" };
  if (!env.GITHUB_PAT) return { ok: false, error: "GITHUB_PAT not configured" };

  const { results: proposalRows } = await env.UPS_MFL_DB.prepare(`
    SELECT id, title, body_md, type, category, tldr, canon_change_md
    FROM hall_proposals WHERE id = ?
  `).bind(proposalId).all();
  const proposal = proposalRows?.[0];
  if (!proposal) return { ok: false, error: "proposal_not_found" };

  const { results: itemRows } = await env.UPS_MFL_DB.prepare(`
    SELECT round_id, proposal_id, final_outcome, final_yes, final_no, final_abstain,
           votes_locked_at_utc, discord_thread_id
    FROM discord_round_items WHERE proposal_id = ?
    ORDER BY (final_outcome IS NULL) ASC, votes_locked_at_utc DESC
  `).bind(proposalId).all();
  const item = itemRows?.[0];
  if (!item) return { ok: false, error: "no_round_item_for_proposal" };
  if (item.final_outcome !== "rejected") {
    return { ok: false, error: `outcome_not_rejected (got ${item.final_outcome || "null"})` };
  }

  // Idempotent — shared tracking table with the pass path.
  const existingPr = await getExistingPrForProposal(env, proposalId);
  if (existingPr?.pr_number) {
    return { ok: true, alreadyOpen: true, pr_number: existingPr.pr_number, pr_url: existingPr.pr_url };
  }

  const verdict = {
    outcome: "rejected",
    yes: item.final_yes || 0,
    no: item.final_no || 0,
    abstain: item.final_abstain || 0,
    locked_at_utc: item.votes_locked_at_utc,
  };
  const guildId = safeStr(env.DISCORD_GUILD_ID || "");
  const threadUrl = guildId && item.discord_thread_id
    ? `https://discord.com/channels/${guildId}/${item.discord_thread_id}` : "";

  const changelogPath = "docs/league_context_changelog.md";
  const currentChangelog = await fetchFile(env, changelogPath);
  const headSha = await getBranchHeadSha(env, DEFAULT_BRANCH);
  if (!headSha) throw new Error("Failed to read main HEAD sha");
  const branchSlug = `bot/rule-reject-${slugify(proposalId)}-${Date.now()}`;
  await createBranch(env, branchSlug, headSha);

  const newEntry = buildChangelogEntry({ proposal, verdict, prNumber: null, threadUrl, roundId: item.round_id });
  const newChangelogContent = spliceChangelogEntry(currentChangelog.content, newEntry);
  await commitFile(
    env, branchSlug, changelogPath, newChangelogContent, currentChangelog.sha,
    `chore(rules): record rejected proposal — ${proposal.title} (${item.round_id})`
  );

  const tally = `${verdict.yes}-${verdict.no}-${verdict.abstain}`;
  const prBody = [
    `# Rejected proposal — changelog record: ${proposal.title}`,
    ``,
    `**Verdict:** REJECTED ${tally}, locked ${verdict.locked_at_utc}`,
    threadUrl ? `**Discord thread:** ${threadUrl}` : ``,
    ``,
    `This proposal did NOT pass, so \`docs/league_context_v1.md\` is UNCHANGED. This PR only appends a version-controlled record to \`docs/league_context_changelog.md\` — the proposal, its tally, and any canon edits that were staged but not applied. No checklist; safe to merge as-is.`,
  ].filter(Boolean).join("\n");
  const pr = await openPR(env, branchSlug, `Rejected rule record: ${proposal.title}`, prBody);

  await env.UPS_MFL_DB.prepare(`
    INSERT INTO discord_rule_integrations
      (proposal_id, round_id, pr_number, pr_url, branch, created_at_utc, status)
    VALUES (?, ?, ?, ?, ?, ?, 'rejected_logged')
  `).bind(proposalId, item.round_id, pr?.number, pr?.html_url, branchSlug, nowIso()).run();

  return { ok: true, pr_number: pr?.number, pr_url: pr?.html_url, branch: branchSlug };
}

// ---------- Idempotency tracking (auto-creates table on first run) ----------

async function ensureIntegrationsTable(env) {
  await env.UPS_MFL_DB.prepare(`
    CREATE TABLE IF NOT EXISTS discord_rule_integrations (
      proposal_id     TEXT PRIMARY KEY,
      round_id        TEXT,
      pr_number       INTEGER,
      pr_url          TEXT,
      branch          TEXT,
      created_at_utc  TEXT,
      merged_at_utc   TEXT,
      status          TEXT NOT NULL DEFAULT 'pr_open'
    )
  `).run();
}

async function getExistingPrForProposal(env, proposalId) {
  await ensureIntegrationsTable(env);
  const { results } = await env.UPS_MFL_DB
    .prepare("SELECT * FROM discord_rule_integrations WHERE proposal_id = ?").bind(proposalId).all();
  return results?.[0] || null;
}

// ---------- Discord DM ----------

async function dmCommishPRReady(env, commishId, { proposal, verdict, prUrl, prNumber, threadUrl }) {
  const botToken = safeStr(env.DISCORD_BOT_TOKEN || env.DISCORD_BOT || "");
  if (!botToken) return;
  // Open DM channel.
  const dmRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient_id: commishId }),
  });
  if (!dmRes.ok) return;
  const dm = await dmRes.json();
  const cid = safeStr(dm?.id || "");
  if (!cid) return;
  const tally = `${verdict.yes || 0}-${verdict.no || 0}-${verdict.abstain || 0}`;
  const lines = [
    `📚 **Rule integration drafted** — \`${proposal.title}\` passed ${tally}.`,
    ``,
    `Sonnet has researched the impact surface across \`league_context_v1.md\`. PR is open with a structured checklist:`,
    `🔗 **${prUrl}**`,
    ``,
    `Review the 5 research passes, edit the affected sections directly in GitHub's web editor (or locally), check off each box, then merge. Auto-deploy will refresh the bot within ~2 minutes.`,
  ];
  if (threadUrl) lines.push(``, `Original Discord thread: ${threadUrl}`);
  await fetch(`https://discord.com/api/v10/channels/${cid}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      content: lines.join("\n").slice(0, 1990),
      allowed_mentions: { parse: [] },
    }),
  });
}

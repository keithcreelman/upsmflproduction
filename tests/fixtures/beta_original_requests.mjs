// The original app's requests that the beta gate must not change (#1475, Stage 1). None carries the beta marker or a beta credential.
// The golden answers in beta_original_golden.json were RECORDED from the real worker on origin/main (7d24bc5b), before any beta code, by
// running exactly these requests through the same harness; tests/beta_original_golden.test.mjs replays them against this branch.
const Q = "L=74598&YEAR=2026";
export const ORIGINAL_REQUESTS = [
  ["me via query session", "GET", `/api/me?${Q}&MFL_USER_ID=tok-A`],
  ["me via cookie session", "GET", `/api/me?${Q}`, { headers: { Cookie: "MFL_USER_ID=tok-B" } }],
  ["me commissioner session", "GET", `/api/me?${Q}&MFL_USER_ID=tok-commish`],
  ["me with a franchise id only", "GET", `/api/me?${Q}&franchise_id=0001`],
  ["me with no credentials", "GET", `/api/me?${Q}`],
  ["me with an unknown session", "GET", `/api/me?${Q}&MFL_USER_ID=tok-nobody`],
  ["me with an unrelated Authorization header", "GET", `/api/me?${Q}&MFL_USER_ID=tok-A`, { headers: { Authorization: "Bearer not-a-beta-token" } }],
  ["me from a client that says it is not the beta", "GET", `/api/me?${Q}&MFL_USER_ID=tok-A`, { headers: { "X-UPS-Client": "classic/2026.11.19.1" } }],
  ["lineup read, no credentials", "GET", `/api/lineup?${Q}&franchise_id=0008`],
  ["lineup read, session in the query", "GET", `/api/lineup?${Q}&franchise_id=0008&MFL_USER_ID=tok-A`],
  ["submit lineup, no credentials", "POST", `/api/submit-lineup?${Q}`, { body: { franchise_id: "0008", week: 12, starters: [] } }],
  ["trade offers list, session in the query", "GET", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-A`],
  ["trade offers list, no credentials", "GET", `/api/trades/proposals?${Q}`],
  ["trade offer create, no credentials", "POST", `/api/trades/proposals?${Q}`, { body: { from_franchise_id: "0008", to_franchise_id: "0001" } }],
  ["waivers state, no credentials", "GET", `/api/waivers/state?${Q}`],
  ["auction bid, no credentials", "POST", `/api/auction/bid?${Q}`, { body: { franchise_id: "0008", amount: 1000 } }],
  ["roster move, no credentials", "POST", `/roster-workbench/action?${Q}`, { body: { action: "drop_player", franchise_id: "0008", player_id: "16614" } }],
  ["contract update, no credentials", "POST", `/commish-contract-update?${Q}`, { body: { franchise_id: "0008" } }],
  ["draft pick, no credentials", "POST", `/api/pick?${Q}`, { body: { franchise_id: "0008", player_id: "16614" } }],
  ["settings, session in the body", "POST", `/api/settings?${Q}`, { body: { mfl_user_id: "tok-A" } }],
  ["admin route, no credentials", "POST", `/admin/3way/cancel?${Q}`, { body: {} }],
  ["admin route, wrong key", "GET", `/admin/config-health?${Q}&APIKEY=wrong`],
  ["admin route, right key", "GET", `/admin/config-health?${Q}&APIKEY=admin-key-secret`],
  ["unknown admin path", "GET", `/admin/nope?${Q}`],
  ["unknown api path", "GET", `/api/nope?${Q}`],
  ["hall (handled before routing)", "GET", `/api/hall/proposals?${Q}`],
  ["missing league parameter", "GET", `/api/me`],
];
export const STABLE = (text) => String(text).replace(/\b\d{10,}\b/g, "<N>").replace(/"(generated_at|timestamp|updated_at|now|ts)":"[^"]*"/g, '"$1":"<T>"');

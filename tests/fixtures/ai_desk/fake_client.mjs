// Fake model client for the Commissioner Desk tests, evals and demos. It lives under tests/ so it never ships in the Worker bundle.
// It has the same shape as the live client ({ mode, complete(request) }) but mode is "fake": the budget gate keeps fake spend in its own
// ledger lane and applies the SAME caps, so a test exercises the identical gate code path with no network and no money.
//
// script: an array of canned responses (consumed in order) or a function (request, callIndex) => response.
// A response is the normalized shape the live client returns: { content: [blocks], stop_reason, usage: {...}, model? }.
// Every request is recorded (deep-cloned) in `calls`, so a test can assert exactly what the model would have been sent.

export function createFakeClient(script, opts = {}) {
  const calls = [];
  let n = 0;
  const client = {
    mode: "fake",
    calls,
    async complete(request) {
      calls.push(structuredClone(request));
      const i = n++;
      let r;
      if (typeof script === "function") r = await script(request, i);
      else if (Array.isArray(script)) {
        if (i >= script.length) throw new Error(`fake client: script exhausted (call ${i + 1}, ${script.length} scripted)`);
        r = script[i];
      } else throw new Error("fake client: script must be an array or a function");
      if (r instanceof Error) throw r;
      if (!r || typeof r !== "object") throw new Error("fake client: scripted response must be an object");
      const out = structuredClone(r);
      if (!out.model) out.model = opts.model || request.model;
      if (out.stop_reason === undefined) out.stop_reason = "end_turn";
      if (!Array.isArray(out.content)) out.content = [];
      if (!out.usage) out.usage = { input_tokens: 0, output_tokens: 0 };
      return out;
    },
  };
  return client;
}

// Convenience builders for scripts.
export const textResponse = (text, usage = { input_tokens: 100, output_tokens: 50 }) =>
  ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage });
export const toolUseResponse = (name, input, id = "toolu_fake_1", usage = { input_tokens: 100, output_tokens: 50 }) =>
  ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use", usage });

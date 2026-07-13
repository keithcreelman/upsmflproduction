// Guardrail (2026-07-13): no-undef would have caught the identity-patch
// ReferenceError BEFORE deploy ("thread" for "tracked" -> eternal "thinking...").
// Runs in deploy-worker.yml before every deploy; deploy fails on error.
export default [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Cloudflare Workers runtime
        Response: "readonly", Request: "readonly", Headers: "readonly",
        fetch: "readonly", URL: "readonly", URLSearchParams: "readonly",
        console: "readonly", crypto: "readonly", caches: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly",
        clearInterval: "readonly", atob: "readonly", btoa: "readonly",
        TextEncoder: "readonly", TextDecoder: "readonly", AbortController: "readonly",
        ReadableStream: "readonly", addEventListener: "readonly",
        FormData: "readonly", Blob: "readonly", structuredClone: "readonly",
        scheduler: "readonly", WebSocketPair: "readonly", HTMLRewriter: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "off",
    },
  },
];

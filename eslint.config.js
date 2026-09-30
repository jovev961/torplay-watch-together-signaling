export default [
  {
    ignores: ["node_modules/**", ".vercel/**", "coverage/**", "public/guest/app.js"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        URL: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
      "no-constant-condition": ["error", { "checkLoops": false }]
    },
  },
  {
    files: ["browser/**/*.js"],
    languageOptions: {
      globals: Object.fromEntries([
        "Blob", "DOMException", "HTMLMediaElement", "RTCPeerConnection", "WebSocket",
        "clearTimeout", "console", "crypto", "document", "fetch", "location",
        "queueMicrotask", "sessionStorage", "setInterval", "setTimeout", "URL",
      ].map((name) => [name, "readonly"])),
    },
  },
];

const distDir = new URL("../dist", import.meta.url).pathname;
await Deno.mkdir(distDir, { recursive: true });

const workerOut = `${distDir}/worker.js`;

const cmd = new Deno.Command("deno", {
  args: [
    "bundle",
    "--minify",
    "--platform",
    "browser",
    "--external",
    "cloudflare:workers",
    "--external",
    "node:*",
    "-o",
    workerOut,
    "src/worker.ts",
  ],
  stdout: "inherit",
  stderr: "inherit",
});

const status = await cmd.output();
if (!status.success) {
  Deno.exit(status.code);
}

const [rawCode, indexHtml, appHtml, docsHtml, ogPngBytes] = await Promise.all([
  Deno.readTextFile(workerOut),
  Deno.readTextFile(new URL("../web/index.html", import.meta.url)),
  Deno.readTextFile(new URL("../web/app.html", import.meta.url)),
  Deno.readTextFile(new URL("../web/docs.html", import.meta.url)),
  Deno.readFile(new URL("../web/og.png", import.meta.url)),
]);

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const embeddedTextFiles = JSON.stringify({
  "index.html": indexHtml,
  "app.html": appHtml,
  "docs.html": docsHtml,
});

const embeddedOgPngBase64 = JSON.stringify(toBase64(ogPngBytes));

const nodeBuiltins = new Set([
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "timers",
  "timers/promises",
  "tls",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

const header = `import { env as __cf_env } from "cloudflare:workers";
import { createRequire as __cf_createRequire } from "node:module";
const __cf_require = __cf_createRequire("file:///worker.js");
const __cf_text_files = ${embeddedTextFiles};
const __cf_og_png_b64 = ${embeddedOgPngBase64};
globalThis.__dirname = "/";
globalThis.__filename = "/worker.js";
if (typeof globalThis.process === "undefined") {
  globalThis.process = { env: {} };
}
globalThis.process.env ??= {};
if (__cf_env && typeof __cf_env === "object") {
  for (const [k, v] of Object.entries(__cf_env)) {
    if (typeof v === "string") globalThis.process.env[k] = v;
  }
}
const __cf_safe_require = function(spec) {
  if (spec === "node:process" || spec === "process") return globalThis.process;
  try {
    const mod = __cf_require(spec);
    return mod ?? {};
  } catch (_err) {
    return {};
  }
};
globalThis.require = __cf_safe_require;
globalThis.__cf_safe_require = __cf_safe_require;
if (typeof globalThis.addEventListener === "undefined") {
  globalThis.addEventListener = () => {};
}
if (typeof globalThis.fetch === "function") {
  globalThis.fetch = globalThis.fetch.bind(globalThis);
}
if (typeof globalThis.clearTimeout === "function") {
  globalThis.clearTimeout = globalThis.clearTimeout.bind(globalThis);
}
if (typeof globalThis.clearInterval === "function") {
  globalThis.clearInterval = globalThis.clearInterval.bind(globalThis);
}
if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.randomUUID) {
  const __orig_randomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto);
  let __uuid_counter = 0;
  globalThis.crypto.randomUUID = function() {
    try {
      return __orig_randomUUID();
    } catch (_err) {
      __uuid_counter++;
      return "00000000-0000-4000-8000-" + String(__uuid_counter).padStart(12, "0");
    }
  };
}
if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
  const __orig_getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  let __rv_counter = 1;
  globalThis.crypto.getRandomValues = function(arr) {
    try {
      return __orig_getRandomValues(arr);
    } catch (_err) {
      if (arr && typeof arr.length === "number") {
        for (let i = 0; i < arr.length; i++) {
          __rv_counter = (__rv_counter * 1664525 + 1013904223) >>> 0;
          arr[i] = __rv_counter & 0xff;
        }
      }
      return arr;
    }
  };
}
if (typeof globalThis.setTimeout !== "undefined") {
  const __orig_setTimeout = globalThis.setTimeout.bind(globalThis);
  globalThis.setTimeout = function(fn, ms, ...args) {
    try {
      return __orig_setTimeout(fn, ms, ...args);
    } catch (_err) {
      return 0;
    }
  };
}
if (typeof globalThis.setInterval !== "undefined") {
  const __orig_setInterval = globalThis.setInterval.bind(globalThis);
  globalThis.setInterval = function(fn, ms, ...args) {
    try {
      return __orig_setInterval(fn, ms, ...args);
    } catch (_err) {
      return 0;
    }
  };
}
if (typeof globalThis.Deno === "undefined") {
  globalThis.Deno = {
    env: {
      get(key) {
        return globalThis.process?.env?.[key] ?? __cf_env?.[key];
      },
      set(key, value) {
        if (globalThis.process?.env) globalThis.process.env[key] = String(value);
      },
      delete(key) {
        if (globalThis.process?.env) delete globalThis.process.env[key];
      },
      has(key) {
        return (globalThis.process?.env?.[key] ?? __cf_env?.[key]) !== undefined;
      },
      toObject() {
        return { ...(__cf_env || {}), ...(globalThis.process?.env || {}) };
      },
    },
    args: [],
    version: { deno: "2.0.0", v8: "0.0.0", typescript: "5.0.0" },
    build: {
      target: "x86_64-unknown-linux-gnu",
      arch: "x86_64",
      os: "linux",
      vendor: "unknown",
      env: "gnu",
    },
    errors: {
      NotFound: class NotFound extends Error {},
      AlreadyExists: class AlreadyExists extends Error {},
      PermissionDenied: class PermissionDenied extends Error {},
    },
    serve: () => ({ finished: new Promise(() => {}) }),
    cron: () => {},
    readFile: async (p) => {
      const s = String(p);
      if (s.endsWith("og.png")) {
        const bin = atob(__cf_og_png_b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr;
      }
      return new Uint8Array();
    },
    readTextFile: async (p) => {
      const s = String(p);
      for (const [k, v] of Object.entries(__cf_text_files)) {
        if (s.endsWith(k)) return v;
      }
      return "";
    },
    readTextFileSync: (p) => {
      const s = String(p);
      for (const [k, v] of Object.entries(__cf_text_files)) {
        if (s.endsWith(k)) return v;
      }
      return "";
    },
    writeFile: async () => {},
    writeTextFile: async () => {},
    mkdir: async () => {},
    remove: async () => {},
    stat: async () => ({ isFile: false, isDirectory: false }),
    exit: (code) => {
      throw new Error("Deno.exit(" + code + ")");
    },
  };
}
`;

const patchedCode = header + "\n" +
  rawCode
    .replaceAll(/![a-zA-Z0-9_$]+\.jitless/g, "false")
    .replaceAll("window.fetch", "globalThis.fetch")
    .replaceAll('typeof window<"u"&&!!window', "true")
    .replace(
      /\bfrom\s*["']([^"']+)["']/g,
      (match, spec) => nodeBuiltins.has(spec) ? `from "node:${spec}"` : match,
    )
    .replace(
      /throw Error\(`Dynamic require of "\$\{[a-zA-Z0-9_$]+\}" is not supported`\)/g,
      "return globalThis.__cf_safe_require(arguments[0])",
    )
    .replace(
      /export\{([a-zA-Z0-9_$]+) as worker\};?\s*$/,
      "export { $1 as worker, $1 as default };\n",
    );

await Deno.writeTextFile(workerOut, patchedCode);
console.log(
  `Successfully built and patched ${workerOut} for Cloudflare Workers (${
    Math.round(patchedCode.length / 1024)
  } KB)`,
);

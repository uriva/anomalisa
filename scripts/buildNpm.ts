import { build, emptyDir } from "@deno/dnt";
import denoJson from "../deno.json" with { type: "json" };

const outDir = "./dist/npm";
await emptyDir(outDir);

await build({
  entryPoints: ["./mod.ts"],
  outDir,
  importMap: "./deno.json",
  shims: {},
  scriptModule: false,
  test: false,
  typeCheck: "both",
  compilerOptions: {
    lib: ["ESNext", "DOM"],
    target: "Latest",
  },
  package: {
    name: "anomalisa",
    version: denoJson.version,
    description:
      "Zero-config statistical anomaly detection for your events. Send events, get emailed when something weird happens.",
    license: denoJson.license,
    homepage: "https://anomalisa.uriv.me",
    repository: {
      type: "git",
      url: "git+https://github.com/uriva/anomalisa.git",
    },
    bugs: {
      url: "https://github.com/uriva/anomalisa/issues",
    },
    keywords: [
      "anomaly-detection",
      "monitoring",
      "alerts",
      "observability",
      "error-tracking",
      "statistics",
      "welford",
      "events",
    ],
    engines: {
      node: ">=18",
    },
  },
  postBuild: () => {
    Deno.copyFileSync("README.md", `${outDir}/README.md`);
    Deno.copyFileSync("LICENSE", `${outDir}/LICENSE`);
    const pkgPath = `${outDir}/package.json`;
    const pkg = JSON.parse(Deno.readTextFileSync(pkgPath));
    pkg.type = "module";
    pkg.types = "./esm/mod.d.ts";
    pkg.main = "./esm/mod.js";
    pkg.exports = {
      ".": {
        types: "./esm/mod.d.ts",
        import: "./esm/mod.js",
        default: "./esm/mod.js",
      },
    };
    pkg.files = ["esm/", "README.md", "LICENSE"];
    delete pkg.dependencies;
    Deno.writeTextFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  },
});

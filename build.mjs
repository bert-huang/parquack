import * as esbuild from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Resvg } from "@resvg/resvg-js";

const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf-8"));

const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");
const doPackage = args.has("--package");
const target = (() => {
  for (const a of process.argv.slice(2)) {
    const m = /^--target=(firefox|chrome)$/.exec(a);
    if (m) return m[1];
  }
  return "firefox";
})();

const root = path.resolve(".");
const outDir = path.join(root, "build", target);
const dist = path.join(outDir, "dist");
const duckdbDist = path.join(root, "node_modules/@duckdb/duckdb-wasm/dist");

async function clean() {
  if (existsSync(outDir)) await rm(outDir, { recursive: true });
  await mkdir(dist, { recursive: true });
}

async function copyDuckdbAssets() {
  // Only ship the EH (exception-handling) bundle — supported by Firefox 95+
  // and modern Chrome, so the older MVP fallback is dead weight (~37 MB).
  const files = [
    "duckdb-eh.wasm",
    "duckdb-browser-eh.worker.js",
  ];
  for (const f of files) {
    const src = path.join(duckdbDist, f);
    if (!existsSync(src)) {
      throw new Error(`Missing duckdb asset: ${src}. Did you run npm install?`);
    }
    await cp(src, path.join(dist, f));
  }
}

async function copyStatic() {
  await cp(path.join(root, "src/viewer.html"), path.join(dist, "viewer.html"));
  await cp(path.join(root, "src/viewer.css"), path.join(dist, "viewer.css"));
  await cp(path.join(root, "src/icon.svg"), path.join(dist, "icon.svg"));
}

const ICON_SIZES = [16, 32, 48, 128];

async function renderIcons() {
  const svg = await readFile(path.join(root, "src/icon.svg"), "utf-8");
  for (const size of ICON_SIZES) {
    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
    const png = resvg.render().asPng();
    await writeFile(path.join(dist, `icon-${size}.png`), png);
  }
}

function iconSet() {
  const out = {};
  for (const s of ICON_SIZES) out[s] = `dist/icon-${s}.png`;
  return out;
}

function buildManifest() {
  const common = {
    manifest_version: 3,
    name: "Parquack",
    version: pkg.version,
    description: "View and query Parquet files in your browser — powered by DuckDB-WASM.",
    icons: iconSet(),
    action: {
      default_title: "Open Parquack",
      default_icon: iconSet(),
    },
    host_permissions: ["<all_urls>", "file:///*"],
    web_accessible_resources: [
      { resources: ["dist/*"], matches: ["<all_urls>"] },
    ],
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
  };

  if (target === "firefox") {
    return {
      ...common,
      browser_specific_settings: {
        gecko: {
          id: "parquack@local.dev",
          strict_min_version: "140.0",
          data_collection_permissions: { required: ["none"] },
        },
        gecko_android: {
          strict_min_version: "142.0", // data_collection_permissions introduced in Firefox for Android 142.
        },
      },
      background: { scripts: ["dist/background.js"] },
      permissions: ["declarativeNetRequest"],
    };
  }
  // chrome
  return {
    ...common,
    background: { service_worker: "dist/background.js" },
    permissions: ["tabs", "declarativeNetRequest"],
  };
}

async function writeManifest() {
  const manifest = buildManifest();
  await writeFile(
    path.join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

const entryPoints = {
  viewer: "src/viewer.js",
  background: "src/background.js",
};

// Replaces apache-arrow's builder/valid.mjs (which uses `new Function`) with a
// semantically equivalent Set-based implementation to satisfy AMO's linter.
const patchArrowValid = {
  name: "patch-arrow-valid",
  setup(build) {
    // apache-arrow imports valid.mjs as a relative path; gate on importer to
    // avoid catching unrelated modules.
    build.onResolve({ filter: /\/valid\.mjs$/ }, (args) => {
      if (args.importer.includes("apache-arrow")) {
        return { path: path.resolve(root, "src/patches/arrow-builder-valid.mjs") };
      }
    });
  },
};

// Watch builds keep source maps for debugging; one-shot builds drop them
// and minify, since they ship to users.
const buildOptions = {
  entryPoints,
  outdir: dist,
  bundle: true,
  format: "iife",
  target: target === "firefox" ? ["firefox140"] : ["chrome120"],
  platform: "browser",
  sourcemap: watch,
  minify: !watch,
  logLevel: "info",
  external: ["fs", "path", "worker_threads", "perf_hooks"],
  loader: { ".wasm": "file" },
  plugins: [patchArrowValid],
};

async function packageZip() {
  const outPath = path.join(outDir, "parquack.zip");
  if (existsSync(outPath)) await rm(outPath);

  await new Promise((resolve, reject) => {
    const proc = spawn(
      "zip",
      ["-r", "-q", outPath, "manifest.json", "dist", "-x", "dist/*.map"],
      { cwd: outDir, stdio: "inherit" },
    );
    proc.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`zip exited ${code}`)),
    );
    proc.on("error", reject);
  });
  console.log(`Packaged ${path.relative(root, outPath)}`);
}

async function build() {
  await clean();
  await copyDuckdbAssets();
  await copyStatic();
  await renderIcons();
  await writeManifest();

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log(`esbuild: watching for changes (target=${target})...`);
    return;
  }

  await esbuild.build(buildOptions);
  console.log(`Built for target=${target}`);

  if (doPackage) await packageZip();
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});

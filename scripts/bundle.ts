// Turns the ESM build (tsc, dist/*.js) into the single files games download from Powly Studio
// (Docs → Get started), served by apps/web/app/api/sdk/[file]/route.ts:
//
//   dist/powly.js           a classic script for games without a bundler: <script src="powly.js">
//                           defines `window.Powly`, and nothing else reaches the global scope
//   dist/powly.mjs          the same as one ES module: import Powly from "./powly.mjs"
//   dist/powly.d.ts         TypeScript types for both
//   dist/powly-example.zip     examples/starfall (an example game) with powly.js, ready to upload
//   dist/powly-playground.zip  examples/playground (every SDK function behind a button), likewise
//
// Each is the modules' code with imports and exports removed, concatenated.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SDK_VERSION } from "../src/version.ts";
import { zip } from "./zip.ts";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

// npm shows package.json's version, Studio and the bundles SDK_VERSION: bump both together.
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (version !== SDK_VERSION) {
  throw new Error(`package.json is at ${version} but src/version.ts at ${SDK_VERSION}`);
}

// The Powly origins the SDK trusts (src/origins.ts), from POWLY_SDK_ORIGINS when it's set.
const configured = process.env.POWLY_SDK_ORIGINS?.trim();
if (configured) {
  const origins = configured.split(",").map((value) => {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`POWLY_SDK_ORIGINS: not an http(s) origin: ${value}`);
    }
    return url.origin;
  });
  writeFileSync(
    resolve(dist, "origins.js"),
    `export const POWLY_ORIGINS = ${JSON.stringify(origins)};\n`,
  );
  console.log(`Trusted Powly origins: ${origins.join(", ")}`);
}

// In dependency order: each module only uses names of the ones before it.
const modules = [
  "version",
  "protocol",
  "origins",
  "errors",
  "pac",
  "realtime-protocol",
  "rooms",
  "twitch",
  "audio",
  "index",
];
// Each module's imports have to be listed before it. One left out would leave its names
// undefined in powly.js, which only fails once a game calls them (a missing twitch once left
// every game stuck connecting), so the build stops instead.
for (const [i, name] of modules.entries()) {
  const source = readFileSync(resolve(root, "src", `${name}.ts`), "utf8");
  for (const [, needed] of source.matchAll(/from\s+["']\.\/([\w-]+)\.ts["']/g)) {
    const at = needed === undefined ? -1 : modules.indexOf(needed);
    if (at === -1 || at > i) {
      throw new Error(`scripts/bundle.ts: ${name} imports ${needed}, which isn't listed before it`);
    }
  }
}

/** A module without its imports and `export` keywords (declarations stay, names unchanged). */
const strip = (file: string) =>
  readFileSync(resolve(dist, file), "utf8")
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^export\s+default\s+\w+;?\s*$/gm, "")
    .replace(/^export\s+(type\s+)?\{[^}]*\};?\s*$/gm, "")
    .replace(/^export\s+(declare\s+)?(const|function|class|async function|type)\s/gm, "$1$2 ")
    .replace(/^\/\/# sourceMappingURL=.*$/gm, "");

const code = modules.map((name) => strip(`${name}.js`)).join("\n");
const header = (what: string) => `/* Powly SDK ${SDK_VERSION}: ${what} */\n`;

writeFileSync(
  resolve(dist, "powly.js"),
  `${header("defines window.Powly")}(function () {\n"use strict";\n${code}\nwindow.Powly = Powly;\n})();\n`,
);
writeFileSync(
  resolve(dist, "powly.mjs"),
  `${header("ES module")}${code}\nexport { init, PowlyError, SDK_VERSION };\nexport default Powly;\n`,
);

// The types, the same way (declarations keep their `export`; one default export at the end).
const types = modules
  .map((name) =>
    readFileSync(resolve(dist, `${name}.d.ts`), "utf8")
      .replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
      .replace(/^export\s+(type\s+)?\{[^}]*\};?\s*$/gm, "")
      .replace(/^export\s+default\s+\w+;?\s*$/gm, ""),
  )
  .join("\n");
writeFileSync(
  resolve(dist, "powly.d.ts"),
  `${header("types for powly.js and powly.mjs")}${types}\nexport default Powly;\n\ndeclare global {\n  interface Window {\n    /** Set by powly.js (the classic script). */\n    Powly: typeof Powly;\n  }\n}\n`,
);

// The example games, each with the SDK it loads.
const examples = { starfall: "powly-example.zip", playground: "powly-playground.zip" };
for (const [folder, zipName] of Object.entries(examples)) {
  const dir = resolve(root, "examples", folder);
  const files = readdirSync(dir)
    .sort()
    .map((name) => ({ name, data: readFileSync(join(dir, name)) }));
  files.push({ name: "powly.js", data: readFileSync(resolve(dist, "powly.js")) });
  writeFileSync(resolve(dist, zipName), zip(files));
}

console.log("dist/powly.js, powly.mjs, powly.d.ts and the example zips written");

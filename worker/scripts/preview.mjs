#!/usr/bin/env node
// Local preview: starts `wrangler dev` (local only, no Cloudflare account),
// pushes the made-up example payloads from contract/examples through the real
// ingest route, fetches each screen, and writes PNGs to ../out/ (gitignored).
//
// For each screen it writes:
//   <screen>.png        example payload with as_of set to now (fresh data)
//   <screen>-stale.png  example payload with as_of 8 days ago (stale banner on any day)
//   <screen>-empty.png  before any data was pushed
//   <screen>-max.png    largest payload the contract allows (test/fixtures), fresh
//   <screen>-max-stale.png  the same, 8 days old, so the banner takes space too
//
// Secrets come from worker/.dev.vars (copy .dev.vars.example first).

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, "..");
const repoDir = resolve(workerDir, "..");
const outDir = join(repoDir, "out");

const SCREENS = [
  { screen: "trade-plans", source: "trade-plans", secretVar: "INGEST_SECRET_TRADING" },
  { screen: "market-summary", source: "market-summary", secretVar: "INGEST_SECRET_SUMMARY" },
];

async function readDevVars() {
  let text;
  try {
    text = await readFile(join(workerDir, ".dev.vars"), "utf8");
  } catch {
    throw new Error("worker/.dev.vars is missing. Run: cp worker/.dev.vars.example worker/.dev.vars");
  }
  const vars = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

function startDev() {
  // Its own persistence dir, wiped on every run, so the "-empty" previews
  // really have no data and never mix with `npm run dev` state.
  const persist = join(outDir, ".wrangler-preview-state");
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--port", "0", "--ip", "127.0.0.1", "--var", "ACCESS_DEV_BYPASS:1", "--persist-to", persist, "--show-interactive-dev-session=false"],
    { cwd: workerDir, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  return new Promise((resolveReady, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error(`wrangler dev did not start:\n${log}`)), 60_000);
    const onData = (buf) => {
      log += buf.toString();
      const m = log.match(/Ready on (http:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolveReady({ child, url: m[1].replace(/\/$/, "") });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`wrangler dev exited (${code}):\n${log}`)));
  });
}

async function ingest(url, source, secret, payload) {
  const res = await fetch(`${url}/ingest/${source}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status !== 204) throw new Error(`ingest ${source}: ${res.status} ${await res.text()}`);
}

async function fetchScreen(url, screen, file) {
  const res = await fetch(`${url}/screen/${screen}.png`);
  if (!res.ok) throw new Error(`screen ${screen}: ${res.status} ${await res.text()}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await writeFile(file, bytes);
  const v = new DataView(bytes.buffer);
  console.log(`${file}  ${v.getUint32(16)}x${v.getUint32(20)} depth=${bytes[24]} colorType=${bytes[25]} stale=${res.headers.get("x-data-stale")}`);
}

const vars = await readDevVars();
await mkdir(outDir, { recursive: true });
await rm(join(outDir, ".wrangler-preview-state"), { recursive: true, force: true });
const { child, url } = await startDev();
try {
  for (const { screen, source, secretVar } of SCREENS) {
    const example = JSON.parse(await readFile(join(repoDir, "contract", "examples", `${source}.json`), "utf8"));
    await fetchScreen(url, screen, join(outDir, `${screen}-empty.png`));
    await ingest(url, source, vars[secretVar], { ...example, as_of: new Date().toISOString(), market_status: undefined });
    await fetchScreen(url, screen, join(outDir, `${screen}.png`));
    const weekOld = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    await ingest(url, source, vars[secretVar], { ...example, as_of: weekOld });
    await fetchScreen(url, screen, join(outDir, `${screen}-stale.png`));
    const max = JSON.parse(await readFile(join(workerDir, "test", "fixtures", `${source}-max.json`), "utf8"));
    await ingest(url, source, vars[secretVar], { ...max, as_of: new Date().toISOString() });
    await fetchScreen(url, screen, join(outDir, `${screen}-max.png`));
    await ingest(url, source, vars[secretVar], { ...max, as_of: weekOld });
    await fetchScreen(url, screen, join(outDir, `${screen}-max-stale.png`));
  }
} finally {
  // npx starts wrangler, which starts workerd; signal the whole group.
  try {
    process.kill(-child.pid, "SIGINT");
  } catch {
    child.kill("SIGINT");
  }
}

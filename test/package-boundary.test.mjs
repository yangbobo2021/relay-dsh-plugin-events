import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Events Host uses Cordis directly and remains backend neutral", async () => {
  const host = await readFile(new URL("../host-plugin.js", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.doesNotMatch(host, /PluginHost|@relay\/|codex|claude/i);
  assert.equal(manifest.name, "relay-dsh-plugin-events");
  assert.deepEqual(Object.keys(manifest.dependencies), ["zod"]);
  assert.equal(manifest.exports["./contracts"], "./contracts/index.mjs");
});

test("SPEC and acceptance catalog cover every public Events responsibility", async () => {
  const spec = await readFile(new URL("../SPEC.md", import.meta.url), "utf8");
  const acceptance = await readFile(new URL("../docs/acceptance-scenarios.md", import.meta.url), "utf8");
  for (const term of ["Wait", "Event", "Delivery", "Router", "Monitor", "recovery", "Security"]) {
    assert.match(spec, new RegExp(term, "i"));
  }
  for (let id = 1; id <= 31; id += 1) {
    assert.match(acceptance, new RegExp(`EVT-${String(id).padStart(3, "0")}`));
  }
});

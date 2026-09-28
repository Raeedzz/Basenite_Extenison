/**
 * Whole-pipeline scenarios: the real service worker against a fake LinkedIn
 * and the strict Basanite fake base, with an auditor on every Airtable write
 * (10-record cap, no DELETE, no forbidden fields, Known by union, Photo and
 * Logo blank-only). Each scenario is a script in tests/pipeline/, run in its
 * own process so a "killed" worker's timers can't leak into the next.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("./pipeline/", import.meta.url));

function scenario(script, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, ...args], { cwd: DIR, env: { ...process.env, ...env }, timeout: 280_000, maxBuffer: 32 << 20 },
      (error, stdout, stderr) => (error ? reject(new Error(`${script} ${args.join(" ")} failed:\n${stderr || stdout}`)) : resolve(stdout)));
  });
}

function clean(output) {
  assert.match(output, /VIOLATIONS: none/, "an Airtable write broke a rule");
  assert.doesNotMatch(output, /dupes[^=]*=\["/, "a table got a duplicate row");
}

const options = { timeout: 300_000 };

// Separate processes: safe to run side by side.
describe("pipeline", { concurrency: 4 }, () => {
  test("a full sync twice: no duplicates, and the second sends nothing", options, async () => {
    const out = await scenario("s1.mjs");
    clean(out);
    assert.match(out, /sync2 writes: 0/);
  });

  for (const path of ["soft", "scheduled", "bulk", "company"]) {
    test(`a person a teammate added since the last read is updated, not duplicated (${path})`, options, async () => {
      const out = await scenario("s8.mjs", [path]);
      clean(out);
      assert.match(out, /rows for ada-number-10 = 1 → \S+ knownBy=\[\{"id":"usrTEAMMATE00001"\},\{"id":"usrTEST"\}\]/);
    });
  }

  for (const phase of ["base", "enrich"]) {
    test(`Sync right after Stop starts a new run that finishes (${phase})`, options, async () => {
      const out = await scenario("s5.mjs", [phase]);
      clean(out);
      assert.match(out, /"people":250/);
      assert.match(out, /checkpoint=undefined lock=undefined/);
    });
  }

  test("a bulk enrich stopped mid-batch stays stopped, even if the worker dies", options, async () => {
    const stopped = await scenario("s6.mjs", ["cancel"], { SLOW: "300" });
    clean(stopped);
    const killed = await scenario("s6.mjs", ["cancelkill"], { SLOW: "300" });
    clean(killed);
    assert.match(killed, /stored job flipped back to running after cancel: false/);
    assert.match(killed, /"people":20,/);
  });

  test("resuming a paused bulk enrich writes everyone, including the batches LinkedIn returned empty", options, async () => {
    const out = await scenario("s6b.mjs");
    clean(out);
    assert.match(out, /people in Airtable: 40\/40; never written: 0/);
  });

  test("company capture and mutuals: no row for a profile LinkedIn wouldn't open", options, async () => {
    const out = await scenario("s7.mjs");
    clean(out);
    assert.match(out, /row for unresolvable target: none/);
  });

  test("a worker killed just after a sync completes: the next Sync reads LinkedIn again", options, async () => {
    const out = await scenario("s3b.mjs", ["complete"]);
    clean(out);
    assert.match(out, /people=35 \(LinkedIn has 35\)/);
  });
});

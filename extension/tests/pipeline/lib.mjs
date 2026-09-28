// Pipeline scenarios: fresh-module-graph worker boots, a fake LinkedIn
// Voyager with full profiles, the strict Basanite fake base, and an auditor
// that checks every Airtable write against the rules.
import { registerHooks } from "node:module";

import { fileURLToPath } from "node:url";

export const EXT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const EXT_URL = `file://${EXT}/`;

// Every boot gets its own copy of every extension module, so a "fresh worker"
// really starts with empty memory (like a killed MV3 worker).
globalThis.__BOOT_GEN = 0;
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    if (r.url.startsWith(EXT_URL) && !r.url.startsWith(`${EXT_URL}tests/`) && !r.url.endsWith(".wasm")) {
      let gen = null;
      try { gen = context.parentURL ? new URL(context.parentURL).searchParams.get("gen") : null; } catch {}
      const u = new URL(r.url);
      u.searchParams.set("gen", gen ?? String(globalThis.__BOOT_GEN));
      return { ...r, url: u.href, shortCircuit: true };
    }
    return r;
  },
});

const { fakeBase, BASE_ID } = await import(`${EXT}/tests/helpers/fake-airtable.mjs`);
export const L = await import(`${EXT}/tests/helpers/basanite-base.mjs`);
export { BASE_ID };

// ─── clock warp (for 60s LinkedIn cooldowns) ────────────────────────────────
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
export function warp(ms) { clockOffset += ms; }

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(read, what = "condition", ms = 120_000) {
  const end = realNow() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (realNow() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

// ─── LinkedIn fake ──────────────────────────────────────────────────────────
const FUT = Math.floor(realNow() / 1000) + 30 * 86400;
const vec = (id, kind, sizes) => ({
  rootUrl: `https://media.licdn.com/dms/image/v2/${id}/`,
  artifacts: sizes.map((w) => ({ width: w, height: w, fileIdentifyingUrlPathSegment: `${kind}_${w}_${w}/0/17?e=${FUT}&v=beta&t=s${Math.random().toString(36).slice(2, 6)}` })),
});
export const COMPANIES = [
  { id: 101, name: "Acme", uname: "acme" },
  { id: 102, name: "Globex", uname: "globex" },
  { id: 103, name: "Initech", uname: "initech" },
  { id: 104, name: "Umbrella", uname: "umbrella" },
];
export const SCHOOLS = [
  { id: 201, name: "MIT" },
  { id: 202, name: "Stanford" },
  { id: 203, name: "CMU" },
];
const company = (c) => ({ entityUrn: `urn:li:fsd_company:${c.id}`, name: c.name, logo: { vectorImage: vec(`${c.uname}-inline`, "company-logo", [100, 200, 400]) } });
const school = (s) => ({ entityUrn: `urn:li:fsd_school:${s.id}`, name: s.name, logo: { vectorImage: vec(`school-${s.id}`, "school-logo", [100, 200, 400]) } });
export const urnFor = (i) => `urn:li:fsd_profile:ACoAA${i}`;
export const pub = (i) => `ada-number-${i}`;
export const urlFor = (i) => `https://www.linkedin.com/in/${pub(i)}`;

export function profileRecord(i) {
  const cur = COMPANIES[i % COMPANIES.length];
  const past = COMPANIES[(i + 1) % COMPANIES.length];
  const sch = SCHOOLS[i % SCHOOLS.length];
  return {
    publicIdentifier: pub(i), entityUrn: urnFor(i), firstName: "Ada", lastName: `Number${i}`,
    headline: `Engineer ${i}`, summary: `About ${i}`,
    geoLocation: { geo: { defaultLocalizedNameWithoutCountryName: "San Francisco Bay Area" } },
    profilePicture: { displayImageReference: { vectorImage: vec(`photo-${i}`, "profile-displayphoto-shrink", [100, 200, 400, 800]) } },
    profilePositionGroups: { elements: [
      { companyName: cur.name, companyUrn: `urn:li:fsd_company:${cur.id}`, company: company(cur),
        profilePositionInPositionGroup: { elements: [{ title: "CTO", companyName: cur.name, companyUrn: `urn:li:fsd_company:${cur.id}`, dateRange: { start: { year: 2020, month: 1 } } }] } },
      { companyName: past.name, companyUrn: `urn:li:fsd_company:${past.id}`, company: company(past),
        profilePositionInPositionGroup: { elements: [{ title: "Engineer", companyName: past.name, companyUrn: `urn:li:fsd_company:${past.id}`, dateRange: { start: { year: 2015, month: 3 }, end: { year: 2019, month: 12 } } }] } },
    ] },
    profileEducations: { elements: [{ schoolName: sch.name, schoolUrn: `urn:li:fsd_school:${sch.id}`, school: school(sch), degreeName: "BS", fieldOfStudy: "CS", dateRange: { start: { year: 2008 }, end: { year: 2012 } } }] },
  };
}

const searchHit = (i, distance = "DISTANCE_2") => ({ item: { entityResult: {
  entityUrn: `urn:li:fsd_entityResultViewModel:(${urnFor(i)},SEARCH_SRP,DEFAULT)`,
  title: { text: `Ada Number${i}` }, primarySubtitle: { text: `Engineer ${i}` },
  navigationUrl: `https://www.linkedin.com/in/${pub(i)}?miniProfileUrn=x`,
  image: { attributes: [{ detailData: { nonEntityProfilePicture: { vectorImage: vec(`search-${i}`, "profile-displayphoto-shrink", [100, 200, 400, 800]) } } }] },
  entityCustomTrackingInfo: { memberDistance: distance },
} } });

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * opts: connections (count or () => count), companyPeople ([i...]), bridgesFor (i => [j...]),
 *       hook(url, u) → Response|undefined to inject faults, delayMs(url)
 */
export function fakeLinkedIn(opts = {}) {
  const stats = { profileBatch: 0, profileSingle: 0, connections: 0, companyDetails: 0, profileUrns: [] };
  const conns = () => (typeof opts.connections === "function" ? opts.connections() : opts.connections ?? 25);
  async function handle(url) {
    const u = new URL(url, "https://www.linkedin.com");
    const d = opts.delayMs?.(url, u) || 0;
    if (d) await sleep(d);
    const injected = await opts.hook?.(url, u);
    if (injected) return injected;
    if (u.pathname === "/voyager/api/identity/dash/profiles") {
      const ids = u.searchParams.get("ids");
      if (ids) {
        stats.profileBatch++;
        const results = {};
        for (const urn of ids.slice(5, -1).split(",").map(decodeURIComponent)) {
          stats.profileUrns.push(urn);
          results[urn] = profileRecord(Number(urn.replace("urn:li:fsd_profile:ACoAA", "")));
        }
        return json({ statuses: {}, results, errors: {} });
      }
      stats.profileSingle++;
      const i = Number((u.searchParams.get("memberIdentity") || "").replace("ada-number-", ""));
      if (!Number.isFinite(i) || !(u.searchParams.get("memberIdentity") || "").startsWith("ada-number-")) return json({}, 404);
      return json({ elements: [profileRecord(i)] });
    }
    if (u.pathname === "/voyager/api/relationships/dash/connections") {
      stats.connections++;
      const N = conns();
      const start = Number(u.searchParams.get("start")) || 0;
      return json({
        elements: Array.from({ length: Math.max(0, Math.min(100, N - start)) }, (_, k) => start + k).map((i) => ({
          entityUrn: `urn:li:fsd_connection:ACoAA${i}`,
          connectedMemberResolutionResult: {
            entityUrn: urnFor(i), firstName: "Ada", lastName: `Number${i}`, publicIdentifier: pub(i), headline: `Engineer ${i}`,
            profilePicture: { displayImageReference: { vectorImage: vec(`conn-${i}`, "profile-displayphoto-shrink", [100, 200, 400, 800]) } },
          },
          createdAt: Date.UTC(2023, 10, 14),
        })),
        paging: { start, count: 100, total: N },
      });
    }
    const cm = u.pathname.match(/^\/voyager\/api\/(?:organization|entities)\/companies\/(\d+)/);
    if (cm) {
      stats.companyDetails++;
      const c = COMPANIES.find((x) => String(x.id) === cm[1]);
      if (!c) return json({}, 404);
      return json({ elements: [{ entityUrn: `urn:li:fsd_company:${c.id}`, universalName: c.uname, name: c.name, description: `${c.name} about`,
        companyPageUrl: `https://${c.uname}.example.com`, companyIndustries: [{ localizedName: "Software" }],
        logo: { image: { "com.linkedin.common.VectorImage": vec(`${c.uname}-details`, "company-logo", [100, 200, 400]) } } }] });
    }
    if (u.pathname === "/voyager/api/organization/companies") {
      const slug = u.searchParams.get("universalName");
      const c = COMPANIES.find((x) => x.uname === slug);
      return json({ elements: c ? [{ entityUrn: `urn:li:fsd_company:${c.id}`, universalName: c.uname, name: c.name }] : [] });
    }
    if (u.pathname === "/voyager/api/search/dash/clusters") {
      const q = decodeURIComponent(u.searchParams.get("query") || "");
      const start = Number(u.searchParams.get("start")) || 0;
      if (q.includes("resultType:List(COMPANIES)")) {
        const kw = (q.match(/keywords:([^,]+)/)?.[1] || "").toLowerCase();
        const c = COMPANIES.find((x) => x.name.toLowerCase() === kw) || COMPANIES[0];
        return json({ elements: [{ items: [{ item: { entityResult: { entityUrn: `urn:li:fsd_company:${c.id}`, title: { text: c.name } } } }] }] });
      }
      if (q.includes("currentCompany:List(")) {
        const people = opts.companyPeople || [];
        if (start > 0) return json({ elements: [], metadata: { totalResultCount: people.length } });
        return json({ elements: [{ items: people.map((i) => searchHit(i, i < conns() ? "DISTANCE_1" : "DISTANCE_2")) }], metadata: { totalResultCount: people.length } });
      }
      const co = q.match(/connectionOf:List\(ACoAA(\d+)\)/);
      if (co) {
        const bridges = opts.bridgesFor?.(Number(co[1])) || [];
        if (start > 0) return json({ elements: [], metadata: { totalResultCount: bridges.length } });
        return json({ elements: [{ items: bridges.map((j) => searchHit(j, "DISTANCE_1")) }], metadata: { totalResultCount: bridges.length } });
      }
      return json({ elements: [], metadata: { totalResultCount: 0 } });
    }
    return json({});
  }
  return { handle, stats };
}

// ─── Airtable fake + auditor ─────────────────────────────────────────────────
export const FORBIDDEN = new Map([
  ["fldi7jFNhhkLJCLmV", "People.Roles"],
  ["fld6F1WO8GBqO9TL7", "People.Companies"],
  ["fldpst66YX7LQJK3R", "People.Companies (Founders)"],
  ["fldBasaniteId0001", "People.Basanite ID"],
  ["fldReviewState001", "People.Review state"],
  ["fldCanonical00001", "People.Canonical version"],
  ["fldSource00000001", "People.Source"],
  ["fldSetupSample001", "People.Setup sample — Title"],
  ["fldIRzEraQrrRWzCR", "People.DELETE ME (old Education link)"],
  ["flduR4OmOvSkSIuiP", "Education.DELETE ME (old link)"],
]);
export const F = {
  pName: "fldqwePau2SiMdzzW", pUrl: "fldvyrmtV2q06ip6k", pKnownBy: "fldC0cY3rR5dWzKB9", pPhoto: "fldgPl6eKZLPIuLHw",
  pWorkedAt: "flddIyGX4W7BKfj19", pCurrent: "fldbic0J90xFTmFJn", pSchools: "fldSPy2fWWELX0wKZ", pHeadline: "fld3BmFW5JllGAygg",
  cName: "fldzBJ1c98Y5wviTm", cUrl: "fldrtMFdA0cHj9Aeh", cLogo: "fldXCHnaWiGzwjjUW",
  eName: "fldk389mX9pLnMj62", eLogo: "fldgTt4dOwtEVRLNc",
  wTitle: "fldXwAfDqpN13BSwM", wCompany: "flduTDvxs0L1eWyWD", wPerson: "fldjmSvXmRCd98JMk", wStart: "fldfsvlMrvrGJCdFA",
};
const LOGO_FIELDS = new Map([[L.COMPANIES, F.cLogo], [L.EDUCATION, F.eLogo], [L.PEOPLE, F.pPhoto]]);
const blank = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

export function makeBase(seed = {}) {
  const tables = L.BASANITE_TABLES.map((t) => ({ ...t, records: seed[t.id] || [] }));
  const base = fakeBase({ tables });
  const violations = [];
  const writes = [];
  let phase = "setup";
  const original = base.handle;
  base.handle = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    const tableId = url.pathname.split("/")[3];
    // A read sent as POST …/listRecords isn't a write.
    if (method !== "GET" && url.pathname.startsWith(`/v0/${BASE_ID}/`) && !url.pathname.endsWith("/listRecords")) {
      writes.push({ phase, method, tableId, n: body?.records?.length || 0, body });
      const where = `[${phase}] ${method} ${tableId}`;
      if (method === "DELETE") violations.push(`${where}: DELETE`);
      if ((body?.records?.length || 0) > 10) violations.push(`${where}: ${body.records.length} records in one request`);
      if (tableId === L.ROLES) violations.push(`${where}: wrote the Roles table`);
      const table = base.state.get(tableId);
      for (const rec of body?.records || []) {
        for (const fid of Object.keys(rec.fields || {})) {
          if (FORBIDDEN.has(fid)) violations.push(`${where}: wrote forbidden ${FORBIDDEN.get(fid)}`);
        }
        if (method === "PATCH" && table) {
          const cur = table.records.get(rec.id)?.fields || {};
          if (tableId === L.PEOPLE && F.pKnownBy in rec.fields) {
            const before = (cur[F.pKnownBy] || []).map((u) => u.id || u.email);
            const after = (rec.fields[F.pKnownBy] || []).map((u) => u.id || u.email);
            const lost = before.filter((x) => !after.includes(x));
            if (lost.length) violations.push(`${where}: Known by dropped ${lost.join(",")} on ${rec.id}`);
          }
          const imgField = LOGO_FIELDS.get(tableId);
          if (imgField && imgField in rec.fields && !blank(cur[imgField])) {
            violations.push(`${where}: overwrote non-blank ${imgField} on ${rec.id}`);
          }
          // link union: a union link column must never lose ids
          for (const fid of [F.pWorkedAt, F.pSchools]) {
            if (tableId === L.PEOPLE && fid in rec.fields) {
              const lost = (cur[fid] || []).filter((x) => !rec.fields[fid].includes(x));
              if (lost.length) violations.push(`${where}: link ${fid} dropped ${lost} on ${rec.id}`);
            }
          }
        }
      }
    }
    return original(input, init);
  };
  const rows = (t) => base.rows(t);
  function dupes() {
    const out = [];
    const count = (list, key, label) => {
      const m = new Map();
      for (const r of list) { const k = key(r); if (!k) continue; m.set(k, (m.get(k) || 0) + 1); }
      for (const [k, n] of m) if (n > 1) out.push(`${label} ${k} x${n}`);
    };
    count(rows(L.PEOPLE), (r) => r.fields[F.pUrl]?.toLowerCase(), "People");
    count(rows(L.COMPANIES), (r) => (r.fields[F.cName] || "").toLowerCase(), "Companies(name)");
    count(rows(L.COMPANIES), (r) => (r.fields[F.cUrl] || "").toLowerCase(), "Companies(url)");
    count(rows(L.EDUCATION), (r) => (r.fields[F.eName] || "").toLowerCase(), "Education");
    count(rows(L.WORK), (r) => [r.fields[F.wPerson]?.[0], r.fields[F.wCompany]?.[0], r.fields[F.wTitle], r.fields[F.wStart]].join("|"), "Work");
    return out;
  }
  const counts = () => ({ people: rows(L.PEOPLE).length, companies: rows(L.COMPANIES).length, schools: rows(L.EDUCATION).length, work: rows(L.WORK).length, roles: rows(L.ROLES).length });
  const writesIn = (p) => writes.filter((w) => w.phase === p);
  return { base, violations, writes, writesIn, setPhase: (p) => { phase = p; }, dupes, counts, rows };
}

// ─── boot ────────────────────────────────────────────────────────────────────
export const cookies = { get: async ({ name }) => ({ value: name === "JSESSIONID" ? '"ajax:1234"' : `${name}-value` }) };

/** Boot a worker (fresh modules). Returns worker + kill() that freezes its fetches forever. */
// Each boot runs in its own async context: its chrome, its fetch, its timers.
// kill() freezes that context for good (storage, fetch and timers never
// answer again), which is what a terminated MV3 worker looks like.
import { AsyncLocalStorage } from "node:async_hooks";
const als = new AsyncLocalStorage();
const fallback = { chrome: undefined, fetch: globalThis.fetch };
const hang = () => new Promise(() => {});
const deadChrome = new Proxy(function () {}, { get: () => deadChrome, apply: () => hang() });
for (const name of ["chrome", "fetch"]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      const ctx = als.getStore();
      if (!ctx) return fallback[name];
      if (ctx.dead) return name === "chrome" ? deadChrome : hang;
      return ctx[name];
    },
    set(v) { const ctx = als.getStore(); if (ctx) ctx[name] = v; else fallback[name] = v; },
  });
}
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const ctx = als.getStore();
  return realSetTimeout(() => { if (ctx?.dead) return; fn(...args); }, ms);
};

export async function boot({ airtable, linkedin, storage, killOn = null } = {}) {
  globalThis.__BOOT_GEN++;
  const ctx = { gen: globalThis.__BOOT_GEN, dead: false };
  let airtableWrites = 0;
  let w;
  const killNow = () => {
    if (ctx.dead) return ctx.killedSnapshot;
    ctx.killedSnapshot = Object.fromEntries([...w.store.entries()].map(([k, v]) => [k, structuredClone(v)]));
    ctx.dead = true;
    return ctx.killedSnapshot;
  };
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("https://api.airtable.com/")) {
      const method = (init.method || "GET").toUpperCase();
      if (method !== "GET" && killOn && !new URL(url).pathname.endsWith("/listRecords")) {
        airtableWrites++;
        const verdict = killOn({ url: new URL(url), method, body: init.body ? JSON.parse(init.body) : null, n: airtableWrites });
        if (verdict === "before") { killNow(); return hang(); }
        if (verdict === "after") { await airtable.base.handle(input, init); killNow(); return hang(); }
      }
      return airtable.base.handle(input, init);
    }
    if (url.includes("media.licdn.com")) return new Response(null, { status: 200, headers: { "content-type": "image/jpeg" } });
    if (url.includes("capture-worker.wasm")) return new Response("no", { status: 404 });
    return linkedin.handle(url);
  };
  // A harness of its own per boot, so booting one worker never cancels another.
  const { bootWorker } = await import(`${EXT}/tests/helpers/worker-harness.mjs?h=${ctx.gen}`);
  w = await als.run(ctx, () => bootWorker({ fetch: fetchImpl, cookies, storage }));
  const send = w.send;
  w.send = (message, sender) => als.run(ctx, () => send(message, sender));
  const fire = w.fireAlarm;
  w.fireAlarm = (name) => als.run(ctx, () => fire(name));
  w.snapshot = () => Object.fromEntries([...w.store.entries()].map(([k, v]) => [k, structuredClone(v)]));
  w.kill = killNow;
  w.killed = () => ctx.killedSnapshot || null;
  w.isDead = () => ctx.dead;
  w.ctx = ctx;
  return w;
}

export async function setupAirtable(w) {
  const c = await w.send({ type: "AIRTABLE_CONNECT", token: "patTESTTOKEN.0123456789abcdef" });
  if (c.error) throw new Error(c.error);
  const cfg = await w.send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: L.PEOPLE });
  if (cfg.problem || cfg.error) throw new Error(cfg.problem || cfg.error);
  return cfg;
}

export const finished = (store, key = "capture_progress") => {
  const p = store.get(key);
  return p && ["complete", "error", "canceled"].includes(p.status) ? p : null;
};

export async function runCapture(w, message, what = "capture") {
  const r = await w.send({ type: "START_CAPTURE", site: "linkedin", ...message });
  if (r?.error) throw new Error(`${what}: ${r.error}`);
  const runId = r.runId;
  const done = await until(() => { const p = finished(w.store); return p && p.runId === runId ? p : null; }, what, 180_000);
  // let the finally/settled hooks run
  await sleep(150);
  return { start: r, done };
}

export function report(name, lines) {
  console.log(`\n==== ${name} ====`);
  for (const l of lines) console.log(l);
}

// quiet the worker's chatty logs unless VERBOSE
if (!process.env.VERBOSE) {
  const keep = console.log.bind(console);
  console.log = (...args) => {
    const s = String(args[0] ?? "");
    if (/^\[(EarthOS|Airtable|BulkEnrich)/.test(s)) return;
    keep(...args);
  };
  const keepErr = console.error.bind(console);
  console.error = (...args) => {
    const s = String(args[0] ?? "");
    if (/^\[(EarthOS|Airtable|BulkEnrich)/.test(s) && !process.env.SHOWERR) return;
    keepErr(...args);
  };
}

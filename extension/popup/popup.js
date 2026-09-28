import { canMap, canonicalLinkedinUrl, SOURCE_FIELDS, suggestMapping } from "../lib/airtable-fields.js";
import { INTERACTION_TYPES, interactionTables } from "../lib/airtable-interactions.js";
import { canPlay, LINKED_TABLES, PEOPLE_LINKS } from "../lib/airtable-linked.js";
import {
  formatCount,
  progressLabel,
  relativeTime,
  stageHeadline,
  stageMessage,
  syncHistoryDetail,
} from "../lib/progress-copy.js";
import { normalizeSoftSyncPrefs } from "../lib/soft-sync-prefs.js";

const LOG = (...args) => console.log("[Panel]", ...args);
const $ = (id) => document.getElementById(id);

const HEALTH_KEY = "earthos_connection_health";
const THEME_KEY = "heart_theme";
const PREFS_KEY = "earthos_soft_sync_prefs";
const SOFT_STATUS_KEY = "earthos_soft_sync_status";
const INITIAL_SYNC_KEY = "earthos_initial_sync_done";
const BULK_JOB_KEY = "bulk_enrich_job";
const PROGRESS_KEYS = ["capture_progress", "enrich_progress", "mutual_progress", "company_progress"];

// The Airtable config as the worker shows it (never the token itself).
let config = null;
// Settings is the setup view reopened after setup is done.
let settingsOpen = false;
// First setup stays open after the table is picked, so the columns can be
// checked before capturing; "Start capturing" ends it.
let reviewing = false;
// Calls that answer directly (profile add, search) and write no progress
// record: while any is out, the poll mustn't reset the panel to Ready.
let inFlight = 0;
let connectionHealth = null;
let busy = false;
let clearTimer = null;
let errorActive = false;
let errorAction = null;
// An error rendered straight from a failed start (not from a stored progress
// record): the same failure may also land in storage, and is already shown.
let errorFromStart = false;
// A paused bulk enrich; it can be resumed from where it stopped.
let bulkJob = null;

// Log interaction.
// Types in the order they were picked; the summary reads in that order.
let picked = [];
let whenTouched = false;
let logging = false;
let lastLogFailed = false;
// A note that landed before its interaction failed: Retry links it, never writes another.
let pendingNoteId = null;
// The time a failed log was sent with: Retry keeps it, so the interaction matches its note.
let failedAt = null;
let statusTimer = null;

/** A worker call; answers carrying `error` throw it. */
async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (response?.error) throw new Error(response.error);
  return response;
}

// ─── Theme ───────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  if (theme !== "light" && theme !== "dark") return;
  document.documentElement.dataset.theme = theme;
  $("theme-toggle").setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
}

applyTheme(document.documentElement.dataset.theme);

$("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  chrome.storage.local.set({ [THEME_KEY]: next }).catch(() => {});
});

// ─── Views ───────────────────────────────────────────────────────────────────

/** Capture exists only once Airtable can take what it captures. */
function ready() {
  return Boolean(config && !config.problem);
}

function renderView() {
  const setup = !ready() || settingsOpen || reviewing;
  $("view-setup").classList.toggle("hidden", !setup);
  $("view-main").classList.toggle("hidden", setup);
  $("settings-btn").classList.toggle("hidden", setup);
  const settings = settingsOpen && ready();
  $("back-btn").classList.toggle("hidden", !settings);
  $("setup-title").textContent = settings ? "Settings" : "Connect Airtable";
  $("setup-lede").classList.toggle("hidden", settings);
  $("settings-extra").classList.toggle("hidden", !settings);
  $("done-btn").classList.toggle("hidden", settings || !ready() || !reviewing);
}

$("settings-btn").addEventListener("click", () => {
  settingsOpen = true;
  for (const step of document.querySelectorAll(".step")) step.classList.remove("open");
  renderSetup();
  renderView();
});

function closeSettings() {
  settingsOpen = false;
  reviewing = false;
  renderView();
  if (!busy && !errorActive) renderIdle();
}

$("back-btn").addEventListener("click", closeSettings);
$("done-btn").addEventListener("click", closeSettings);

// ─── Setup ───────────────────────────────────────────────────────────────────

const baseSelect = $("base-select");
const tableSelect = $("table-select");
const keySelect = $("key-select");
const mappingList = $("mapping-list");
let tablesByBase = new Map();
let suggestedByBase = new Map();

function option(value, label, { selected = false, disabled = false } = {}) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  element.selected = selected;
  element.disabled = disabled;
  return element;
}

function setNote(message, isError = false) {
  $("setup-note").textContent = message || "";
  $("setup-note").classList.toggle("error", isError);
}

for (const step of document.querySelectorAll(".step")) {
  const dot = step.querySelector(".dot");
  dot.dataset.n = dot.textContent;
}

function setStep(id, state, value = "") {
  const step = $(id);
  const dot = step.querySelector(".dot");
  step.dataset.state = state;
  step.querySelector(".step-value").textContent = state === "done" ? value : "";
  step.querySelector(".edit").textContent = state === "optional" ? "Set up" : "Change";
  dot.textContent = state === "done" ? "✓" : dot.dataset.n;
}

for (const edit of document.querySelectorAll(".edit")) {
  edit.addEventListener("click", () => $(edit.dataset.step).classList.add("open"));
}

function mappedCount() {
  return Object.keys(config?.mapping || {}).length;
}

function renderSetup() {
  const connected = Boolean(config?.connected);
  const hasTable = connected && Boolean(config.tableId);
  const syncingAs = config?.syncAsEmail || config?.userEmail || config?.userId || config?.tokenHint || "";
  setStep("step-token", connected ? "done" : "active",
    config?.knownByBlocked ? "Known by is off" : syncingAs ? `Syncing as ${syncingAs}` : "");
  $("knownby-note").classList.toggle("hidden", !config?.knownByBlocked);
  if (document.activeElement !== $("sync-as-input")) $("sync-as-input").value = config?.syncAsEmail || "";
  setStep("step-table", !connected ? "todo" : hasTable ? "done" : "active", hasTable ? `${config.baseName} › ${config.tableName}` : "");
  if (config?.peopleMismatch) {
    setNote(`${config.peopleMismatch.via} links people in ${config.peopleMismatch.name}, but step 2 is ${config.tableName}. Change it to ${config.peopleMismatch.name}.`, true);
  }
  setStep("step-columns", !hasTable ? "todo" : config.problem ? "active" : "done", `${mappedCount()} of ${SOURCE_FIELDS.length}`);
  const linkedNames = LINKED_TABLES.filter((def) => config?.linkedReady?.[def.key]).map((def) => config.linked[def.key].tableName);
  setStep("step-linked", !hasTable || config.problem ? "todo" : linkedNames.length ? "done" : "optional", linkedNames.join(" · "));
  if (!connected) {
    // Nothing from the last connection stays on screen, or clickable.
    for (const step of document.querySelectorAll(".step")) step.classList.remove("open");
    baseSelect.replaceChildren();
    tableSelect.replaceChildren();
    delete tableSelect.dataset.base;
    mappingList.replaceChildren();
    keySelect.replaceChildren();
    $("create-fields-btn").disabled = true;
    return;
  }
  // The setup was moved or changed behind the panel (e.g. to the People table).
  if (config.notice) setNote(config.notice);
  else if (!config.problem && $("setup-note").classList.contains("error")) setNote("");

  baseSelect.replaceChildren(
    option("", config.bases.length ? "Choose a base" : "The token can't see any bases", { selected: !config.baseId, disabled: true }),
    ...config.bases.map((base) => option(base.id, base.name, { selected: base.id === config.baseId })),
  );
  // The only base this token can write to is the one people go into.
  const writable = config.bases.filter((base) => ["create", "edit", "owner"].includes(base.permissionLevel));
  if (!config.baseId && !baseSelect.value && writable.length === 1) baseSelect.value = writable[0].id;
  if (baseSelect.value !== tableSelect.dataset.base) {
    tableSelect.dataset.base = baseSelect.value;
    void renderTableSelect(baseSelect.value);
  } else if (config.tableId) {
    tableSelect.value = config.tableId;
  }
  if (hasTable) renderMapping();
  if (hasTable) renderLinked();
  renderTableState();
}

// ─── Linked tables ───────────────────────────────────────────────────────────

const linkedList = $("linked-list");
// Which parts' column lists are open, kept across re-renders.
const openLinkedParts = new Set();

function chosenTableIds() {
  const ids = { people: config.tableId };
  for (const def of LINKED_TABLES) if (config.linked?.[def.key]?.tableId) ids[def.key] = config.linked[def.key].tableId;
  return ids;
}

function roleSelect(dataset, label, candidates, selectedId, required) {
  const select = document.createElement("select");
  Object.assign(select.dataset, dataset);
  select.setAttribute("aria-label", label);
  select.append(option("", required ? "Choose a column" : "Skip", { selected: !selectedId }));
  for (const field of candidates) select.append(option(field.id, field.name, { selected: field.id === selectedId }));
  select.classList.toggle("unmapped", !selectedId);
  select.addEventListener("change", () => void saveLinked());
  return select;
}

function renderLinked() {
  const tables = (config.baseTables || []).filter((table) => table.id !== config.tableId);
  const tableIds = chosenTableIds();
  const parts = [];
  for (const def of LINKED_TABLES) {
    const saved = config.linked?.[def.key];
    const part = document.createElement("div");
    part.className = "linked-part";
    const head = document.createElement("div");
    head.className = "part-head";
    const name = document.createElement("span");
    name.textContent = def.label;
    const tableSelect = document.createElement("select");
    tableSelect.dataset.part = def.key;
    tableSelect.setAttribute("aria-label", `${def.label} table`);
    tableSelect.append(option("", "None", { selected: !saved?.tableId }));
    const takenElsewhere = new Set(LINKED_TABLES.filter((other) => other.key !== def.key).map((other) => tableIds[other.key]));
    for (const table of tables) {
      tableSelect.append(option(table.id, table.name, { selected: table.id === saved?.tableId, disabled: takenElsewhere.has(table.id) }));
    }
    tableSelect.addEventListener("change", () => void changeLinkedTable(def.key, tableSelect.value));
    head.append(name, tableSelect);
    part.append(head);
    const table = tables.find((candidate) => candidate.id === saved?.tableId);
    if (table) {
      const mapped = def.fields.filter((role) => saved.fields?.[role.key]).length;
      const more = document.createElement("details");
      more.className = "more";
      more.open = openLinkedParts.has(def.key);
      more.addEventListener("toggle", () => {
        if (more.open) openLinkedParts.add(def.key);
        else openLinkedParts.delete(def.key);
      });
      const summary = document.createElement("summary");
      summary.textContent = `Columns ${mapped} of ${def.fields.length}`;
      const grid = document.createElement("div");
      grid.className = "mapping";
      for (const role of def.fields) {
        const label = document.createElement("span");
        label.className = `source${role.required ? " required" : ""}`;
        label.textContent = role.label;
        const candidates = table.fields.filter((field) => canPlay(role, field, tableIds) || field.id === saved.fields?.[role.key]);
        grid.append(label, roleSelect({ part: def.key, role: role.key }, `${def.label} ${role.label}`, candidates, saved.fields?.[role.key], role.required));
      }
      more.append(summary, grid);
      part.append(more);
    }
    parts.push(part);
  }
  const people = (config.baseTables || []).find((table) => table.id === config.tableId);
  const links = document.createElement("div");
  links.className = "linked-part";
  const linksHead = document.createElement("div");
  linksHead.className = "part-head";
  const linksName = document.createElement("span");
  linksName.textContent = `Links on ${config.tableName}`;
  linksHead.append(linksName);
  const grid = document.createElement("div");
  grid.className = "mapping";
  for (const link of PEOPLE_LINKS) {
    if (!tableIds[link.target]) continue;
    const label = document.createElement("span");
    label.className = "source";
    label.textContent = link.label;
    const candidates = (people?.fields || []).filter((field) => field.type === "multipleRecordLinks"
      && field.options?.linkedTableId === tableIds[link.target]);
    grid.append(label, roleSelect({ link: link.key }, link.label, candidates, config.linked?.peopleLinks?.[link.key], false));
  }
  if (grid.childElementCount) {
    links.append(linksHead, grid);
    parts.push(links);
  }
  linkedList.replaceChildren(...parts);
}

function collectLinked() {
  const linked = { peopleLinks: {} };
  for (const def of LINKED_TABLES) {
    const tableId = linkedList.querySelector(`select[data-part="${def.key}"]:not([data-role])`)?.value;
    if (!tableId) continue;
    const fields = {};
    for (const select of linkedList.querySelectorAll(`select[data-part="${def.key}"][data-role]`)) {
      if (select.value) fields[select.dataset.role] = select.value;
    }
    linked[def.key] = { tableId, fields };
  }
  for (const select of linkedList.querySelectorAll("select[data-link]")) {
    if (select.value) linked.peopleLinks[select.dataset.link] = select.value;
  }
  return linked;
}

async function saveLinked(linked = collectLinked()) {
  try {
    adopt(await send("AIRTABLE_SAVE_LINKED", { linked }));
    setNote("");
  } catch (error) {
    setNote(error.message, true);
    renderLinked();
  }
}

/** A new table for one part starts with its columns matched by name. */
async function changeLinkedTable(key, tableId) {
  const linked = collectLinked();
  if (tableId) linked[key] = { tableId, fields: {} };
  else delete linked[key];
  await saveLinked(linked);
  if (tableId) {
    try {
      adopt(await send("AIRTABLE_SUGGEST_LINKED", { only: key }));
    } catch (error) {
      setNote(error.message, true);
    }
  }
}

$("autolink-btn").addEventListener("click", () => {
  void run($("autolink-btn"), async () => {
    adopt(await send("AIRTABLE_SUGGEST_LINKED"));
    setNote("Matched by name. Check each table before syncing.");
  });
});

async function renderTableSelect(baseId) {
  tableSelect.replaceChildren(option("", baseId ? "Loading tables…" : "Choose a base first", { selected: true, disabled: true }));
  tableSelect.disabled = true;
  if (!baseId) return;
  try {
    if (!tablesByBase.has(baseId)) {
      const listed = await send("AIRTABLE_LIST_TABLES", { baseId });
      tablesByBase.set(baseId, listed.tables);
      suggestedByBase.set(baseId, listed.suggested);
    }
    const current = config.baseId === baseId ? config.tableId : null;
    tableSelect.replaceChildren(
      option("", "Choose a table", { selected: !current, disabled: true }),
      ...tablesByBase.get(baseId).map((table) => option(table.id, table.name, { selected: table.id === current })),
    );
    tableSelect.disabled = false;
    // No table yet: start on the one people live in (the table your other
    // tables' Person links point at), rather than whichever is listed first.
    const suggested = suggestedByBase.get(baseId);
    if (!current && suggested) {
      tableSelect.value = suggested;
      tableSelect.dispatchEvent(new Event("change"));
    }
  } catch (error) {
    // Left pickable: choosing "Try again" reloads the list.
    tableSelect.replaceChildren(
      option("", "Couldn't load tables", { selected: true, disabled: true }),
      option(RETRY_TABLES, "Try again"),
    );
    tableSelect.disabled = false;
    setNote(error.message, true);
  }
}

function fieldSelect(select, key, usedBy) {
  const mapping = config.mapping || {};
  const source = SOURCE_FIELDS.find((field) => field.key === key);
  select.replaceChildren(option("", source.required ? "Choose a column" : "Skip", { selected: !mapping[key] }));
  for (const field of config.fields || []) {
    if (!canMap(key, field)) continue;
    const owner = usedBy.get(field.id);
    const taken = Boolean(owner && owner !== key);
    select.append(option(field.id, taken ? `${field.name} (used)` : field.name, {
      selected: mapping[key] === field.id,
      disabled: taken,
    }));
  }
  select.classList.toggle("unmapped", !mapping[key]);
}

function renderMapping() {
  const usedBy = new Map(Object.entries(config.mapping || {}).map(([key, fieldId]) => [fieldId, key]));
  fieldSelect(keySelect, "linkedinUrl", usedBy);
  const rows = [];
  for (const source of SOURCE_FIELDS) {
    if (source.required) continue;
    const name = document.createElement("span");
    name.className = "source";
    name.textContent = source.label;
    name.title = source.hint ? `${source.label} — ${source.hint}` : source.label;
    const select = document.createElement("select");
    select.dataset.key = source.key;
    select.setAttribute("aria-label", `${source.label} column`);
    fieldSelect(select, source.key, usedBy);
    select.addEventListener("change", saveMappingFromUi);
    rows.push(name, select);
    if (source.key === "createdStamp" && config.mapping.createdStamp) rows.push(...stampValueRow());
  }
  mappingList.replaceChildren(...rows);
  $("mapped-count").textContent = `${mappedCount()} of ${SOURCE_FIELDS.length}`;
  const missing = SOURCE_FIELDS.filter((source) => !source.noCreate && !config.mapping[source.key]).length;
  $("create-fields-btn").textContent = missing ? `Create ${missing} missing` : "All mapped";
  $("create-fields-btn").disabled = missing === 0;
}

/** The marker's value: one of the column's existing choices (sent with typecast off). */
function stampValueRow() {
  const field = (config.fields || []).find((candidate) => candidate.id === config.mapping.createdStamp);
  const choices = (field?.options?.choices || []).map((choice) => choice.name);
  const label = document.createElement("span");
  label.className = "source";
  label.textContent = "↳ set new rows to";
  const select = document.createElement("select");
  select.id = "stamp-value";
  select.setAttribute("aria-label", "New-row marker value");
  select.append(option("", choices.length ? "Choose a value" : "Column has no choices", { selected: !config.stampValue }));
  for (const name of choices) select.append(option(name, name, { selected: name === config.stampValue }));
  select.classList.toggle("unmapped", !config.stampValue);
  select.addEventListener("change", saveMappingFromUi);
  return [label, select];
}

function renderTableState() {
  const parts = [];
  if (config.tableId) parts.push(`${formatCount(config.indexed || 0)} people matched in ${config.tableName}.`);
  const last = config.lastWrite;
  if (last?.at) {
    const counts = [
      last.created ? `${formatCount(last.created)} added` : "",
      last.updated ? `${formatCount(last.updated)} updated` : "",
      last.failed ? `${formatCount(last.failed)} failed` : "",
    ].filter(Boolean);
    parts.push(`Last write ${relativeTime(last.at)}: ${counts.join(", ") || "nothing changed"}.`);
    if (last.error) parts.push(last.error);
  }
  $("table-state").textContent = parts.join(" ");
}

/** Take a config the worker answered with and redraw everything that reads it. */
function adopt(next) {
  config = next;
  renderSetup();
  renderView();
  setCaptureEnabled();
  if (!busy && !errorActive) renderIdle();
}

let configRequest = 0;

async function refreshConfig() {
  const request = ++configRequest;
  try {
    const next = await send("AIRTABLE_GET_CONFIG");
    // An older answer arriving late mustn't replace a newer one.
    if (request === configRequest) adopt(next);
  } catch (error) {
    LOG("config read failed:", error.message);
  }
}

async function run(button, work) {
  button.disabled = true;
  try {
    await work();
  } catch (error) {
    setNote(error.message, true);
  } finally {
    button.disabled = false;
  }
}

$("token-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const token = $("token-input").value.trim();
  if (!token) return;
  void run($("token-btn"), async () => {
    setNote("Connecting…");
    tablesByBase = new Map();
    suggestedByBase = new Map();
    delete tableSelect.dataset.base;
    adopt(await send("AIRTABLE_CONNECT", { token }));
    $("token-input").value = "";
    $("step-token").classList.remove("open");
    setNote("");
  });
});

baseSelect.addEventListener("change", () => {
  tableSelect.dataset.base = baseSelect.value;
  void renderTableSelect(baseSelect.value);
});

const RETRY_TABLES = "__retry";

tableSelect.addEventListener("change", () => {
  if (!tableSelect.value) return;
  if (tableSelect.value === RETRY_TABLES) {
    void renderTableSelect(baseSelect.value);
    return;
  }
  void run(tableSelect, async () => {
    setNote("Reading columns…");
    if (!settingsOpen) reviewing = true;
    adopt(await send("AIRTABLE_SELECT_TABLE", { baseId: baseSelect.value, tableId: tableSelect.value }));
    $("step-table").classList.remove("open");
    // A new table always gets its columns shown, so the mapping can be
    // checked and changed right here before anything syncs.
    $("step-columns").classList.add("open");
    $("step-columns").querySelector("details.more").open = true;
    setNote(config.peopleMismatch
      ? `${config.peopleMismatch.via} links people in ${config.peopleMismatch.name}. Pick ${config.peopleMismatch.name} instead.`
      : config.problem
        ? "Pick the column that holds LinkedIn URLs."
        : `${mappedCount()} fields mapped for ${config.tableName}. Change any below.`, Boolean(config.problem));
  }).finally(() => {
    // A pick that didn't take: the list shows what's really set, so it can be picked again.
    if (config?.tableId !== tableSelect.value) tableSelect.value = config?.tableId || "";
  });
});

async function saveMapping(mapping, doneMessage = "", stampValue = undefined) {
  try {
    adopt(await send("AIRTABLE_SAVE_MAPPING", { mapping, ...(stampValue !== undefined ? { stampValue } : {}) }));
    setNote(config.problem || doneMessage, Boolean(config.problem));
  } catch (error) {
    setNote(error.message, true);
    renderMapping();
  }
}

function saveMappingFromUi() {
  const mapping = {};
  for (const select of [keySelect, ...mappingList.querySelectorAll("select[data-key]")]) {
    if (select.value) mapping[select.dataset.key] = select.value;
  }
  void saveMapping(mapping, "", $("stamp-value")?.value || null);
}

keySelect.addEventListener("change", () => {
  if (config?.tableId) saveMappingFromUi();
});

$("automap-btn").addEventListener("click", () => {
  if (!config?.tableId) return;
  const mapping = suggestMapping(config.fields, config.mapping);
  const added = Object.keys(mapping).length - mappedCount();
  void saveMapping(mapping, added > 0 ? `Matched ${added} more.` : "Nothing else matches.");
});

$("create-fields-btn").addEventListener("click", () => {
  if (!config?.tableId) return;
  const keys = SOURCE_FIELDS.filter((source) => !source.noCreate && !config.mapping[source.key]).map((source) => source.key);
  if (keys.length === 0) return;
  void run($("create-fields-btn"), async () => {
    setNote(`Creating ${keys.length} column${keys.length === 1 ? "" : "s"}…`);
    adopt(await send("AIRTABLE_CREATE_FIELDS", { keys }));
    setNote("Columns created and mapped.");
  });
});

$("sync-as-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run($("sync-as-btn"), async () => {
    adopt(await send("AIRTABLE_SET_SYNC_AS", { email: $("sync-as-input").value }));
    setNote(config.syncAsEmail ? `Known by will use ${config.syncAsEmail}.` : `Known by will use ${config.userEmail || "your account"}.`);
  });
});

$("refresh-schema-btn").addEventListener("click", () => {
  void run($("refresh-schema-btn"), async () => {
    adopt(await send("AIRTABLE_REFRESH_SCHEMA"));
    setNote("Columns reloaded.");
  });
});

$("resync-btn").addEventListener("click", () => {
  void run($("resync-btn"), async () => {
    adopt(await send("AIRTABLE_RESYNC_ALL"));
    setNote("The next sync rewrites every mapped cell.");
  });
});

$("disconnect-btn").addEventListener("click", () => {
  void run($("disconnect-btn"), async () => {
    const next = await send("AIRTABLE_DISCONNECT");
    // Only once it worked: a refusal ("stop the capture first") stays in Settings.
    tablesByBase = new Map();
    suggestedByBase = new Map();
    delete tableSelect.dataset.base;
    settingsOpen = false;
    reviewing = false;
    adopt(next);
    setNote("");
  });
});

// ─── Status ──────────────────────────────────────────────────────────────────

const statusLine = $("status-line");
const statusDetail = $("status-detail");
const progressWrap = $("progress-wrap");
const progressFill = $("progress-fill");
const progressLabelEl = $("progress-label");

let doneTimers = [];
let doneActive = false;

function cancelDone() {
  for (const timer of doneTimers) clearTimeout(timer);
  doneTimers = [];
  doneActive = false;
  progressWrap.classList.remove("done", "fading");
}

function flashDone() {
  cancelDone();
  doneActive = true;
  progressWrap.classList.remove("hidden", "indeterminate");
  progressWrap.classList.add("done");
  progressLabelEl.textContent = "Done";
  progressFill.style.width = "100%";
  doneTimers.push(
    setTimeout(() => progressWrap.classList.add("fading"), 2000),
    setTimeout(() => {
      progressWrap.classList.add("hidden");
      progressFill.style.width = "0";
      cancelDone();
    }, 2200),
  );
}

function render({ line, detail = "", state = "idle", progress = null, label = "", showLinkedIn = false, showCancel = false, showRetry = false }) {
  statusLine.textContent = line;
  statusDetail.textContent = detail;
  statusLine.className = `status-line ${state}`;
  if (progress) cancelDone();
  if (!doneActive) {
    progressWrap.classList.toggle("hidden", !progress);
    progressWrap.classList.toggle("indeterminate", Boolean(progress?.indeterminate));
    progressLabelEl.textContent = progress ? label : "";
    progressFill.style.width = progress?.total > 0
      ? `${Math.max(0, Math.min(100, Math.round((progress.current / progress.total) * 100)))}%`
      : "0";
  }
  $("open-linkedin-btn").classList.toggle("hidden", !showLinkedIn);
  $("cancel-btn").classList.toggle("hidden", !showCancel);
  $("retry-btn").classList.toggle("hidden", !showRetry);
  setCaptureEnabled();
}

function progressFor(current, total) {
  return {
    progress: total > 0 ? { current, total } : { indeterminate: true },
    label: progressLabel(current, total),
  };
}

// Stop is offered only for work that can be stopped: profile adds and
// searches can't, and Stop there would cancel other work instead.
function renderBusy(line, detail = "", { cancellable = true } = {}) {
  busy = true;
  clearTimeout(clearTimer);
  render({ line, detail, state: "busy", progress: { indeterminate: true }, showCancel: cancellable });
}

let lastSyncAt = 0;
let lastSyncSample = false;
let lastSyncScheduled = false;
let softSyncStatus = null;
let softSyncPrefs = null;
let initialSyncDone = false;

async function readSyncHistory() {
  const stored = await chrome.storage.local.get(["capture_results", PREFS_KEY, SOFT_STATUS_KEY, INITIAL_SYNC_KEY, BULK_JOB_KEY])
    .catch(() => ({}));
  const job = stored[BULK_JOB_KEY];
  bulkJob = job?.status === "error" && Array.isArray(job.urls) && job.next < job.urls.length ? job : null;
  const result = stored.capture_results;
  lastSyncAt = Number(result?.timestamp) || Date.parse(result?.completedAt || "") || 0;
  lastSyncSample = result?.sample === true;
  // What the scheduler itself checks; a test sync after a full one doesn't undo it.
  initialSyncDone = Boolean(stored[INITIAL_SYNC_KEY]) || Boolean(lastSyncAt && !lastSyncSample && result?.site === "linkedin");
  softSyncStatus = stored[SOFT_STATUS_KEY] || null;
  lastSyncScheduled = Boolean(softSyncStatus?.completed && result?.runId && softSyncStatus.runId === result.runId);
  softSyncPrefs = normalizeSoftSyncPrefs(stored[PREFS_KEY]);
  renderSoftSync();
}

function renderIdle() {
  busy = false;
  if (!ready()) return;
  if (connectionHealth?.linkedin?.state === "disconnected") {
    render({
      line: "Sign in to LinkedIn",
      detail: connectionHealth.linkedin.message || "Captures can't run while you're signed out.",
      state: "closed",
      showLinkedIn: true,
    });
    return;
  }
  if (config.notice) {
    render({ line: /Known by/.test(config.notice) ? "Known by is off" : "Setup changed", detail: config.notice, state: "idle", showRetry: true });
    $("retry-btn").textContent = "OK";
    errorAction = () => void send("AIRTABLE_DISMISS_NOTICE").then(adopt).catch(() => {});
    return;
  }
  if (bulkJob) {
    const left = bulkJob.urls.length - bulkJob.next;
    render({
      line: "Enrich paused",
      detail: `${formatCount(left)} of ${formatCount(bulkJob.urls.length)} left${bulkJob.error ? ` · ${bulkJob.error}` : ""}`,
      state: "idle",
      showRetry: true,
    });
    $("retry-btn").textContent = "Resume";
    errorAction = resumeBulk;
    return;
  }
  const history = lastSyncAt && lastSyncSample
    ? `Last test sync ${relativeTime(lastSyncAt)}`
    : syncHistoryDetail({ lastSyncAt, scheduled: lastSyncScheduled, status: softSyncStatus, prefs: softSyncPrefs });
  render({
    line: connectionHealth?.state === "degraded" ? "LinkedIn is slowing requests" : "Ready",
    detail: connectionHealth?.state === "degraded"
      ? connectionHealth.message
      : `${config.baseName} › ${config.tableName} · ${history}`,
  });
}

function renderTransient(line, detail = "") {
  busy = false;
  errorAction = null;
  render({ line, detail });
  clearTimeout(clearTimer);
  clearTimer = setTimeout(renderIdle, 5000);
}

// Codes that reach the panel from deep in the engine, in words someone can act on.
const PLAIN_ERRORS = [
  [/^SESSION_EXPIRED$|session expired|not authenticated/i, "LinkedIn signed you out. Open linkedin.com, sign in, then try again."],
  [/^RATE_LIMITED$/, "LinkedIn is limiting requests. Wait a few minutes, then try again."],
  [/^TIMEOUT$/, "LinkedIn stopped responding. Try again in a minute."],
  [/^PROFILE_INACCESSIBLE$/, "LinkedIn won't show that profile."],
  [/^API_ERROR_(\d+)$/, "LinkedIn rejected the request ($1). Try again later."],
  [/^Failed to fetch$|NetworkError/i, "No connection. Check your internet, then try again."],
];

function plainError(text) {
  const message = String(text || "").trim();
  for (const [pattern, plain] of PLAIN_ERRORS) {
    const match = message.match(pattern);
    if (match) return plain.replace("$1", match[1] || "");
  }
  return message;
}

function renderError(line, detail, action = null, { fromStart = false } = {}) {
  busy = false;
  detail = plainError(detail);
  errorActive = true;
  errorFromStart = fromStart;
  errorAction = action;
  clearTimeout(clearTimer);
  render({ line, detail, state: "error", showRetry: true, showLinkedIn: /LinkedIn signed you out/.test(detail) });
  $("retry-btn").textContent = action ? "Try again" : "Dismiss";
}

function clearError() {
  errorActive = false;
  errorFromStart = false;
  errorAction = null;
}

$("retry-btn").addEventListener("click", () => {
  const action = errorAction;
  clearError();
  if (action) action();
  else renderIdle();
});

$("cancel-btn").addEventListener("click", () => {
  render({ line: "Stopping…", state: "busy" });
  chrome.runtime.sendMessage({ type: "CANCEL_SYNC" }).catch(() => {});
});

$("open-linkedin-btn").addEventListener("click", () => {
  void chrome.tabs.create({ url: "https://www.linkedin.com/feed/", active: true });
});

// ─── Capture ─────────────────────────────────────────────────────────────────

const captureButtons = [
  "sync-btn", "soft-sync-btn", "test-sync-btn", "profile-add-btn", "profile-mutuals-btn",
  "company-btn", "search-btn", "search-add-btn", "search-mutuals-btn", "mutuals-btn",
].map($);

function setCaptureEnabled() {
  for (const button of captureButtons) button.disabled = !ready() || busy;
  renderBulkCount();
  renderInteraction();
}

async function start(line, type, payload, retry) {
  if (!ready()) return;
  clearError();
  renderBusy(line);
  inFlight++;
  try {
    await send(type, payload);
  } catch (error) {
    renderError(`${line} failed`, error.message, retry || null, { fromStart: true });
  } finally {
    inFlight--;
  }
}

let lastStartedSample = false;
let lastStartedMode = "full";

function startNetworkSync(mode = "full", { sample = false } = {}) {
  lastStartedSample = sample;
  lastStartedMode = mode;
  void start(
    sample ? "Test sync" : mode === "soft" ? "Refreshing" : "Syncing",
    "START_CAPTURE",
    { site: "linkedin", mode, sample },
    () => startNetworkSync(mode, { sample }),
  );
}

$("sync-btn").addEventListener("click", () => startNetworkSync("full"));
$("soft-sync-btn").addEventListener("click", () => startNetworkSync("soft"));
$("test-sync-btn").addEventListener("click", () => startNetworkSync("full", { sample: true }));

function startMutuals(urls) {
  if (urls.length === 0) {
    renderError("No profiles", "Add at least one LinkedIn profile URL.");
    return;
  }
  void start("Finding mutuals", "START_MUTUAL_FINDING", { contacts: urls.map((linkedinUrl) => ({ linkedinUrl })) });
}

async function captureProfiles(urls) {
  if (!ready()) return;
  inFlight++;
  try {
    await captureProfilesNow(urls);
  } finally {
    inFlight--;
  }
}

async function captureProfilesNow(urls) {
  clearError();
  renderBusy("Adding to Airtable", `Reading ${urls.length === 1 ? "the profile" : `${urls.length} profiles`} from LinkedIn…`,
    { cancellable: false });
  try {
    const result = await send("CAPTURE_PROFILES", { urls });
    if (result.failed && !result.created && !result.updated && !result.unchanged) {
      renderError("Couldn't add to Airtable", result.warning || `${formatCount(result.failed)} failed`, () => captureProfiles(urls));
      return;
    }
    flashDone();
    const parts = [
      result.created ? `${formatCount(result.created)} added` : "",
      result.updated ? `${formatCount(result.updated)} updated` : "",
      result.unchanged ? `${formatCount(result.unchanged)} already current` : "",
      result.failed ? `${formatCount(result.failed)} failed` : "",
    ].filter(Boolean);
    renderTransient("Saved to Airtable", [parts.join(" · "), result.warning].filter(Boolean).join(" — "));
  } catch (error) {
    renderError("Couldn't add to Airtable", error.message, () => captureProfiles(urls));
  }
}

function linkedinProfileUrl(value) {
  try {
    const url = new URL(String(value).trim());
    if (!/(^|\.)linkedin\.com$/.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/in\/([^/?#]+)/);
    return match ? `https://www.linkedin.com/in/${match[1]}` : null;
  } catch {
    return null;
  }
}

function parseUrls(text) {
  // Same rules as the worker: "linkedin.com/in/x" without https counts too.
  return [...new Set(String(text || "").split(/[\s,;]+/).map((value) => canonicalLinkedinUrl(value)).filter(Boolean))];
}

let activeProfileUrl = null;

async function readActiveProfile() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const previous = activeProfileUrl;
  activeProfileUrl = linkedinProfileUrl(tab?.url || "");
  $("profile-card").classList.toggle("hidden", !activeProfileUrl);
  if (activeProfileUrl) {
    const name = String(tab.title || "").replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*LinkedIn\s*$/i, "").trim();
    $("profile-name").textContent = name || activeProfileUrl;
  }
  if (activeProfileUrl !== previous && !logging) resetInteraction();
  renderInteraction();
}

chrome.tabs.onActivated.addListener(() => void readActiveProfile());
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.url || info.status === "complete") void readActiveProfile();
  if (info.status === "complete" && tab?.url?.includes("linkedin.com")) void checkHealth({ probe: true });
});

$("profile-add-btn").addEventListener("click", () => {
  if (activeProfileUrl) void captureProfiles([activeProfileUrl]);
});
$("profile-mutuals-btn").addEventListener("click", () => {
  if (activeProfileUrl) startMutuals([activeProfileUrl]);
});

// ─── Log interaction ─────────────────────────────────────────────────────────

function localMinute(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function interactionStatus(text, kind = "") {
  clearTimeout(statusTimer);
  const status = $("interaction-status");
  status.textContent = text;
  status.classList.toggle("error", kind === "error");
  status.classList.toggle("done", kind === "done");
  if (kind === "done") statusTimer = setTimeout(() => interactionStatus(""), 4000);
}

for (const type of INTERACTION_TYPES) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.textContent = type;
  chip.dataset.type = type;
  chip.setAttribute("aria-pressed", "false");
  chip.addEventListener("click", () => {
    picked = picked.includes(type) ? picked.filter((each) => each !== type) : [...picked, type];
    renderInteraction();
  });
  $("interaction-types").append(chip);
}

function resetInteraction() {
  picked = [];
  whenTouched = false;
  lastLogFailed = false;
  pendingNoteId = null;
  failedAt = null;
  $("interaction-note").value = "";
  $("interaction-when").value = localMinute();
  interactionStatus("");
}

function renderInteraction() {
  const tables = ready() ? interactionTables(config.baseTables, config.tableId) : { interactions: false, notes: false };
  $("interaction-toggle").classList.toggle("hidden", !tables.interactions);
  if (!tables.interactions) {
    $("interaction-form").classList.add("hidden");
    $("interaction-toggle").setAttribute("aria-expanded", "false");
  }
  $("interaction-note").closest(".field").classList.toggle("hidden", !tables.notes && !pendingNoteId);
  for (const chip of $("interaction-types").children) {
    chip.setAttribute("aria-pressed", String(picked.includes(chip.dataset.type)));
    chip.disabled = logging;
  }
  // A saved note already carries the time; the interaction must match it.
  $("interaction-when").disabled = logging || Boolean(pendingNoteId);
  $("interaction-note").disabled = logging || Boolean(pendingNoteId);
  const button = $("interaction-log-btn");
  button.disabled = logging || picked.length === 0 || !activeProfileUrl;
  button.textContent = logging ? "Logging…" : pendingNoteId ? "Retry" : "Log";
}

$("interaction-toggle").addEventListener("click", () => {
  const form = $("interaction-form");
  const open = form.classList.contains("hidden");
  form.classList.toggle("hidden", !open);
  $("interaction-toggle").setAttribute("aria-expanded", String(open));
  if (open) {
    if (!whenTouched) $("interaction-when").value = localMinute();
    $("interaction-types").querySelector(".chip")?.focus();
  }
});

$("interaction-when").addEventListener("input", () => {
  whenTouched = Boolean($("interaction-when").value);
});

$("interaction-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (logging || picked.length === 0 || !activeProfileUrl) return;
  // Untouched means now, at the moment of the click (or of the try that failed).
  const when = whenTouched ? new Date($("interaction-when").value) : failedAt ? new Date(failedAt) : new Date();
  if (Number.isNaN(when.getTime())) {
    interactionStatus("Pick when it happened.", "error");
    return;
  }
  logging = true;
  interactionStatus("");
  renderInteraction();
  const url = activeProfileUrl;
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "LOG_INTERACTION",
      url,
      name: $("profile-name").textContent,
      types: picked,
      at: when.toISOString(),
      note: $("interaction-note").value,
      noteId: pendingNoteId,
      retry: lastLogFailed,
    });
  } catch (error) {
    response = { error: error.message };
  }
  logging = false;
  if (response?.ok) {
    resetInteraction();
    interactionStatus("Logged", "done");
  } else {
    lastLogFailed = true;
    failedAt = when.toISOString();
    pendingNoteId = response?.noteId || pendingNoteId;
    const detail = plainError(response?.error || "Couldn't log it.").trim().replace(/([^.!?])$/, "$1.");
    interactionStatus(pendingNoteId ? `${detail} The note was saved; Retry logs the interaction with it.` : detail, "error");
  }
  if (url !== activeProfileUrl) resetInteraction();
  renderInteraction();
});

$("company-btn").addEventListener("click", () => {
  const company = $("company-input").value.trim();
  if (company.length < 2) {
    $("company-input").focus();
    return;
  }
  const keywords = $("company-roles").value.split(",").map((role) => role.trim()).filter(Boolean);
  void start("Capturing company", "START_COMPANY_CAPTURE", { company, keywords });
});

$("mutuals-btn").addEventListener("click", () => startMutuals(parseUrls($("mutuals-input").value)));

// Bulk enrich: the button says how many profiles it found, so a bad paste is
// obvious before anything runs.
function renderBulkCount() {
  const count = parseUrls($("bulk-input").value).length;
  $("bulk-btn").textContent = count ? `Enrich ${formatCount(count)} profile${count === 1 ? "" : "s"}` : "Enrich";
  $("bulk-btn").disabled = !ready() || busy || count === 0;
}

$("bulk-input").addEventListener("input", renderBulkCount);

$("bulk-btn").addEventListener("click", () => {
  const urls = parseUrls($("bulk-input").value);
  if (urls.length === 0) return;
  void start("Enriching profiles", "BULK_ENRICH", { urls }).then(() => {
    if (!errorActive) $("bulk-input").value = "";
  });
});

function resumeBulk() {
  void start("Resuming enrich", "BULK_ENRICH_RESUME", {}, resumeBulk);
}

const searchResults = $("search-results");

$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = $("search-input").value.trim();
  if (query.length < 2 || !ready()) return;
  searchResults.replaceChildren();
  $("search-actions").classList.add("hidden");
  clearError();
  renderBusy("Searching LinkedIn", `“${query}”`, { cancellable: false });
  inFlight++;
  try {
    const { people = [] } = await send("SEARCH_LINKEDIN_PEOPLE", { query, limit: 25 });
    renderSearchResults(people);
    renderTransient(`${formatCount(people.length)} ${people.length === 1 ? "person" : "people"} found`);
  } catch (error) {
    renderError("Search failed", error.message);
  } finally {
    inFlight--;
  }
});

function renderSearchResults(people) {
  searchResults.replaceChildren(...people.map((person) => {
    const item = document.createElement("li");
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = person.linkedinUrl;
    const text = document.createElement("span");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = person.name;
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = person.headline || "";
    text.append(who, what);
    const degree = document.createElement("span");
    degree.className = "deg";
    degree.textContent = person.degree || "";
    label.append(box, text, degree);
    item.append(label);
    return item;
  }));
  $("search-actions").classList.toggle("hidden", people.length === 0);
}

function selectedSearchUrls() {
  return [...searchResults.querySelectorAll("input:checked")].map((box) => box.value);
}

$("search-add-btn").addEventListener("click", () => {
  const urls = selectedSearchUrls();
  if (urls.length) void captureProfiles(urls);
});
$("search-mutuals-btn").addEventListener("click", () => startMutuals(selectedSearchUrls()));

// ─── Auto-sync ───────────────────────────────────────────────────────────────

function renderSoftSync() {
  if (!softSyncPrefs) return;
  $("soft-enabled").checked = softSyncPrefs.enabled;
  const times = $("soft-times");
  if (![...times.options].some((item) => item.value === String(softSyncPrefs.timesPerDay))) {
    times.append(option(String(softSyncPrefs.timesPerDay), `${softSyncPrefs.timesPerDay}× a day`));
  }
  times.value = String(softSyncPrefs.timesPerDay);
  times.disabled = !softSyncPrefs.enabled;
  let line = "";
  if (softSyncPrefs.enabled && !initialSyncDone) {
    line = "Starts after your first full sync.";
  } else if (softSyncStatus?.at && softSyncStatus.failed && softSyncStatus.at > lastSyncAt) {
    const reason = softSyncStatus.failed === "stale" ? "it stopped responding" : plainError(softSyncStatus.failed);
    line = `Last auto-sync failed ${relativeTime(softSyncStatus.at)}: ${reason}`;
  }
  $("soft-status").textContent = line;
}

async function saveSoftSync() {
  try {
    const { prefs } = await send("SET_SOFT_SYNC_PREFS", {
      prefs: { enabled: $("soft-enabled").checked, timesPerDay: Number($("soft-times").value) },
    });
    softSyncPrefs = normalizeSoftSyncPrefs(prefs);
    renderSoftSync();
    if (!busy && !errorActive) renderIdle();
  } catch (error) {
    $("soft-status").textContent = error.message;
  }
}

$("soft-enabled").addEventListener("change", saveSoftSync);
$("soft-times").addEventListener("change", saveSoftSync);

// ─── Health ──────────────────────────────────────────────────────────────────

async function checkHealth({ probe = false } = {}) {
  try {
    const health = await chrome.runtime.sendMessage({ type: "GET_CONNECTION_HEALTH", probe });
    if (health && !health.error) connectionHealth = health;
  } catch (error) {
    LOG("health check failed:", error?.message || error);
  }
  if (!busy && !errorActive) renderIdle();
}

// ─── Progress ────────────────────────────────────────────────────────────────

function capturePhase(cp) {
  if (["starting", "capturing", "saving", "enriching"].includes(cp?.phase)) return cp.phase;
  if (cp?.status === "starting") return "starting";
  return cp?.status === "uploading" ? "saving" : "capturing";
}

function phaseCurrent(cp, phase) {
  if (phase === "capturing") return cp.discovered || cp.current || 0;
  if (phase === "saving") return cp.saved || cp.current || 0;
  if (phase === "enriching") return cp.enriched || 0;
  return 0;
}

async function clearKey(key, value) {
  await chrome.storage.local.set({ [key]: value }).catch(() => {});
}

const LIVE = ["starting", "in_progress", "scraping_profiles", "uploading"];

async function pollProgress() {
  if (!ready()) return;
  const { capture_progress: cp, enrich_progress: ep, mutual_progress: mp, company_progress: co } =
    await chrome.storage.local.get(PROGRESS_KEYS);

  if (errorActive) {
    if ([co, mp, ep, cp].some((p) => p && LIVE.includes(p.status))) {
      clearError();
    } else if (errorFromStart) {
      // The same failure also reached storage; it's on screen already, so
      // retire the stored copy rather than show it again after Dismiss.
      if (cp?.status === "error") await clearKey("capture_progress", { status: "idle" });
      if (co?.status === "error") await clearKey("company_progress", null);
      if (mp?.status === "error") await clearKey("mutual_progress", null);
      if (ep?.status === "error" && !ep.bulk) await clearKey("enrich_progress", null);
      return;
    } else if (![co, mp, ep, cp].some((p) => p && ["error", "complete"].includes(p.status))) {
      // Nothing new stored: the error on screen stays.
      return;
    }
  }

  const live = (line, record, current, total) => {
    busy = true;
    clearTimeout(clearTimer);
    render({ line, detail: record.message || "", state: "busy", showCancel: true, ...progressFor(current, total) });
  };

  if (co?.status === "in_progress") return live("Capturing company", co, co.current || 0, co.total || 0);
  if (co?.status === "complete") {
    await clearKey("company_progress", null);
    flashDone();
    return renderTransient(`${formatCount(co.linked ?? co.count ?? 0)} people saved`, co.message || "");
  }
  if (co?.status === "error") {
    await clearKey("company_progress", null);
    return renderError("Company capture failed", co.message || "");
  }

  if (mp?.status === "in_progress" || mp?.status === "uploading") {
    return live(mp.status === "uploading" ? "Saving mutuals" : "Finding mutuals", mp, mp.current || 0, mp.total || 0);
  }
  if (mp?.status === "complete") {
    await clearKey("mutual_progress", null);
    flashDone();
    return renderTransient(`${formatCount(mp.totalBridges || 0)} mutuals found`, mp.message || "");
  }
  if (mp?.status === "error") {
    await clearKey("mutual_progress", null);
    return renderError("Mutual finding failed", mp.message || "");
  }

  if (ep?.status === "in_progress") {
    const { enrichedCount = 0, totalConnections = 0, currentName } = ep;
    busy = true;
    clearTimeout(clearTimer);
    return render({
      line: stageHeadline("enriching"),
      detail: ep.message || stageMessage("enriching", { current: enrichedCount, total: totalConnections, who: currentName }),
      state: "busy",
      showCancel: true,
      ...progressFor(enrichedCount, totalConnections),
    });
  }
  if (ep?.status === "complete") {
    await clearKey("enrich_progress", null);
    flashDone();
    return renderTransient("Profiles enriched", ep.message || "");
  }
  if (ep?.status === "error") {
    await clearKey("enrich_progress", null);
    // A stopped bulk enrich resumes at its next batch, not from the top; the
    // stored job keeps offering Resume after this panel closes.
    return ep.bulk
      ? renderError("Enrich paused", ep.message || "", resumeBulk)
      : renderError("Enrichment failed", ep.message || "");
  }

  if (!cp || cp.status === "idle" || cp.status === "canceled") {
    if (busy && inFlight === 0) renderIdle();
    return;
  }
  if (LIVE.includes(cp.status)) {
    const phase = capturePhase(cp);
    const current = phaseCurrent(cp, phase);
    busy = true;
    clearTimeout(clearTimer);
    return render({
      line: stageHeadline(phase, "LinkedIn"),
      detail: cp.message || stageMessage(phase, { current, total: cp.total || 0, site: "LinkedIn" }),
      state: "busy",
      showCancel: true,
      ...progressFor(current, cp.total || 0),
    });
  }
  if (cp.status === "complete") {
    await clearKey("capture_progress", { status: "idle" });
    flashDone();
    return cp.lastResult?.sample
      ? renderTransient(`Test sync done: ${formatCount(cp.total || 0)} in Airtable`, "Check the rows, then run the full sync.")
      : renderTransient(`Synced ${formatCount(cp.total || 0)} contacts`);
  }
  if (cp.status === "error") {
    await clearKey("capture_progress", { status: "idle" });
    // A failed test sync retries as a test, not as the full walk.
    const sample = cp.sample ?? lastStartedSample;
    // A failed Quick refresh retries as one, not as the full walk.
    const mode = cp.mode ?? lastStartedMode;
    renderError(sample ? "Test sync failed" : mode === "soft" ? "Refresh failed" : "Sync failed", cp.message || "",
      () => startNetworkSync(mode, { sample }));
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (THEME_KEY in changes) applyTheme(changes[THEME_KEY].newValue);
  if ("airtable_config" in changes || "airtable_last_write" in changes) void refreshConfig();
  if ("capture_results" in changes || PREFS_KEY in changes || SOFT_STATUS_KEY in changes || BULK_JOB_KEY in changes) {
    void readSyncHistory().then(() => {
      if (!busy && !errorActive) renderIdle();
    });
  }
  if (HEALTH_KEY in changes) {
    connectionHealth = changes[HEALTH_KEY].newValue || null;
    if (!busy && !errorActive) renderIdle();
  }
  if (Object.keys(changes).some((key) => PROGRESS_KEYS.includes(key))) void pollProgress();
});

setInterval(pollProgress, 5000);

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const stored = await chrome.storage.local.get(THEME_KEY);
  applyTheme(stored[THEME_KEY] || document.documentElement.dataset.theme);
  await readSyncHistory();
  await refreshConfig();
  renderView();
  await readActiveProfile();
  // A live run shows at once, not after the LinkedIn probe.
  await pollProgress();
  await checkHealth({ probe: true });
  await pollProgress();
});

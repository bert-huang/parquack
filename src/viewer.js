import * as duckdb from "@duckdb/duckdb-wasm";
import { basicSetup, EditorView } from "codemirror";
import { keymap } from "@codemirror/view";
import { Compartment, Prec } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { sql, SQLDialect } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";

const runtime = (typeof browser !== "undefined" ? browser : chrome).runtime;
const url = (p) => runtime.getURL(p);

// Each load registers under a fresh name (current-1.parquet, current-2.parquet,
// …). Reusing one name corrupts reads: DuckDB ≥1.3's external file cache keys
// cached parquet blocks by path, so a second file registered under the same
// path gets served the first file's pages ("ZSTD Decompression failure").
let _fileSeq = 0;
let registeredName = null;

const els = {
  status: document.getElementById("status"),
  fileInput: document.getElementById("file-input"),
  urlInput: document.getElementById("url-input"),
  urlLoad: document.getElementById("url-load"),
  download: document.getElementById("download"),
  schemaGrid: document.getElementById("schema-grid"),
  fileMetaGrid: document.getElementById("file-meta-grid"),
  rowGroupsSummaryGrid: document.getElementById("row-groups-summary-grid"),
  rowGroupsStatsGrid: document.getElementById("row-groups-stats-grid"),
  rowGroupSelect: document.getElementById("row-group-select"),
  kvGrid: document.getElementById("kv-grid"),
  dataGrid: document.getElementById("data-grid"),
  queryGrid: document.getElementById("query-grid"),
  queryPager: document.getElementById("query-pager"),
  queryPrevPage: document.getElementById("query-prev-page"),
  queryNextPage: document.getElementById("query-next-page"),
  queryPageInfo: document.getElementById("query-page-info"),
  prevPage: document.getElementById("prev-page"),
  nextPage: document.getElementById("next-page"),
  pageInfo: document.getElementById("page-info"),
  pageSize: document.getElementById("page-size"),
  sqlEditor: document.getElementById("sql-editor"),
  runQuery: document.getElementById("run-query"),
  runQueryNew: document.getElementById("run-query-new"),
  resultTabs: document.getElementById("result-tabs"),
  exportFormat: document.getElementById("export-format"),
  exportQuery: document.getElementById("export-query"),
  recentQueries: document.getElementById("recent-queries"),
  queryHistory: document.getElementById("query-history"),
  qhToggle: document.getElementById("qh-toggle"),
  qhRail: document.getElementById("qh-rail"),
  qhResize: document.getElementById("qh-resize"),
  qhClear: document.getElementById("qh-clear"),
  settingsOpen: document.getElementById("settings-open"),
  settingsClose: document.getElementById("settings-close"),
  settingsCancel: document.getElementById("settings-cancel"),
  settingsSave: document.getElementById("settings-save"),
  settingsModal: document.getElementById("settings-modal"),
  settingsBackdrop: document.getElementById("settings-backdrop"),
  duckdbrcEditor: document.getElementById("duckdbrc-editor"),
  themeSelect: document.getElementById("theme-select"),
  queryPageSizeInput: document.getElementById("query-page-size-input"),
  confirmModal: document.getElementById("confirm-modal"),
  confirmBackdrop: document.getElementById("confirm-backdrop"),
  confirmTitle: document.getElementById("confirm-title"),
  confirmMessage: document.getElementById("confirm-message"),
  confirmOk: document.getElementById("confirm-ok"),
  confirmCancel: document.getElementById("confirm-cancel"),
  tabs: Array.from(document.querySelectorAll(".tab")),
  panels: Array.from(document.querySelectorAll(".tab-panel")),
};

const state = {
  db: null,
  conn: null,
  loaded: false,
  fileType: null, // "parquet" | "json" | "csv"
  totalRows: 0,
  page: 0,
  pageSize: 100,
  rowGroupId: null,
  editor: null,
  fileName: null,
  fileBuffer: null,
  queryPageSize: 1000,
  // Query result tabs. Each entry:
  // { id, label, sql, page, pageRows, totalRows, table, error, isSelect, gen }
  results: [],
  activeResultId: null,
};

// ---------- editors ----------

// Two separate Compartment instances — one per EditorView. A single
// Compartment can technically be embedded in multiple independent states
// (reconfigure() dispatches only affect the target view), but using distinct
// instances makes the ownership explicit and avoids confusion.
const sqlThemeCompartment = new Compartment();
const rcThemeCompartment = new Compartment();

// Language compartments so the SQL extension (dialect + schema completion)
// can be swapped at runtime — after DuckDB introspection and file loads.
const sqlLangCompartment = new Compartment();
const rcLangCompartment = new Compartment();

// Dialect built from duckdb_keywords()/duckdb_functions()/duckdb_types() once
// DuckDB is up (and rebuilt after duckdbrc runs, since LOADed extensions
// register new functions). Null until then — sql() falls back to StandardSQL.
let sqlDialect = null;
// Columns of the loaded file (from DESCRIBE), as completion options.
let dataColumns = [];
// function name (lowercase) -> overload signature strings, from
// duckdb_functions(). Feeds detail/info on function completions.
let fnSignatures = new Map();

const SIG_MAX_OVERLOADS = 8;
const SIG_DETAIL_MAX = 40;

function buildSignatureMap(rows) {
  const map = new Map();
  for (const row of rows) {
    const name = String(row.function_name).toLowerCase();
    if (!IDENT_RE.test(name)) continue;
    const names = Array.from(row.parameters ?? []).map(String);
    const types = Array.from(row.parameter_types ?? []).map(String);
    const params = names
      .map((n, i) => (types[i] && types[i] !== "NULL" ? `${n} ${types[i]}` : n))
      .join(", ");
    const ret = row.return_type != null && String(row.return_type) !== "NULL"
      ? ` → ${row.return_type}`
      : "";
    const sig = `(${params})${ret}`;
    let list = map.get(name);
    if (!list) map.set(name, (list = []));
    if (!list.includes(sig)) list.push(sig);
  }
  return map;
}

function functionCompletionExtras(name) {
  const sigs = fnSignatures.get(name);
  if (!sigs || sigs.length === 0) return {};
  // detail: first overload's parameter list, without return type, truncated.
  const first = sigs[0].replace(/ → .*$/, "");
  const detail = first.length > SIG_DETAIL_MAX ? first.slice(0, SIG_DETAIL_MAX - 1) + "…" : first;
  const lines = sigs.slice(0, SIG_MAX_OVERLOADS).map((s) => name + s);
  if (sigs.length > SIG_MAX_OVERLOADS) {
    lines.push(`…and ${sigs.length - SIG_MAX_OVERLOADS} more overloads`);
  }
  const text = lines.join("\n");
  return {
    detail,
    info: () => {
      const d = document.createElement("div");
      d.style.whiteSpace = "pre-line";
      d.textContent = text;
      return d;
    },
  };
}

function sqlLangExt() {
  return sql({
    ...(sqlDialect ? { dialect: sqlDialect } : {}),
    schema: { data: dataColumns },
    defaultTable: "data",
    upperCaseKeywords: true,
    // Dialect "builtin" words (our duckdb_functions() list) surface as type
    // "variable"; relabel them as lowercase functions with signature hints.
    // Keywords/types keep the upper-cased label. boost -1 mirrors lang-sql's
    // defaultKeyword so schema columns always rank above catalog words.
    keywordCompletion: (label, type) => {
      if (type !== "variable") return { label, type, boost: -1 };
      const name = label.toLowerCase();
      return { label: name, type: "function", boost: -1, ...functionCompletionExtras(name) };
    },
  });
}

function applySqlLang() {
  const ext = sqlLangExt();
  if (state.editor) {
    state.editor.dispatch({ effects: sqlLangCompartment.reconfigure(ext) });
  }
  if (rcEditor) {
    rcEditor.dispatch({ effects: rcLangCompartment.reconfigure(ext) });
  }
}

// Words with spaces or quoting requirements can't live in a space-separated
// dialect spec string.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function refreshCompletionDialect() {
  if (!state.conn) return;
  try {
    const [kw, fns, types] = await Promise.all([
      state.conn.query(`SELECT keyword_name FROM duckdb_keywords();`),
      state.conn.query(
        `SELECT function_name, parameters, parameter_types, return_type
         FROM duckdb_functions();`,
      ),
      state.conn.query(`SELECT DISTINCT type_name FROM duckdb_types();`),
    ]);
    const words = (table, col) =>
      arrowToRows(table)
        .map((r) => String(r[col]))
        .filter((w) => IDENT_RE.test(w))
        .join(" ");
    fnSignatures = buildSignatureMap(arrowToRows(fns));
    sqlDialect = SQLDialect.define({
      keywords: words(kw, "keyword_name"),
      builtin: [...fnSignatures.keys()].join(" "),
      types: words(types, "type_name"),
    });
    applySqlLang();
  } catch (e) {
    console.warn("completion dialect refresh failed:", e);
  }
}

function initEditor() {
  state.editor = new EditorView({
    doc: "SELECT * FROM data LIMIT 100;",
    parent: els.sqlEditor,
    extensions: [
      basicSetup,
      sqlLangCompartment.of(sqlLangExt()),
      sqlThemeCompartment.of(editorThemeExt()),
      // Prec.highest ensures our Mod-Enter runs before defaultKeymap's
      // insertBlankLine binding (which basicSetup includes and would otherwise
      // win due to appearing earlier in the extension list).
      Prec.highest(keymap.of([
        { key: "Mod-Enter", run: () => { runUserQuery(); return true; } },
        { key: "Shift-Mod-Enter", run: () => { runUserQuery(true); return true; } },
      ])),
      keymap.of([indentWithTab]),
      EditorView.theme({
        "&": { backgroundColor: "var(--panel-2)" },
        ".cm-content": { padding: "8px 0" },
      }),
    ],
  });
}

function getSql() {
  return state.editor.state.doc.toString();
}

function setSql(text) {
  state.editor.dispatch({
    changes: { from: 0, to: state.editor.state.doc.length, insert: text },
  });
}

// ---------- status ----------

function setStatus(msg, kind = "") {
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? " " + kind : "");
}

// ---------- DuckDB ----------

async function initDuckDB() {
  setStatus("Initializing DuckDB…");
  // Use the EH bundle directly — modern Firefox (128+) and Chrome (120+) both
  // support WebAssembly exception handling, so the older MVP fallback is
  // unnecessary and would only add ~37 MB to the extension.
  const mainModule = url("dist/duckdb-eh.wasm");
  const mainWorker = url("dist/duckdb-browser-eh.worker.js");
  const worker = new Worker(mainWorker);
  const logger = new duckdb.ConsoleLogger("WARNING");
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(mainModule);
  state.db = db;
  state.conn = await db.connect();
  // Registered file buffers already live in memory — DuckDB ≥1.3's external
  // file cache would only duplicate them. Guarded: setting may not exist in
  // other core versions. duckdbrc (below) can still override.
  try { await state.conn.query("SET enable_external_file_cache=false;"); } catch (_) {}
  await applyDuckdbRc(loadDuckdbRc());
  await refreshCompletionDialect();
  els.runQuery.disabled = false;
  els.runQuery.title = "Run (⌘/Ctrl+Enter)";
  els.runQueryNew.disabled = false;
  els.runQueryNew.title = "Run in a new result tab (⇧+⌘/Ctrl+Enter)";
  setStatus("DuckDB ready.", "ok");
}

// ---------- theme ----------

const THEME_KEY = "parquack:theme";
const editorThemeExt = () => getTheme() === "dark" ? oneDark : [];

function getTheme() {
  return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
}

function applyTheme(theme) {
  document.documentElement.classList.toggle("theme-light", theme === "light");
}

function applyEditorTheme() {
  const ext = editorThemeExt();
  if (state.editor) {
    state.editor.dispatch({ effects: sqlThemeCompartment.reconfigure(ext) });
  }
  if (rcEditor) {
    rcEditor.dispatch({ effects: rcThemeCompartment.reconfigure(ext) });
  }
}

// ---------- settings / duckdbrc ----------

const DUCKDB_RC_KEY = "parquack:duckdbrc";
const QUERY_PAGE_SIZE_KEY = "parquack:query-page-size";
const QUERY_PAGE_SIZE_MIN = 100;
const QUERY_PAGE_SIZE_MAX = 10000;

function loadQueryPageSize() {
  const v = parseInt(localStorage.getItem(QUERY_PAGE_SIZE_KEY) || "", 10);
  if (Number.isInteger(v) && v >= QUERY_PAGE_SIZE_MIN && v <= QUERY_PAGE_SIZE_MAX) return v;
  return 1000;
}

function loadDuckdbRc() {
  return localStorage.getItem(DUCKDB_RC_KEY) || "";
}

function saveDuckdbRcText(text) {
  localStorage.setItem(DUCKDB_RC_KEY, text);
}

async function applyDuckdbRc(rc) {
  if (!rc || !rc.trim() || !state.conn) return;
  try {
    await state.conn.query(rc);
    setStatus("duckdbrc applied.", "ok");
  } catch (e) {
    setStatus(`duckdbrc error: ${e.message}`, "error");
    console.warn("duckdbrc error:", e);
  }
}

let rcEditor = null;

function ensureRcEditor() {
  if (rcEditor) return;
  rcEditor = new EditorView({
    doc: loadDuckdbRc(),
    parent: els.duckdbrcEditor,
    extensions: [
      basicSetup,
      rcLangCompartment.of(sqlLangExt()),
      rcThemeCompartment.of(editorThemeExt()),
      keymap.of([indentWithTab]),
      EditorView.theme({
        "&": { backgroundColor: "var(--panel-2)" },
        ".cm-content": { padding: "8px 0" },
      }),
    ],
  });
}

function syncRcEditorFromStorage() {
  const current = loadDuckdbRc();
  rcEditor.dispatch({
    changes: { from: 0, to: rcEditor.state.doc.length, insert: current },
  });
}

function validateSettingsForm() {
  const v = parseInt(els.queryPageSizeInput.value, 10);
  const valid = Number.isInteger(v) && v >= QUERY_PAGE_SIZE_MIN && v <= QUERY_PAGE_SIZE_MAX;
  els.queryPageSizeInput.classList.toggle("input-invalid", !valid);
  els.settingsSave.disabled = !valid;
}

function openSettings() {
  ensureRcEditor();
  syncRcEditorFromStorage();
  els.themeSelect.value = getTheme();
  els.queryPageSizeInput.value = String(loadQueryPageSize());
  els.settingsSave.disabled = false;
  els.queryPageSizeInput.classList.remove("input-invalid");
  els.settingsModal.hidden = false;
  setTimeout(() => rcEditor.focus(), 0);
}

function closeSettings() {
  els.settingsModal.hidden = true;
}

async function saveSettings() {
  const text = rcEditor.state.doc.toString();
  saveDuckdbRcText(text);

  const theme = els.themeSelect.value === "light" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
  applyEditorTheme();

  const pageSize = Math.min(QUERY_PAGE_SIZE_MAX,
    Math.max(QUERY_PAGE_SIZE_MIN, parseInt(els.queryPageSizeInput.value, 10)));
  localStorage.setItem(QUERY_PAGE_SIZE_KEY, String(pageSize));
  state.queryPageSize = pageSize;

  closeSettings();
  await applyDuckdbRc(text);
  // rc may INSTALL/LOAD extensions that register new functions.
  await refreshCompletionDialect();
}

// ---------- themed confirm dialog ----------

function showConfirm({
  title = "Confirm",
  message = "",
  okLabel = "OK",
  cancelLabel = "Cancel",
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmOk.textContent = okLabel;
    els.confirmCancel.textContent = cancelLabel;
    els.confirmOk.classList.toggle("danger", danger);
    els.confirmOk.classList.toggle("primary", !danger);
    els.confirmModal.hidden = false;

    const cleanup = (result) => {
      els.confirmModal.hidden = true;
      els.confirmOk.removeEventListener("click", onOk);
      els.confirmCancel.removeEventListener("click", onCancel);
      els.confirmBackdrop.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onKey = (e) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onOk();
    };
    els.confirmOk.addEventListener("click", onOk);
    els.confirmCancel.addEventListener("click", onCancel);
    els.confirmBackdrop.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
    setTimeout(() => els.confirmOk.focus(), 0);
  });
}

// ---------- file loading ----------

function detectFileType(name) {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "json") return "json";
  if (ext === "csv") return "csv";
  return "parquet";
}

async function registerBuffer(buf, type = "parquet") {
  if (!state.db || !state.conn) throw new Error("DuckDB is not ready yet.");
  const db = state.db;
  const name = `current-${++_fileSeq}.parquet`;
  await db.registerFileBuffer(name, new Uint8Array(buf));
  const reader =
    type === "json" ? `read_json_auto('${name}')` :
    type === "csv"  ? `read_csv_auto('${name}')` :
                     `read_parquet('${name}')`;
  await state.conn.query(
    `CREATE OR REPLACE VIEW data AS SELECT * FROM ${reader};`,
  );
  if (registeredName) {
    try { await db.dropFile(registeredName); } catch (_) {}
  }
  registeredName = name;
  state.loaded = true;
  state.fileType = type;
  state.page = 0;
}

async function loadFromFile(file) {
  const type = detectFileType(file.name);
  resetFileState();
  setStatus(`Reading ${file.name} (${formatBytes(file.size)})…`);
  const buf = await file.arrayBuffer();
  // Clone before passing to registerBuffer: DuckDB transfers the underlying
  // ArrayBuffer to its worker, detaching our reference. We keep the clone for
  // the Download button.
  const ownCopy = buf.slice(0);
  await registerBuffer(buf, type);
  rememberFile(ownCopy, file.name);
  await onLoaded(file.name, file.size);
  reflectInUrl(`file:///${file.name}`);
}

// Tracks the in-flight URL load so a superseding load can abort it.
let _loadUrlAbortCtrl = null;

async function loadFromURL(u) {
  // Reject schemes other than http, https, and file to avoid misuse of the
  // extension's broad host_permissions against arbitrary data: or blob: URLs.
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error(`Invalid URL: ${u}`); }
  if (!["https:", "http:", "file:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL scheme "${parsed.protocol}" — only http, https, and file are accepted.`);
  }

  if (_loadUrlAbortCtrl) _loadUrlAbortCtrl.abort();
  const ctrl = new AbortController();
  _loadUrlAbortCtrl = ctrl;

  resetFileState();
  setStatus(`Fetching ${u}…`);
  try {
    const res = await fetch(u, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    if (ctrl.signal.aborted) return;

    const size = buf.byteLength;
    const ownCopy = buf.slice(0);
    const name = extractFilename(u);
    await registerBuffer(buf, detectFileType(name));
    rememberFile(ownCopy, name);
    await onLoaded(name, size);
    reflectInUrl(u);
  } catch (e) {
    if (e.name === "AbortError") return;
    throw e;
  } finally {
    if (_loadUrlAbortCtrl === ctrl) _loadUrlAbortCtrl = null;
  }
}

function extractFilename(u) {
  try {
    const pathname = new URL(u).pathname;
    const last = pathname.split("/").pop();
    return decodeURIComponent(last) || "data.parquet";
  } catch {
    return u.split("/").pop() || "data.parquet";
  }
}

const PARQUET_ONLY_TABS = ["row-groups", "metadata", "kv"];

function setParquetOnlyTabs(visible) {
  for (const name of PARQUET_ONLY_TABS) {
    const tab = els.tabs.find((t) => t.dataset.tab === name);
    if (tab) tab.hidden = !visible;
  }
  if (!visible) {
    const active = els.tabs.find((t) => t.classList.contains("active"));
    if (active && PARQUET_ONLY_TABS.includes(active.dataset.tab)) {
      activateTab("data");
    }
  }
}

function resetFileState() {
  // Kill any in-flight query (e.g. a background COUNT from fetchQueryTotal)
  // before the file swap — its results are for the outgoing file anyway.
  if (state.conn) state.conn.cancelSent().catch(() => {});
  state.loaded = false;
  state.fileType = null;
  state.fileBuffer = null;
  state.fileName = null;
  state.totalRows = 0;
  state.rowGroupId = null;
  state.page = 0;
  if (dataColumns.length > 0) {
    dataColumns = [];
    applySqlLang();
  }
  // Old result tabs point at the previous file's data view — drop them.
  clearQueryResults();
  setParquetOnlyTabs(true);

  els.download.disabled = true;
  els.rowGroupSelect.disabled = true;
  els.rowGroupSelect.replaceChildren();
  els.prevPage.disabled = true;
  els.nextPage.disabled = true;
  els.pageInfo.textContent = "";

  const empty = emptyDiv("No file loaded.");
  for (const grid of [els.dataGrid, els.schemaGrid, els.fileMetaGrid, els.kvGrid, els.rowGroupsSummaryGrid, els.rowGroupsStatsGrid]) {
    grid.replaceChildren(empty.cloneNode(true));
  }
}

function rememberFile(buffer, name) {
  state.fileBuffer = buffer;
  state.fileName = name;
  els.download.disabled = false;
}

function downloadCurrent() {
  if (!state.fileBuffer || !state.fileName) return;
  const blob = new Blob([state.fileBuffer], { type: "application/octet-stream" });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = state.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  setStatus(`Downloaded ${state.fileName}.`, "ok");
}

// Reflects the currently loaded URL into the address bar and URL input.
// On page reload the ?url= param is picked up by getInitialUrl().
// Direct navigations to *.parquet URLs come in via #url= (DNR redirect).
function reflectInUrl(u) {
  els.urlInput.value = u;
  const next = `${location.pathname}?url=${encodeURIComponent(u)}`;
  history.replaceState(null, "", next);
}

async function onLoaded(label, size) {
  setStatus(`Loaded ${label} (${formatBytes(size)}). Inspecting…`);
  const isParquet = state.fileType === "parquet";
  setParquetOnlyTabs(isParquet);
  const refreshes = [refreshSchema(), refreshTotalRows()];
  if (isParquet) {
    refreshes.push(refreshFileMetadata(), refreshRowGroupSelector(), refreshKvMetadata());
  }
  await Promise.all(refreshes);
  if (isParquet) await refreshRowGroupView();
  await refreshDataPage();
  setStatus(`Loaded ${label} — ${state.totalRows.toLocaleString()} rows.`, "ok");
}

// ---------- data refresh ----------

async function refreshSchema() {
  const r = await state.conn.query(`DESCRIBE SELECT * FROM data;`);
  renderTable(els.schemaGrid, r);
  dataColumns = arrowToRows(r).map((row) => ({
    label: String(row.column_name),
    detail: String(row.column_type),
    type: "property",
  }));
  applySqlLang();
}

async function refreshFileMetadata() {
  const r = await state.conn.query(
    `SELECT * FROM parquet_file_metadata('${registeredName}');`,
  );
  renderKeyValue(els.fileMetaGrid, r);
}

async function refreshRowGroupSelector() {
  const r = await state.conn.query(
    `SELECT DISTINCT row_group_id
     FROM parquet_metadata('${registeredName}')
     ORDER BY row_group_id;`,
  );
  const ids = arrowToRows(r).map((r) => Number(r.row_group_id));
  els.rowGroupSelect.replaceChildren();
  for (const id of ids) {
    const opt = document.createElement("option");
    opt.value = String(id);
    opt.textContent = `Row group ${id}`;
    els.rowGroupSelect.appendChild(opt);
  }
  state.rowGroupId = ids[0] ?? null;
  if (state.rowGroupId !== null) {
    els.rowGroupSelect.value = String(state.rowGroupId);
  }
  els.rowGroupSelect.disabled = ids.length === 0;
}

async function refreshRowGroupView() {
  if (state.rowGroupId === null) {
    els.rowGroupsSummaryGrid.replaceChildren(emptyDiv("No row groups."));
    els.rowGroupsStatsGrid.replaceChildren(emptyDiv("No row groups."));
    return;
  }
  const id = state.rowGroupId;
  const summary = await state.conn.query(
    `SELECT row_group_id,
            any_value(row_group_num_rows)            AS num_rows,
            any_value(row_group_num_columns)         AS num_columns,
            sum(total_compressed_size)::BIGINT       AS compressed_bytes,
            sum(total_uncompressed_size)::BIGINT     AS uncompressed_bytes,
            round(100.0 * sum(total_compressed_size)
                  / nullif(sum(total_uncompressed_size), 0), 2) AS compression_pct
     FROM parquet_metadata('${registeredName}')
     WHERE row_group_id = ${id}
     GROUP BY row_group_id;`,
  );
  renderKeyValue(els.rowGroupsSummaryGrid, summary);

  const stats = await state.conn.query(
    `SELECT path_in_schema                         AS column,
            type,
            num_values,
            stats_min_value                        AS min,
            stats_max_value                        AS max,
            stats_null_count                       AS null_count,
            stats_distinct_count                   AS distinct_count,
            compression,
            encodings,
            total_compressed_size                  AS compressed_bytes,
            total_uncompressed_size                AS uncompressed_bytes
     FROM parquet_metadata('${registeredName}')
     WHERE row_group_id = ${id}
     ORDER BY column_id;`,
  );
  renderTable(els.rowGroupsStatsGrid, stats);
}

async function refreshKvMetadata() {
  try {
    const r = await state.conn.query(
      `SELECT key::VARCHAR   AS key,
              value::VARCHAR AS value
       FROM parquet_kv_metadata('${registeredName}');`,
    );
    renderKvPairs(els.kvGrid, r);
  } catch (e) {
    els.kvGrid.replaceChildren(emptyDiv(`No key/value metadata available (${e.message}).`));
  }
}

async function refreshTotalRows() {
  const r = await state.conn.query(`SELECT count(*)::BIGINT AS n FROM data;`);
  const rows = arrowToRows(r);
  state.totalRows = Number(rows[0]?.n ?? 0);
}

async function refreshDataPage() {
  if (!state.loaded) return;
  const limit = state.pageSize;
  const offset = state.page * limit;
  const r = await state.conn.query(
    `SELECT * FROM data LIMIT ${limit} OFFSET ${offset};`,
  );
  clearCellSelection();
  renderTable(els.dataGrid, r, { rowOffset: offset + 1 });
  const end = Math.min(offset + limit, state.totalRows);
  els.pageInfo.textContent = state.totalRows === 0
    ? ""
    : `${(offset + 1).toLocaleString()}–${end.toLocaleString()} of ${state.totalRows.toLocaleString()}`;
  els.prevPage.disabled = state.page === 0;
  els.nextPage.disabled = end >= state.totalRows;
}

// ---------- query / export ----------

const EXPORT_FORMATS = {
  csv:     { ext: "csv",     mime: "text/csv",                opts: "(HEADER, DELIMITER ',')" },
  json:    { ext: "json",    mime: "application/json",        opts: "(FORMAT JSON, ARRAY)" },
  parquet: { ext: "parquet", mime: "application/octet-stream", opts: "(FORMAT PARQUET)" },
};

// Exports the active result tab's query (its full result set, not the
// visible page). Uses the exact SQL the tab was run with — the editor may
// have changed since.
async function exportQuery() {
  const r = activeResult();
  if (!r) return;
  const querySql = r.sql.trim().replace(/;\s*$/, "");
  if (!querySql) return;
  const fmt = EXPORT_FORMATS[els.exportFormat.value];
  if (!fmt) return;

  const outName = `export.${fmt.ext}`;
  const downloadName = `${r.label.toLowerCase().replace(/\s+/g, "-")}.${fmt.ext}`;
  setStatus(`Exporting query as ${fmt.ext.toUpperCase()}…`);
  try {
    try { await state.db.dropFile(outName); } catch (_) {}
    await state.conn.query(`COPY (${querySql}) TO '${outName}' ${fmt.opts};`);
    const data = await state.db.copyFileToBuffer(outName);

    const blob = new Blob([data], { type: fmt.mime });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);

    setStatus(`Exported ${downloadName} (${formatBytes(data.byteLength)}).`, "ok");
  } catch (e) {
    setStatus(`Export failed: ${e.message}`, "error");
  }
}

let _queryCountGen = 0;
let _resultSeq = 0;

function activeResult() {
  return state.results.find((r) => r.id === state.activeResultId) ?? null;
}

function renderResultTabs() {
  hideQueryTooltip();
  els.resultTabs.replaceChildren();
  els.resultTabs.hidden = state.results.length === 0;
  for (const r of state.results) {
    const tab = document.createElement("button");
    tab.className = "rtab" + (r.id === state.activeResultId ? " active" : "");
    tab.addEventListener("mouseenter", () => showQueryTooltip(tab, r.sql, "below"));
    tab.addEventListener("mouseleave", hideQueryTooltip);
    const label = document.createElement("span");
    label.className = "rtab-label";
    label.textContent = r.label;
    tab.appendChild(label);
    const close = document.createElement("span");
    close.className = "rtab-close";
    close.textContent = "×";
    close.title = "Close";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeResult(r.id);
    });
    tab.appendChild(close);
    tab.addEventListener("click", () => activateResult(r.id));
    els.resultTabs.appendChild(tab);
  }
}

// Loads the active result's SQL into the editor, so the editor always shows
// the query behind the visible result. Overwrites in-progress edits — run
// them (or run in a new tab) before switching away to keep them.
function syncEditorToActive() {
  const r = activeResult();
  if (r && getSql() !== r.sql) setSql(r.sql);
}

function activateResult(id) {
  if (state.activeResultId === id) return;
  state.activeResultId = id;
  renderResultTabs();
  renderActiveResult();
  syncEditorToActive();
}

function closeResult(id) {
  const idx = state.results.findIndex((r) => r.id === id);
  if (idx === -1) return;
  state.results.splice(idx, 1);
  if (state.activeResultId === id) {
    const next = state.results[idx] ?? state.results[idx - 1] ?? null;
    state.activeResultId = next ? next.id : null;
    syncEditorToActive();
  }
  renderResultTabs();
  renderActiveResult();
}

function clearQueryResults() {
  state.results = [];
  state.activeResultId = null;
  renderResultTabs();
  renderActiveResult();
}

// Re-renders the query grid and pager from the active result's cached state.
// Tab switches replay the stored Arrow table — no re-query.
function renderActiveResult() {
  const r = activeResult();
  clearCellSelection();
  els.exportQuery.disabled = !r;
  els.exportQuery.title = r
    ? `Export the full result of ${r.label}`
    : "Run a query first";
  if (!r) {
    els.queryGrid.replaceChildren();
    els.queryPager.hidden = true;
    return;
  }
  els.queryPager.hidden = false;
  if (r.error) {
    els.queryGrid.replaceChildren(emptyDiv(r.error));
    els.queryPageInfo.textContent = "";
    els.queryPrevPage.disabled = true;
    els.queryNextPage.disabled = true;
    return;
  }
  renderTable(els.queryGrid, r.table, {
    rowOffset: r.isSelect ? r.page * state.queryPageSize + 1 : null,
  });
  if (r.isSelect) {
    els.queryPrevPage.disabled = r.page === 0;
    updateQueryPagerInfo(r);
  } else {
    els.queryPageInfo.textContent = "";
    els.queryPrevPage.disabled = true;
    els.queryNextPage.disabled = true;
  }
}

async function runUserQuery(intoNewTab = false) {
  const querySql = getSql().trim();
  if (!querySql) return;
  let r = intoNewTab ? null : activeResult();
  if (!r) {
    r = {
      id: ++_resultSeq,
      label: `Result ${_resultSeq}`,
      sql: querySql,
      page: 0,
      pageRows: 0,
      totalRows: null,
      table: null,
      error: null,
      isSelect: false,
      gen: 0,
    };
    state.results.push(r);
    state.activeResultId = r.id;
  } else {
    r.sql = querySql;
    r.page = 0;
    r.pageRows = 0;
    r.totalRows = null;
    r.error = null;
  }
  r.gen = ++_queryCountGen;
  renderResultTabs();
  const ok = await runQueryPage(r);
  if (ok) {
    rememberQuery(querySql);
    if (r.isSelect) fetchQueryTotal(r, r.gen);
  }
}

async function fetchQueryTotal(r, gen) {
  try {
    const res = await state.conn.query(
      `SELECT count(*)::BIGINT AS n FROM (${r.sql.replace(/;\s*$/, "")}) AS __parquack_result__;`,
    );
    if (gen !== r.gen || !state.results.includes(r)) return;
    const rows = arrowToRows(res);
    r.totalRows = Number(rows[0]?.n ?? 0);
    if (state.activeResultId === r.id && r.isSelect && !r.error) {
      updateQueryPagerInfo(r);
    }
  } catch {}
}

function updateQueryPagerInfo(r) {
  const offset = r.page * state.queryPageSize;
  if (r.pageRows === 0) {
    els.queryPageInfo.textContent = "No rows";
    els.queryNextPage.disabled = true;
    return;
  }
  const range = `${(offset + 1).toLocaleString()}–${(offset + r.pageRows).toLocaleString()}`;
  if (r.totalRows !== null) {
    els.queryPageInfo.textContent = `${range} of ${r.totalRows.toLocaleString()}`;
    els.queryNextPage.disabled = offset + r.pageRows >= r.totalRows;
  } else {
    els.queryPageInfo.textContent = range;
    // Without a total, use heuristic: fewer rows than limit means last page
    els.queryNextPage.disabled = r.pageRows < state.queryPageSize;
  }
}

async function runQueryPage(r) {
  const querySql = r.sql;
  if (!querySql) return false;

  // Only SELECT/WITH queries get wrapped in LIMIT/OFFSET. DDL, EXPLAIN, COPY
  // etc. are run as-is and their results shown without pagination.
  const isSelect = /^\s*(SELECT|WITH)\b/i.test(querySql);
  r.isSelect = isSelect;
  const limit = state.queryPageSize;
  const offset = r.page * limit;

  setStatus("Running query…");
  try {
    const t0 = performance.now();
    const table = isSelect
      ? await state.conn.query(
          `SELECT * FROM (${querySql.replace(/;\s*$/, "")}) AS __parquack_result__ LIMIT ${limit} OFFSET ${offset};`,
        )
      : await state.conn.query(querySql);
    const ms = performance.now() - t0;

    r.table = table;
    r.error = null;
    r.pageRows = isSelect ? table.numRows : 0;
    if (state.activeResultId === r.id) renderActiveResult();
    setStatus(`Query OK — ${table.numRows.toLocaleString()} rows in ${formatMs(ms)}.`, "ok");
    return true;
  } catch (e) {
    // Superseded (tab closed / results cleared by a file load, possibly via
    // cancelSent): swallow — the error belongs to a result nobody can see,
    // and setStatus would stomp the newer load's status line.
    if (!state.results.includes(r)) return false;
    const friendly = friendlyQueryError(e.message);
    r.error = friendly.body;
    r.table = null;
    setStatus(friendly.status, "error");
    if (state.activeResultId === r.id) renderActiveResult();
    return false;
  }
}

function friendlyQueryError(msg) {
  if (!state.loaded && /Table with name data does not exist/i.test(msg)) {
    return {
      status: "No file loaded — open a parquet file to query the data view.",
      body:
        "No file loaded yet. Open a parquet file (toolbar, drag-drop, or paste a URL) " +
        "and the data view will be created automatically.",
    };
  }
  return { status: `Query error: ${msg}`, body: msg };
}

// ---------- recent queries ----------

const RECENT_KEY = "parquack:recent-queries";
const RECENT_CAP = 30;
const HISTORY_COLLAPSED_KEY = "parquack:history-collapsed";
const HISTORY_WIDTH_KEY = "parquack:history-width";
const HISTORY_MIN_WIDTH = 180;
const HISTORY_MAX_WIDTH = 800;

function applyHistoryCollapsed() {
  const collapsed = localStorage.getItem(HISTORY_COLLAPSED_KEY) === "1";
  els.queryHistory.classList.toggle("collapsed", collapsed);
  const label = collapsed ? "Expand recent queries" : "Collapse recent queries";
  els.qhToggle.title = label;
  els.qhToggle.setAttribute("aria-label", label);
}

function toggleHistoryCollapsed() {
  const next = !els.queryHistory.classList.contains("collapsed");
  localStorage.setItem(HISTORY_COLLAPSED_KEY, next ? "1" : "0");
  applyHistoryCollapsed();
}

function applyHistoryWidth() {
  const stored = parseInt(localStorage.getItem(HISTORY_WIDTH_KEY) || "", 10);
  if (Number.isFinite(stored)) {
    const w = Math.max(HISTORY_MIN_WIDTH, Math.min(HISTORY_MAX_WIDTH, stored));
    els.queryHistory.style.setProperty("--history-width", `${w}px`);
  }
}

function startHistoryResize(ev) {
  if (els.queryHistory.classList.contains("collapsed")) return;
  ev.preventDefault();
  const rightEdge = els.queryHistory.getBoundingClientRect().right;
  els.queryHistory.classList.add("resizing");

  let lastWidth = null;
  const onMove = (e) => {
    const w = Math.max(
      HISTORY_MIN_WIDTH,
      Math.min(HISTORY_MAX_WIDTH, rightEdge - e.clientX),
    );
    lastWidth = w;
    els.queryHistory.style.setProperty("--history-width", `${w}px`);
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    els.queryHistory.classList.remove("resizing");
    if (lastWidth !== null) {
      localStorage.setItem(HISTORY_WIDTH_KEY, String(lastWidth));
    }
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function saveRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); }
  catch {}
}

const RECENT_MAX_QUERY_LENGTH = 10_000;

function rememberQuery(querySql) {
  if (querySql.length > RECENT_MAX_QUERY_LENGTH) return;
  const list = loadRecent().filter((s) => s !== querySql);
  list.unshift(querySql);
  if (list.length > RECENT_CAP) list.length = RECENT_CAP;
  saveRecent(list);
  renderRecent();
}

function removeQuery(querySql) {
  saveRecent(loadRecent().filter((s) => s !== querySql));
  renderRecent();
}

let _qhTooltip = null;

function showQueryTooltip(anchor, text, placement = "left") {
  if (!_qhTooltip) {
    _qhTooltip = document.createElement("div");
    _qhTooltip.className = "qh-tooltip";
    document.body.appendChild(_qhTooltip);
  }
  _qhTooltip.textContent = text;
  // Render off-screen first so getBoundingClientRect gives the real size.
  _qhTooltip.style.left = "0";
  _qhTooltip.style.top = "0";
  _qhTooltip.style.display = "block";
  const ar = anchor.getBoundingClientRect();
  const tr = _qhTooltip.getBoundingClientRect();
  if (placement === "below") {
    _qhTooltip.style.left = `${Math.max(8, Math.min(ar.left, window.innerWidth - tr.width - 8))}px`;
    _qhTooltip.style.top = `${Math.min(ar.bottom + 6, window.innerHeight - tr.height - 8)}px`;
  } else {
    _qhTooltip.style.left = `${Math.max(8, ar.left - tr.width - 8)}px`;
    _qhTooltip.style.top = `${Math.min(ar.top, window.innerHeight - tr.height - 8)}px`;
  }
}

function hideQueryTooltip() {
  if (_qhTooltip) _qhTooltip.style.display = "none";
}

function renderRecent() {
  const list = loadRecent();
  els.recentQueries.replaceChildren();
  if (list.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No queries yet.";
    els.recentQueries.appendChild(empty);
    return;
  }
  for (const querySql of list) {
    const li = document.createElement("li");

    const text = document.createElement("span");
    text.className = "qh-text";
    text.textContent = querySql.replace(/\s+/g, " ");
    li.appendChild(text);
    li.addEventListener("mouseenter", () => showQueryTooltip(li, querySql));
    li.addEventListener("mouseleave", hideQueryTooltip);

    const del = document.createElement("button");
    del.className = "qh-delete";
    del.title = "Remove";
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeQuery(querySql);
    });
    li.appendChild(del);

    li.addEventListener("click", () => {
      setSql(querySql);
      activateTab("query");
      runUserQuery();
    });
    els.recentQueries.appendChild(li);
  }
}

// ---------- helpers ----------

function arrowToRows(table) {
  const out = [];
  for (const row of table) {
    out.push(row.toJSON());
  }
  return out;
}

function formatCell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) {
    return `0x${Array.from(v.slice(0, 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}${v.length > 16 ? "…" : ""}`;
  }
  if (typeof v === "object") {
    try { return JSON.stringify(v, bigintReplacer); }
    catch { return String(v); }
  }
  return String(v);
}

function bigintReplacer(_, v) {
  return typeof v === "bigint" ? v.toString() : v;
}

function getInitialUrl() {
  // ?url= is written by reflectInUrl() via history.replaceState, so page
  // reloads re-enter through here. Direct *.parquet navigations come in via
  // the DNR redirect which puts the original URL in #url=.
  const fromQuery = new URLSearchParams(location.search).get("url");
  if (fromQuery) return fromQuery;
  if (location.hash.startsWith("#url=")) return location.hash.slice(5);
  return null;
}

function emptyDiv(text) {
  const d = document.createElement("div");
  d.className = "empty";
  d.textContent = text;
  return d;
}

function renderKvPairs(container, table) {
  if (!table || table.numRows === 0) {
    container.replaceChildren(emptyDiv("No key/value metadata."));
    return;
  }
  const rows = arrowToRows(table);
  const tbl = document.createElement("table");
  tbl.className = "kv";
  const thead = tbl.createTHead();
  const hr = thead.insertRow();
  for (const label of ["Key", "Value"]) {
    const th = document.createElement("th");
    th.textContent = label;
    hr.appendChild(th);
  }
  const tbody = tbl.createTBody();
  for (const row of rows) {
    const k = formatCell(row.key);
    const v = formatCell(row.value);
    const tr = tbody.insertRow();
    const thEl = document.createElement("th");
    thEl.textContent = k ?? "";
    tr.appendChild(thEl);
    const td = tr.insertCell();
    if (v === null) { td.className = "null"; td.textContent = "NULL"; }
    else td.textContent = v;
  }
  container.replaceChildren(tbl);
}

function renderKeyValue(container, table) {
  if (!table || table.numRows === 0) {
    container.replaceChildren(emptyDiv("No metadata."));
    return;
  }
  const fields = table.schema.fields.map((f) => f.name);
  const rows = arrowToRows(table);
  const tbl = document.createElement("table");
  tbl.className = "kv";
  const thead = tbl.createTHead();
  const hr = thead.insertRow();
  for (const label of ["Key", "Value"]) {
    const th = document.createElement("th");
    th.textContent = label;
    hr.appendChild(th);
  }
  const tbody = tbl.createTBody();
  rows.forEach((row, idx) => {
    if (rows.length > 1) {
      const section = tbody.insertRow();
      section.className = "kv-section";
      const th = document.createElement("th");
      th.colSpan = 2;
      th.textContent = `Entry ${idx + 1}`;
      section.appendChild(th);
    }
    for (const f of fields) {
      const v = formatCell(row[f]);
      const tr = tbody.insertRow();
      const thEl = document.createElement("th");
      thEl.textContent = f;
      tr.appendChild(thEl);
      const td = tr.insertCell();
      if (v === null) { td.className = "null"; td.textContent = "NULL"; }
      else td.textContent = v;
    }
  });
  container.replaceChildren(tbl);
}

function renderTable(container, table, { rowOffset = null } = {}) {
  if (!table || table.numRows === 0) {
    container.replaceChildren(emptyDiv("No rows."));
    return;
  }
  const fields = table.schema.fields.map((f) => f.name);
  const rows = arrowToRows(table);
  const hasRowNums = rowOffset !== null;

  const tbl = document.createElement("table");
  const thead = tbl.createTHead();
  const headerRow = thead.insertRow();
  if (hasRowNums) {
    const th = document.createElement("th");
    th.className = "row-num";
    th.textContent = "#";
    headerRow.appendChild(th);
  }
  for (let i = 0; i < fields.length; i++) {
    const th = document.createElement("th");
    th.dataset.col = i;
    th.textContent = fields[i];
    headerRow.appendChild(th);
  }

  const tbody = tbl.createTBody();
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    const tr = tbody.insertRow();
    if (hasRowNums) {
      const td = tr.insertCell();
      td.className = "row-num";
      td.textContent = rowOffset + ri;
    }
    for (let ci = 0; ci < fields.length; ci++) {
      const v = formatCell(row[fields[ci]]);
      const td = tr.insertCell();
      td.dataset.col = ci;
      if (v === null) {
        td.className = "null";
        td.textContent = "NULL";
      } else if (v.includes("\n")) {
        td.className = "pre";
        td.textContent = v;
      } else {
        td.textContent = v;
      }
    }
  }
  container.replaceChildren(tbl);
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

// ---------- cell selection ----------

let _gridAnchor = null;

function clearCellSelection() {
  document.querySelectorAll(".grid td.selected").forEach((el) => el.classList.remove("selected"));
  _gridAnchor = null;
}

function selectCell(td) {
  clearCellSelection();
  td.classList.add("selected");
  _gridAnchor = { kind: "cell", td };
  window.getSelection().removeAllRanges();
}

function toggleCell(td) {
  td.classList.toggle("selected");
  _gridAnchor = { kind: "cell", td };
  window.getSelection().removeAllRanges();
}

function getRowDataCells(rowEl) {
  return Array.from(rowEl.querySelectorAll("td:not(.row-num)"));
}

function selectRows(table, minIdx, maxIdx) {
  document.querySelectorAll(".grid td.selected").forEach((el) => el.classList.remove("selected"));
  window.getSelection().removeAllRanges();
  const allRows = Array.from(table.querySelectorAll("tbody tr"));
  for (let i = minIdx; i <= maxIdx; i++) {
    if (allRows[i]) getRowDataCells(allRows[i]).forEach((td) => td.classList.add("selected"));
  }
}

function ctrlToggleRows(table, rowIdx) {
  const allRows = Array.from(table.querySelectorAll("tbody tr"));
  const cells = allRows[rowIdx] ? getRowDataCells(allRows[rowIdx]) : [];
  const allOn = cells.length > 0 && cells.every((td) => td.classList.contains("selected"));
  cells.forEach((td) => td.classList.toggle("selected", !allOn));
  window.getSelection().removeAllRanges();
}

function selectCols(table, minIdx, maxIdx) {
  document.querySelectorAll(".grid td.selected").forEach((el) => el.classList.remove("selected"));
  window.getSelection().removeAllRanges();
  for (let i = minIdx; i <= maxIdx; i++) {
    table.querySelectorAll(`tbody td[data-col="${i}"]`).forEach((td) => td.classList.add("selected"));
  }
}

function ctrlToggleCols(table, colIdx) {
  const cells = Array.from(table.querySelectorAll(`tbody td[data-col="${colIdx}"]`));
  const allOn = cells.length > 0 && cells.every((td) => td.classList.contains("selected"));
  cells.forEach((td) => td.classList.toggle("selected", !allOn));
  window.getSelection().removeAllRanges();
}

function selectCellRange(from, to) {
  if (from.closest("table") !== to.closest("table")) {
    selectCell(to);
    return;
  }
  const allRows = Array.from(from.closest("table").querySelectorAll("tbody tr"));
  const fromRowIdx = allRows.indexOf(from.closest("tr"));
  const toRowIdx = allRows.indexOf(to.closest("tr"));
  if (fromRowIdx === -1 || toRowIdx === -1) { selectCell(to); return; }

  const fromColIdx = Array.from(from.closest("tr").querySelectorAll("td")).indexOf(from);
  const toColIdx = Array.from(to.closest("tr").querySelectorAll("td")).indexOf(to);
  if (fromColIdx === -1 || toColIdx === -1) { selectCell(to); return; }

  const minRow = Math.min(fromRowIdx, toRowIdx);
  const maxRow = Math.max(fromRowIdx, toRowIdx);
  const minCol = Math.min(fromColIdx, toColIdx);
  const maxCol = Math.max(fromColIdx, toColIdx);

  document.querySelectorAll(".grid td.selected").forEach((el) => el.classList.remove("selected"));
  window.getSelection().removeAllRanges();

  for (let r = minRow; r <= maxRow; r++) {
    const cells = Array.from(allRows[r].querySelectorAll("td"));
    for (let c = minCol; c <= maxCol; c++) {
      if (cells[c]) cells[c].classList.add("selected");
    }
  }
}

// ---------- tab switching ----------

function activateTab(name) {
  for (const t of els.tabs) t.classList.toggle("active", t.dataset.tab === name);
  for (const p of els.panels) p.classList.toggle("active", p.dataset.panel === name);
}

// ---------- wire UI ----------

function wireUI() {
  els.fileInput.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { await loadFromFile(f); }
    catch (err) { setStatus(err.message, "error"); }
    e.target.value = "";
  });

  els.urlLoad.addEventListener("click", async () => {
    const u = els.urlInput.value.trim();
    if (!u) return;
    try { await loadFromURL(u); }
    catch (err) { setStatus(err.message, "error"); }
  });

  els.urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.urlLoad.click();
  });

  els.download.addEventListener("click", downloadCurrent);

  els.prevPage.addEventListener("click", async () => {
    if (state.page === 0) return;
    state.page -= 1;
    await refreshDataPage();
  });
  els.nextPage.addEventListener("click", async () => {
    state.page += 1;
    await refreshDataPage();
  });
  els.pageSize.addEventListener("change", async () => {
    state.pageSize = parseInt(els.pageSize.value, 10) || 100;
    state.page = 0;
    await refreshDataPage();
  });

  els.rowGroupSelect.addEventListener("change", async () => {
    const id = parseInt(els.rowGroupSelect.value, 10);
    if (!Number.isInteger(id)) return;
    state.rowGroupId = id;
    await refreshRowGroupView();
  });

  els.queryPrevPage.addEventListener("click", async () => {
    const r = activeResult();
    if (!r || r.page === 0) return;
    r.page -= 1;
    await runQueryPage(r);
  });
  els.queryNextPage.addEventListener("click", async () => {
    const r = activeResult();
    if (!r) return;
    r.page += 1;
    await runQueryPage(r);
  });

  els.runQuery.addEventListener("click", () => runUserQuery());
  els.runQueryNew.addEventListener("click", () => runUserQuery(true));
  els.exportQuery.addEventListener("click", exportQuery);
  els.qhToggle.addEventListener("click", toggleHistoryCollapsed);
  els.qhRail.addEventListener("click", () => {
    localStorage.setItem(HISTORY_COLLAPSED_KEY, "0");
    applyHistoryCollapsed();
  });
  els.qhResize.addEventListener("mousedown", startHistoryResize);
  els.qhClear.addEventListener("click", async () => {
    if (loadRecent().length === 0) return;
    const ok = await showConfirm({
      title: "Clear recent queries",
      message: "Remove all saved recent queries? This can't be undone.",
      okLabel: "Clear",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;
    saveRecent([]);
    renderRecent();
  });

  els.queryPageSizeInput.addEventListener("input", validateSettingsForm);

  els.settingsOpen.addEventListener("click", openSettings);
  els.settingsClose.addEventListener("click", closeSettings);
  els.settingsCancel.addEventListener("click", closeSettings);
  els.settingsSave.addEventListener("click", saveSettings);
  els.settingsBackdrop.addEventListener("click", closeSettings);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.settingsModal.hidden) closeSettings();
  });

  for (const t of els.tabs) {
    t.addEventListener("click", () => activateTab(t.dataset.tab));
  }

  // ---------- cell selection ----------
  document.addEventListener("mousedown", (e) => {
    if (e.shiftKey && (e.target.closest(".grid td") || e.target.closest(".grid thead th[data-col]"))) {
      e.preventDefault();
    }
  });

  document.addEventListener("click", (e) => {
    const allNumTh = e.target.closest(".grid thead th.row-num");
    if (allNumTh) {
      const table = allNumTh.closest("table");
      const allCells = Array.from(table.querySelectorAll("tbody td:not(.row-num)"));
      const allOn = allCells.length > 0 && allCells.every((td) => td.classList.contains("selected"));
      document.querySelectorAll(".grid td.selected").forEach((el) => el.classList.remove("selected"));
      if (!allOn) allCells.forEach((td) => td.classList.add("selected"));
      window.getSelection().removeAllRanges();
      _gridAnchor = null;
      return;
    }
    const rowNumTd = e.target.closest(".grid td.row-num");
    if (rowNumTd) {
      const table = rowNumTd.closest("table");
      const allRows = Array.from(table.querySelectorAll("tbody tr"));
      const rowIdx = allRows.indexOf(rowNumTd.closest("tr"));
      if (e.ctrlKey || e.metaKey) {
        ctrlToggleRows(table, rowIdx);
        _gridAnchor = { kind: "row", rowIdx, table };
      } else if (e.shiftKey && _gridAnchor?.kind === "row" && _gridAnchor.table === table) {
        selectRows(table, Math.min(_gridAnchor.rowIdx, rowIdx), Math.max(_gridAnchor.rowIdx, rowIdx));
      } else {
        selectRows(table, rowIdx, rowIdx);
        _gridAnchor = { kind: "row", rowIdx, table };
      }
      return;
    }
    const colTh = e.target.closest(".grid thead th[data-col]");
    if (colTh) {
      const table = colTh.closest("table");
      const colIdx = parseInt(colTh.dataset.col, 10);
      if (e.ctrlKey || e.metaKey) {
        ctrlToggleCols(table, colIdx);
        _gridAnchor = { kind: "col", colIdx, table };
      } else if (e.shiftKey && _gridAnchor?.kind === "col" && _gridAnchor.table === table) {
        selectCols(table, Math.min(_gridAnchor.colIdx, colIdx), Math.max(_gridAnchor.colIdx, colIdx));
      } else {
        selectCols(table, colIdx, colIdx);
        _gridAnchor = { kind: "col", colIdx, table };
      }
      return;
    }
    const td = e.target.closest(".grid td:not(.row-num)");
    if (td) {
      if (e.shiftKey && _gridAnchor?.kind === "cell") {
        selectCellRange(_gridAnchor.td, td);
      } else if (e.ctrlKey || e.metaKey) {
        toggleCell(td);
      } else {
        selectCell(td);
      }
      return;
    }
    if (!e.target.closest(".grid")) {
      clearCellSelection();
    }
  });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "c") {
      const selected = Array.from(document.querySelectorAll(".grid td.selected"));
      if (selected.length === 0) return;
      e.preventDefault();
      const rowMap = new Map();
      for (const td of selected) {
        const row = td.closest("tr");
        if (!rowMap.has(row)) rowMap.set(row, []);
        rowMap.get(row).push(td);
      }
      const text = Array.from(rowMap.values())
        .map((cells) => cells.map((td) => td.textContent).join("\t"))
        .join("\n");
      navigator.clipboard.writeText(text).catch(() => {});
    }
  });

  document.body.addEventListener("dragover", (e) => { e.preventDefault(); });
  document.body.addEventListener("drop", async (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    try { await loadFromFile(f); }
    catch (err) { setStatus(err.message, "error"); }
  });
}

(async function main() {
  applyTheme(getTheme());
  state.queryPageSize = loadQueryPageSize();
  initEditor();
  wireUI();
  applyHistoryCollapsed();
  applyHistoryWidth();
  renderRecent();
  try {
    await initDuckDB();
  } catch (e) {
    setStatus(`DuckDB init failed: ${e.message}`, "error");
    return;
  }
  const initialUrl = getInitialUrl();
  if (initialUrl) {
    els.urlInput.value = initialUrl;
    try { await loadFromURL(initialUrl); }
    catch (err) { setStatus(err.message, "error"); }
  }
})();

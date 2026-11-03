
function resolveInvoke() {
  const t = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (!t) return null;
  if (t.core && typeof t.core.invoke === "function") return t.core.invoke.bind(t.core);
  if (typeof t.invoke === "function") return t.invoke.bind(t);
  if (t.tauri && typeof t.tauri.invoke === "function") return t.tauri.invoke.bind(t.tauri);
  return null;
}
const invoke = resolveInvoke();
// НЕ называть isTauri: Tauri v2 инжектит window.isTauri, top-level const с тем же
// именем — SyntaxError в WebKit, и весь скрипт молча умирает (#130)
const inTauri = !!invoke;

// Чистые presentation-хелперы вынесены в view-format.js (грузится раньше app.js)
// и покрыты юнит-тестами. Фолбэки на случай, если файл не подгрузился.
const VF = (typeof window !== "undefined" && window.ClaudeyeViewFormat) || {
  schedulerViewModel: (l) => (Array.isArray(l) ? l : []),
  commandToast: (cmd, out, ok) => ({ tone: ok === false ? "bad" : "good", title: cmd, detail: "" }),
  notificationsViewModel: (l) => ({ rows: Array.isArray(l) ? l : [], badge: 0, toNotify: [] }),
  nativeNotification: (r) => ({ title: "Claudeye", body: (r && r.title) || "", view: "notifications", key: "" }),
  sessionDetailViewModel: (d) => ({ id: (d && d.id) || "", project: (d && d.project) || "", summary: (d && d.summary) || "", started: "", ended: "", prompts: 0, count: 0, rows: [], empty: true }),
  searchViewModel: (h, q) => ({ query: q || "", count: Array.isArray(h) ? h.length : 0, rows: Array.isArray(h) ? h : [], empty: !(Array.isArray(h) && h.length) }),
  sessionExport: (d, f) => (f === "json" ? JSON.stringify(d || {}, null, 2) : ""),
};

const ICONS = {
  dashboard: 'M3 3h7v9H3V3zm11 0h7v5h-7V3zM3 15h7v6H3v-6zm11-4h7v10h-7V11z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  db: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
  trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  link: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z',
};

function icon(name) {
  const p = ICONS[name] || "";
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><path d="${p}"/></svg>`;
}

/* ── форматирование ── */

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// "2026-07-08 07:47:33" (UTC из SQLite) → «сегодня 10:47» / «вчера 19:03» / «07.07»
function fmtWhen(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return s || "";
  const d = new Date(s.replace(" ", "T") + "Z");
  if (isNaN(d)) return s;
  const now = new Date();
  const day = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (day(d) === day(now)) return `today ${hm}`;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (day(d) === day(yest)) return `yesterday ${hm}`;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" });
}

function basename(p) {
  if (!p) return "";
  const parts = String(p).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

const SEV_LABEL = { crit: "critical", warn: "warning", info: "info", good: "ok", mut: "normal" };

/* ── данные ── */

const SAMPLE = {
  health: { hooksUp: true, lastObs: "06:08", obs24h: 908, sessions7d: 14, projects: 3, quota: "1.6×", embPct: 74, streak: 20, dbMb: 262 },
  activity: {
    labels: ["25","26","27","28","29","30","01","02","03","04","05","06","07","08"],
    values: [412,655,590,120,80,702,866,731,0,0,540,812,690,908],
  },
  notifications: [
    { sev: "crit", title: "DB 520 MB — 1.7× the critical threshold", meta: "", status: "new", hash: "demo-db" },
    { sev: "warn", title: "Workload up 1.6× — recovery after the hook fix", meta: "", status: "shown", hash: "demo-vol" },
    { sev: "good", title: "Hooks are back — last_obs 06:08, 908 obs/24h", meta: "", status: "new", hash: "demo-hooks" },
    { sev: "info", title: "Embedding coverage 74% → run reindex", meta: "", status: "new", hash: "demo-emb" },
    { sev: "mut", title: "DB 262 MB — plateau, 280 MB threshold not crossed", meta: "", status: "dismissed", hash: "demo-old" },
  ],
  sessions: [
    { id: "demo-1", project: "claudeye", summary: "digest regression: 300s timeout + retry", prompts: 41, ended: "" },
    { id: "demo-2", project: "my-web-app", summary: "PaymentForm.tsx — checkout validation fixes", prompts: 32, ended: "" },
    { id: "demo-3", project: "docs", summary: "BACKLOG.md — backlog grooming", prompts: 27, ended: "" },
  ],
  agents: [
    { key: "insights", name: "Daily insights", schedule: "daily 09:00", installed: true, loaded: true },
    { key: "digest", name: "Weekly digest", schedule: "weekly (Mon)", installed: true, loaded: true },
    { key: "daemon", name: "Agent daemon", schedule: "hourly", installed: true, loaded: true },
  ],
};

async function loadData() {
  if (!invoke) return SAMPLE;
  try {
    const [health, activity, notifications, sessions] = await Promise.all([
      invoke("dashboard_summary"),
      invoke("activity_14d"),
      invoke("recent_notifications"),
      invoke("recent_sessions", { limit: 12 }),
    ]);
    return { health, activity, notifications, sessions };
  } catch (e) {
    console.error("Tauri invoke failed, using sample data:", e);
    return SAMPLE;
  }
}

/* ── вью ── */

let chartInstance = null;

function kpiCard(label, value, delta, tone) {
  return `<div class="card"><div class="lab">${label}</div><div class="num">${value}</div><div class="delta ${tone}">${delta}</div></div>`;
}

function renderOverview(d) {
  const h = d.health;
  const embTone = h.embPct >= 80 ? "good" : h.embPct >= 55 ? "mut" : "warn";
  const embDelta = h.embPct >= 80 ? "coverage ok" : h.embPct >= 55 ? "catching up" : "reindex needed";
  const cards = [
    kpiCard("Observations / 24h", h.obs24h, h.hooksUp ? "hooks active" : "hooks silent", h.hooksUp ? "good" : "bad"),
    kpiCard("Sessions / 7d", h.sessions7d, `${h.projects} ${plural(h.projects, "project", "projects", "projects")}`, "mut"),
    kpiCard("Pace", h.quota, h.quota === "normal" ? "steady" : "above average", h.quota === "normal" ? "mut" : "warn"),
    kpiCard("Embeddings", `${h.embPct}%`, embDelta, embTone),
    kpiCard("Health streak", h.streak, h.streak > 0 ? "green days in a row" : "no invariant runs yet", h.streak > 0 ? "good" : "mut"),
  ].join("");
  return `
    <div class="view-title">Overview</div>
    <div class="view-sub">memory + analytics for Claude Code · ${inTauri ? "live data from mem.db" : "demo data"}</div>
    <div class="kpi">${cards}</div>
    <div class="section">Activity · observations per day (14 days)</div>
    <div class="panel"><div class="chart-wrap" style="height:170px"><canvas id="activityChart"></canvas></div></div>
    <div class="section">Recent notifications</div>
    <div class="panel">${notifRows().length ? notifRows().slice(0, 4).map(rowNotif).join("") : emptyState("No notifications yet")}</div>
  `;
}

function emptyState(text) {
  return `<div class="empty"><i>${icon("inbox")}</i><span>${text}</span></div>`;
}

// Строки ленты берём из VM (#131): дедуплицированные, без 'dismissed'.
function notifRows() {
  return (state.notifVM && state.notifVM.rows) || [];
}

function rowNotif(n) {
  const chipSev = n.sev === "good" ? "mut" : n.sev;
  const isNew = (n.status || "new") === "new" && (n.sev === "crit" || n.sev === "warn");
  const dot = isNew ? `<span class="chip new">new</span>` : "";
  return `<div class="row"><span class="sev ${n.sev}"></span><span class="ttl">${n.title}</span>${dot}<span class="chip ${chipSev}">${SEV_LABEL[n.sev] || n.sev}</span><span class="meta">${fmtWhen(n.meta)}</span></div>`;
}

function renderNotifications() {
  const rows = notifRows();
  const hidden = (state.data ? state.data.notifications.length : 0) - rows.length;
  const hint = hidden > 0
    ? `${hidden} ${plural(hidden, "entry", "entries", "entries")} hidden (duplicates and dismissed).`
    : "";
  return `
    <div class="view-title">Notifications</div>
    <div class="view-sub">Feed of insights and alerts. Replaces ephemeral macOS popups — nothing gets lost.</div>
    <div class="panel">${rows.length ? rows.map(rowNotif).join("") : emptyState("No notifications yet — insights appear after the daily 09:00 run")}</div>
    <p class="hint">Regular insights do not pop up — they collect here. A native notification is sent only for critical alerts; clicking it opens this screen. ${hint}</p>
  `;
}

// экранирование для значений, попадающих в innerHTML (summary/tags из mem.db,
// пользовательский запрос) — иначе '<' в наблюдении ломает разметку/XSS.
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function tagChips(tags) {
  if (!tags || !tags.length) return "";
  return `<div class="tags">${tags.slice(0, 6).map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div>`;
}

// строка наблюдения (drill-in и поиск)
function rowObs(o) {
  const rationale = o.rationale ? `<div class="rationale">${esc(o.rationale)}</div>` : "";
  const projLine = o.project ? `${basename(o.project)} · ` : "";
  return `
    <div class="row obs">
      <span class="sev ${o.sev}"></span>
      <div style="min-width:0;flex:1">
        <div class="ttl obs-ttl">${esc(o.title)}</div>
        <div class="proj">${projLine}${esc(o.tool)}</div>
        ${tagChips(o.tags)}
        ${rationale}
      </div>
      <span class="meta">${fmtWhen(o.meta)}</span>
    </div>`;
}

function renderSessions(d) {
  const q = esc(state.sessionQuery || "");
  const rows = d.sessions.map(s => `
    <div class="row session" data-session-id="${esc(s.id)}">
      <span class="sev info"></span>
      <div style="min-width:0;flex:1">
        <div class="ttl">${esc(s.summary || "no summary")}</div>
        <div class="proj">${basename(s.project)} · ${s.prompts} ${plural(s.prompts, "prompt", "prompts", "prompts")}</div>
      </div>
      <span class="meta">${fmtWhen(s.ended)}</span>
    </div>`).join("");
  const results = state.searchVM ? renderSearchResults(state.searchVM) : "";
  return `
    <div class="view-title">Sessions</div>
    <div class="view-sub">Click a session to see its observations from mem.db. Search covers all memory (FTS5).</div>
    <div class="searchbar">
      <input id="memSearch" type="search" placeholder="Search memory…" value="${q}" autocomplete="off" spellcheck="false" />
      ${state.searchVM ? `<button class="btn" id="searchClear">Clear</button>` : ""}
    </div>
    ${results}
    ${state.searchVM ? "" : `
      <div class="section">Recent sessions · ${d.sessions.length}</div>
      <div class="panel">${d.sessions.length ? rows : emptyState("No sessions yet")}</div>
    `}
  `;
}

function renderSearchResults(vm) {
  const body = vm.empty
    ? emptyState(`Nothing found for "${esc(vm.query)}"`)
    : vm.rows.map(rowObs).join("");
  return `
    <div class="section">Search results · ${vm.count} for "${esc(vm.query)}"</div>
    <div class="panel">${body}</div>
  `;
}

function renderSessionDetail() {
  const vm = state.detailVM;
  if (!vm) return renderLoading("sessions");
  const when = [vm.started && `started ${fmtWhen(vm.started)}`, vm.ended && `ended ${fmtWhen(vm.ended)}`]
    .filter(Boolean).join(" · ");
  const body = vm.empty
    ? emptyState("This session has no observations")
    : vm.rows.map(rowObs).join("");
  return `
    <div class="detail-head">
      <button class="btn" id="detailBack">← Sessions</button>
      <div class="detail-export">
        <button class="btn" data-export="md">Export .md</button>
        <button class="btn" data-export="json">Export .json</button>
      </div>
    </div>
    <div class="view-title">${esc(basename(vm.project) || "Session")}</div>
    <div class="view-sub">${esc(vm.summary || "no summary")}</div>
    <div class="section">${vm.count} ${plural(vm.count, "observation", "observations", "observations")} · ${vm.prompts} ${plural(vm.prompts, "prompt", "prompts", "prompts")}${when ? " · " + when : ""}</div>
    <div class="panel">${body}</div>
  `;
}

// sev из view-format ('good'|'warn'|'bad') → css-классы, которые реально есть
// в styles.css (.sev.bad и .chip.good не определены)
const AGENT_DOT = { good: "good", warn: "warn", bad: "crit" };
const AGENT_CHIP = { good: "mut", warn: "warn", bad: "crit" };

function rowAgent(a) {
  const dot = AGENT_DOT[a.sev] || "mut";
  const chip = AGENT_CHIP[a.sev] || "mut";
  return `<div class="row"><span class="sev ${dot}"></span><span class="ttl">${a.name}</span><span class="chip ${chip}">${a.state}</span><span class="meta">${a.schedule}</span></div>`;
}

function renderAgentsPanel(list) {
  const vm = VF.schedulerViewModel(list);
  return vm.length ? vm.map(rowAgent).join("") : emptyState("Agent status unavailable");
}

function renderControls(d) {
  const agents = state.agents || d.agents || [];
  return `
    <div class="view-title">Controls</div>
    <div class="view-sub">Claudeye maintenance and background agent status.</div>
    <div class="section">Actions</div>
    <div class="ctrls">
      <button class="btn primary" data-cmd="reindex">${icon("refresh")}Reindex embeddings</button>
      <button class="btn" data-cmd="cleanup">${icon("trash")}Cleanup</button>
      <button class="btn" data-cmd="digest">${icon("file")}Generate digest</button>
      <button class="btn" data-cmd="agents">${icon("pause")}Refresh status</button>
      <button class="btn" data-cmd="board">${icon("link")}GitHub Project #4</button>
    </div>
    <div class="section">Launchd agents</div>
    <div class="panel" id="agentsPanel">${renderAgentsPanel(agents)}</div>
    <p class="hint">Buttons call Rust commands (rusqlite + Command). Agent status comes from <code>claudeye scheduler status</code>. Outside Tauri (demo mode) these are stubs.</p>
  `;
}

// Тянет живой статус launchd-агентов из cmd_agents_status (JSON) и
// перерисовывает только панель, не дёргая весь вью.
async function refreshAgentsPanel() {
  if (!invoke) return;
  try {
    const out = await invoke("cmd_agents_status");
    let parsed = null;
    try { parsed = JSON.parse(out); } catch { parsed = null; }
    if (Array.isArray(parsed)) {
      state.agents = parsed;
      const panel = document.getElementById("agentsPanel");
      if (panel) panel.innerHTML = renderAgentsPanel(parsed);
    }
  } catch (e) {
    console.error("agents status failed:", e);
  }
}

const VIEW_TITLES = { overview: "Overview", sessions: "Sessions", notifications: "Notifications", controls: "Controls" };

function renderLoading(view) {
  const title = VIEW_TITLES[view] || "Overview";
  const lines = Array.from({ length: 6 }, (_, i) => `<div class="sk-line" style="width:${88 - i * 9}%"></div>`).join("");
  return `
    <div class="view-title">${title}</div>
    <div class="view-sub">loading mem.db…</div>
    <div class="panel"><div class="skeleton">${lines}</div></div>
  `;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawChart(activity) {
  const el = document.getElementById("activityChart");
  if (!el) return;
  if (chartInstance) chartInstance.destroy();
  const last = activity.values.length - 1;
  const accent = cssVar("--accent") || "#6e63e8";
  const barColor = cssVar("--chart-bar") || "#d4d4da";
  const gridColor = cssVar("--chart-grid") || "#e8e8ec";
  const tickColor = cssVar("--text-3") || "#98989e";
  const colors = activity.values.map((_, i) => (i === last ? accent : barColor));
  chartInstance = new Chart(el, {
    type: "bar",
    data: { labels: activity.labels, datasets: [{ data: activity.values, backgroundColor: colors, borderRadius: 3, maxBarThickness: 22 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => Math.round(c.parsed.y) + " observations" } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: tickColor, font: { size: 10 } } },
        y: { grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 10 }, maxTicksLimit: 4 } },
      },
    },
  });
}

let toastSeq = 0;

function showToast(t) {
  const wrap = document.getElementById("toasts");
  if (!wrap) return;
  const id = `toast-${++toastSeq}`;
  const el = document.createElement("div");
  el.className = `toast ${t.tone || "good"}`;
  el.id = id;
  el.innerHTML = `<span class="sev ${t.tone === "bad" ? "crit" : "good"}"></span>` +
    `<div class="t-body"><div class="t-title">${t.title || ""}</div>` +
    (t.detail ? `<div class="t-detail">${t.detail}</div>` : "") + `</div>`;
  wrap.appendChild(el);
  // авто-скрытие: ошибки висят дольше
  const ttl = t.tone === "bad" ? 7000 : 4200;
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 260);
  }, ttl);
}

async function runCommand(cmd, btn) {
  const map = {
    reindex: "cmd_reindex", cleanup: "cmd_cleanup", digest: "cmd_digest",
    agents: "cmd_agents_status", board: "cmd_open_board",
  };
  if (cmd === "board" && inTauri && window.__TAURI__.opener) {
    try { await window.__TAURI__.opener.openUrl("https://github.com/users/leetio-varsha/projects/4"); return; } catch {}
  }
  // «Обновить статус» — не тост с сырым JSON, а перерисовка панели агентов
  if (cmd === "agents") {
    if (!invoke) { showToast({ tone: "good", title: "Agent status — demo", detail: "live data only inside Tauri" }); return; }
    await refreshAgentsPanel();
    showToast({ tone: "good", title: "Agent status — refreshed" });
    return;
  }
  if (!invoke) { showToast({ tone: "good", title: `${cmd} — demo`, detail: "commands run only inside Tauri" }); return; }
  if (btn) { btn.disabled = true; btn.classList.add("busy"); }
  showToast({ tone: "good", title: `${cmd}…`, detail: "running" });
  try {
    const out = await invoke(map[cmd]);
    showToast(VF.commandToast(cmd, out, true));
  } catch (e) {
    console.error(cmd, e);
    showToast(VF.commandToast(cmd, String(e && e.message ? e.message : e), false));
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove("busy"); }
  }
}

/* ── каркас ── */

// notifSeen — ключи алертов, по которым нативная нотификация уже уходила в этой
// сессии; переживает refresh, поэтому повторный клик «Обновить» не пере-алертит.
const state = {
  view: "overview", data: null, notifVM: null, notifSeen: new Set(),
  // #132 session management
  sessionQuery: "", searchVM: null, detailVM: null, detailId: null,
};

// Программная навигация — используется и сайдбаром, и deep-link из нативной
// нотификации (#131).
function goToView(view) {
  if (!VIEW_TITLES[view]) return;
  // уход с «Сессии» сбрасывает drill-in и поиск, чтобы возврат был на список
  if (view !== "sessions") { state.detailId = null; state.detailVM = null; }
  state.view = view;
  document.querySelectorAll(".navitem").forEach(n => {
    n.classList.toggle("on", n.dataset.view === view);
  });
  render();
}

// Открыть drill-in по сессии (#132): тянем наблюдения из mem.db.
async function openSessionDetail(id) {
  if (!id) return;
  state.detailId = id;
  if (!invoke) {
    // демо-режим: строим detail из sample-сессии
    const s = (state.data && state.data.sessions || []).find(x => x.id === id) || {};
    state.detailVM = VF.sessionDetailViewModel({ ...s, observations: [] });
    render();
    return;
  }
  state.detailVM = null;
  render(); // скелетон
  try {
    const detail = await invoke("session_detail", { id });
    state.detailVM = VF.sessionDetailViewModel(detail);
  } catch (e) {
    console.error("session_detail failed:", e);
    state.detailVM = VF.sessionDetailViewModel({ id });
    showToast({ tone: "bad", title: "Could not open session", detail: String(e && e.message ? e.message : e) });
  }
  render();
}

// Поиск по памяти (#132): FTS5 через Rust search_memory.
let searchSeq = 0;
async function runMemSearch(query) {
  const q = (query || "").trim();
  state.sessionQuery = query || "";
  if (!q) { state.searchVM = null; render(); return; }
  if (!invoke) {
    const hits = (state.data && state.data.sessions || [])
      .filter(s => (s.summary || "").toLowerCase().includes(q.toLowerCase()))
      .map(s => ({ id: s.id, summary: s.summary, tool: "", tags: "[]", importance: 0.5, rationale: "", created_at: s.ended, project: s.project }));
    state.searchVM = VF.searchViewModel(hits, q);
    render();
    return;
  }
  const seq = ++searchSeq;
  try {
    const hits = await invoke("search_memory", { query: q, limit: 40 });
    if (seq !== searchSeq) return; // устаревший ответ — игнор
    state.searchVM = VF.searchViewModel(hits, q);
  } catch (e) {
    console.error("search_memory failed:", e);
    state.searchVM = VF.searchViewModel([], q);
  }
  render();
}

// Экспорт текущей сессии (#132): собираем строку в view-format, кладём в
// буфер обмена (нативного file-dialog пока нет — clipboard + тост).
async function exportSession(format) {
  if (!state.detailVM) return;
  const detail = {
    id: state.detailVM.id, project: state.detailVM.project, summary: state.detailVM.summary,
    started: state.detailVM.started, ended: state.detailVM.ended, prompts: state.detailVM.prompts,
    observations: state.detailVM.rows.map(r => ({
      id: r.id, summary: r.title, tool: r.tool, tags: r.tags,
      importance: r.importance, rationale: r.rationale, created_at: r.meta,
    })),
  };
  const text = VF.sessionExport(detail, format);
  let ok = false;
  try {
    if (inTauri && window.__TAURI__ && window.__TAURI__.clipboardManager) {
      await window.__TAURI__.clipboardManager.writeText(text); ok = true;
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text); ok = true;
    }
  } catch (e) { console.error("clipboard write failed:", e); }
  showToast(ok
    ? { tone: "good", title: `Export .${format} — copied to clipboard`, detail: `${text.length} characters` }
    : { tone: "bad", title: `Export .${format}`, detail: "clipboard unavailable" });
}

function bindSessionEvents() {
  const backBtn = document.getElementById("detailBack");
  if (backBtn) backBtn.addEventListener("click", () => { state.detailId = null; state.detailVM = null; render(); });
  document.querySelectorAll("[data-export]").forEach(b =>
    b.addEventListener("click", () => exportSession(b.dataset.export)));
  document.querySelectorAll(".row.session").forEach(r =>
    r.addEventListener("click", () => openSessionDetail(r.dataset.sessionId)));
  const clr = document.getElementById("searchClear");
  if (clr) clr.addEventListener("click", () => runMemSearch(""));
  const input = document.getElementById("memSearch");
  if (input) {
    let t = null;
    input.addEventListener("input", () => {
      state.sessionQuery = input.value; // не терять фокус/значение при дебаунсе
      clearTimeout(t);
      t = setTimeout(() => runMemSearch(input.value), 250);
    });
    // фокус в конец при перерисовке, если поиск активен
    if (state.searchVM || state.sessionQuery) {
      input.focus();
      const v = input.value; input.value = ""; input.value = v;
    }
  }
}

// Нативные нотификации: только crit + status 'new' + ещё не показанные.
// Плагин уже зарегистрирован в main.rs (tauri_plugin_notification).
async function pushNativeAlerts() {
  const vmodel = state.notifVM;
  if (!vmodel || !vmodel.toNotify.length) return;
  const plugin = inTauri && window.__TAURI__ ? window.__TAURI__.notification : null;
  for (const row of vmodel.toNotify) {
    state.notifSeen.add(row.key); // помечаем до отправки — иначе гонка на refresh
    const n = VF.nativeNotification(row);
    if (!plugin || typeof plugin.sendNotification !== "function") continue;
    try {
      if (typeof plugin.isPermissionGranted === "function") {
        let granted = await plugin.isPermissionGranted();
        if (!granted && typeof plugin.requestPermission === "function") {
          granted = (await plugin.requestPermission()) === "granted";
        }
        if (!granted) continue;
      }
      plugin.sendNotification({ title: n.title, body: n.body });
    } catch (e) {
      console.error("native notification failed:", e);
    }
  }
}

// Deep-link: клик по нотификации фокусит окно — открываем нужный экран.
// Слушатель вешаем ОДИН раз за сессию, иначе каждый refresh плодил бы дубли.
async function bindNotificationDeepLink() {
  if (state.notifActionBound || !inTauri || !window.__TAURI__) return;
  const plugin = window.__TAURI__.notification;
  if (!plugin || typeof plugin.onAction !== "function") return;
  state.notifActionBound = true;
  try {
    await plugin.onAction(() => goToView("notifications"));
  } catch (_) { /* onAction есть не во всех версиях плагина — не критично */ }
}

function render() {
  const c = document.getElementById("content");
  const d = state.data;
  if (!d) { c.innerHTML = renderLoading(state.view); return; }
  if (state.view === "overview") { c.innerHTML = renderOverview(d); drawChart(d.activity); }
  else if (state.view === "notifications") c.innerHTML = renderNotifications();
  else if (state.view === "sessions") {
    c.innerHTML = state.detailId ? renderSessionDetail() : renderSessions(d);
    bindSessionEvents();
  }
  else if (state.view === "controls") { c.innerHTML = renderControls(d); refreshAgentsPanel(); }

  c.querySelectorAll("[data-cmd]").forEach(b => b.addEventListener("click", () => runCommand(b.dataset.cmd, b)));
}

function paintIcons() {
  document.querySelectorAll("i[data-icon]").forEach(i => { i.innerHTML = icon(i.dataset.icon); });
}

function setStatus(d) {
  const bar = document.getElementById("hookStatus");
  const txt = document.getElementById("hookText");
  const up = d.health.hooksUp;
  bar.classList.toggle("up", up); bar.classList.toggle("down", !up);
  txt.textContent = up ? "hooks active" : "hooks silent";
  document.getElementById("dbLine").textContent = `mem.db · ${d.health.dbMb} MB`;
  // Badge — из VM (#131): дедуп + без 'dismissed', а не сырой filter по ленте.
  state.notifVM = VF.notificationsViewModel(d.notifications, state.notifSeen);
  const badge = document.getElementById("navBadge");
  badge.hidden = state.notifVM.badge === 0;
  if (state.notifVM.badge > 0) badge.textContent = state.notifVM.badge;
}

async function boot() {
  paintIcons();
  render(); // скелетон, пока едут данные
  state.data = await loadData();
  setStatus(state.data);
  render();
  await bindNotificationDeepLink();
  await pushNativeAlerts();

  document.getElementById("nav").addEventListener("click", (e) => {
    const item = e.target.closest(".navitem");
    if (!item) return;
    goToView(item.dataset.view);
  });
  document.getElementById("refreshBtn").addEventListener("click", async () => {
    const btn = document.getElementById("refreshBtn");
    if (btn.classList.contains("spinning")) return; // защита от повторных кликов
    btn.classList.add("spinning");
    try {
      state.data = await loadData(); setStatus(state.data); render();
      await pushNativeAlerts();
    } finally {
      btn.classList.remove("spinning");
    }
  });
}

boot().catch((e) => {
  console.error("boot failed, rendering demo:", e);
  state.data = SAMPLE;
  try { setStatus(state.data); render(); } catch (_) {}
});

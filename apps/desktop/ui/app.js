
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
  const hm = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (day(d) === day(now)) return `сегодня ${hm}`;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (day(d) === day(yest)) return `вчера ${hm}`;
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function basename(p) {
  if (!p) return "";
  const parts = String(p).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

const SEV_LABEL = { crit: "критично", warn: "важно", info: "инфо", good: "ок", mut: "норма" };

/* ── данные ── */

const SAMPLE = {
  health: { hooksUp: true, lastObs: "06:08", obs24h: 908, sessions7d: 14, projects: 3, quota: "1.6×", embPct: 74, streak: 20, dbMb: 262 },
  activity: {
    labels: ["25","26","27","28","29","30","01","02","03","04","05","06","07","08"],
    values: [2,1,0,1,0,1,0,0,1,0,1,0,2,908],
  },
  notifications: [
    { sev: "warn", title: "Объём работы вырос в 1.6× — recovery после починки хуков", meta: "" },
    { sev: "good", title: "Хуки ожили — last_obs 06:08, 908 obs/24ч", meta: "" },
    { sev: "info", title: "Покрытие эмбеддингов 74% → запусти reindex", meta: "" },
    { sev: "mut", title: "DB 262 MB — плато, порог 280 MB не пробит", meta: "" },
  ],
  sessions: [
    { project: "claudeye", summary: "digest-регресс: 300s таймаут + retry", prompts: 41, ended: "" },
    { project: "wl-payments", summary: "WLPaymentForm.tsx — правки формы оплаты", prompts: 32, ended: "" },
    { project: "bdp", summary: "BACKLOG.md — груминг задач", prompts: 27, ended: "" },
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
  const embDelta = h.embPct >= 80 ? "покрытие ок" : h.embPct >= 55 ? "догоняет" : "нужен reindex";
  const cards = [
    kpiCard("Наблюдения / 24ч", h.obs24h, h.hooksUp ? "хуки активны" : "хуки молчат", h.hooksUp ? "good" : "bad"),
    kpiCard("Сессии / 7д", h.sessions7d, `${h.projects} ${plural(h.projects, "проект", "проекта", "проектов")}`, "mut"),
    kpiCard("Темп", h.quota, h.quota === "норма" ? "стабильный" : "выше среднего", h.quota === "норма" ? "mut" : "warn"),
    kpiCard("Эмбеддинги", `${h.embPct}%`, embDelta, embTone),
    kpiCard("Health streak", h.streak, h.streak > 0 ? "зелёных подряд" : "нет прогонов инвариантов", h.streak > 0 ? "good" : "mut"),
  ].join("");
  return `
    <div class="view-title">Обзор</div>
    <div class="view-sub">memory + analytics для Claude Code · ${inTauri ? "живые данные mem.db" : "демо-данные"}</div>
    <div class="kpi">${cards}</div>
    <div class="section">Активность · наблюдения в день (14 дней)</div>
    <div class="panel"><div class="chart-wrap" style="height:170px"><canvas id="activityChart"></canvas></div></div>
    <div class="section">Последние уведомления</div>
    <div class="panel">${d.notifications.length ? d.notifications.slice(0, 4).map(rowNotif).join("") : emptyState("Пока нет уведомлений")}</div>
  `;
}

function emptyState(text) {
  return `<div class="empty"><i>${icon("inbox")}</i><span>${text}</span></div>`;
}

function rowNotif(n) {
  const chipSev = n.sev === "good" ? "mut" : n.sev;
  return `<div class="row"><span class="sev ${n.sev}"></span><span class="ttl">${n.title}</span><span class="chip ${chipSev}">${SEV_LABEL[n.sev] || n.sev}</span><span class="meta">${fmtWhen(n.meta)}</span></div>`;
}

function renderNotifications(d) {
  return `
    <div class="view-title">Уведомления</div>
    <div class="view-sub">Лента insights и alerts. Заменяет эфемерные macOS-попапы — ничего не теряется.</div>
    <div class="panel">${d.notifications.length ? d.notifications.map(rowNotif).join("") : emptyState("Пока нет уведомлений — insights появляются после ежедневного прогона в 09:00")}</div>
    <p class="hint">Нативные попапы отключены (CLAUDEYE_NOTIFICATIONS=0). Здесь копится вся история; критические алерты будут дублироваться нативной нотификацией с deep-link (#131).</p>
  `;
}

function renderSessions(d) {
  const rows = d.sessions.map(s => `
    <div class="row">
      <span class="sev info"></span>
      <div style="min-width:0">
        <div class="ttl">${s.summary || "без описания"}</div>
        <div class="proj">${basename(s.project)} · ${s.prompts} ${plural(s.prompts, "промпт", "промпта", "промптов")}</div>
      </div>
      <span class="meta">${fmtWhen(s.ended)}</span>
    </div>`).join("");
  return `
    <div class="view-title">Сессии</div>
    <div class="view-sub">Сессии Claude Code и Cowork · последние ${d.sessions.length}.</div>
    <div class="panel">${d.sessions.length ? rows : emptyState("Сессий пока нет")}</div>
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
  return vm.length ? vm.map(rowAgent).join("") : emptyState("Статус агентов недоступен");
}

function renderControls(d) {
  const agents = state.agents || d.agents || [];
  return `
    <div class="view-title">Управление</div>
    <div class="view-sub">Обслуживание Claudeye и статус фоновых агентов.</div>
    <div class="section">Действия</div>
    <div class="ctrls">
      <button class="btn primary" data-cmd="reindex">${icon("refresh")}Reindex эмбеддингов</button>
      <button class="btn" data-cmd="cleanup">${icon("trash")}Cleanup</button>
      <button class="btn" data-cmd="digest">${icon("file")}Сгенерировать digest</button>
      <button class="btn" data-cmd="agents">${icon("pause")}Обновить статус</button>
      <button class="btn" data-cmd="board">${icon("link")}GitHub Project #4</button>
    </div>
    <div class="section">Launchd-агенты</div>
    <div class="panel" id="agentsPanel">${renderAgentsPanel(agents)}</div>
    <p class="hint">Кнопки вызывают Rust-команды (rusqlite + Command). Статус агентов — из <code>claudeye scheduler status</code>. В демо-режиме без Tauri — заглушки.</p>
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

const VIEW_TITLES = { overview: "Обзор", sessions: "Сессии", notifications: "Уведомления", controls: "Управление" };

function renderLoading(view) {
  const title = VIEW_TITLES[view] || "Обзор";
  const lines = Array.from({ length: 6 }, (_, i) => `<div class="sk-line" style="width:${88 - i * 9}%"></div>`).join("");
  return `
    <div class="view-title">${title}</div>
    <div class="view-sub">загружаю mem.db…</div>
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
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => Math.round(c.parsed.y) + " наблюдений" } } },
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
    if (!invoke) { showToast({ tone: "good", title: "Статус агентов — демо", detail: "живые данные только в Tauri" }); return; }
    await refreshAgentsPanel();
    showToast({ tone: "good", title: "Статус агентов — обновлён" });
    return;
  }
  if (!invoke) { showToast({ tone: "good", title: `${cmd} — демо`, detail: "команда выполняется только в Tauri" }); return; }
  if (btn) { btn.disabled = true; btn.classList.add("busy"); }
  showToast({ tone: "good", title: `${cmd}…`, detail: "выполняю" });
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

const state = { view: "overview", data: null };

function render() {
  const c = document.getElementById("content");
  const d = state.data;
  if (!d) { c.innerHTML = renderLoading(state.view); return; }
  if (state.view === "overview") { c.innerHTML = renderOverview(d); drawChart(d.activity); }
  else if (state.view === "notifications") c.innerHTML = renderNotifications(d);
  else if (state.view === "sessions") c.innerHTML = renderSessions(d);
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
  txt.textContent = up ? "хуки активны" : "хуки молчат";
  document.getElementById("dbLine").textContent = `mem.db · ${d.health.dbMb} MB`;
  const badge = document.getElementById("navBadge");
  const actionable = d.notifications.filter(n => n.sev === "crit" || n.sev === "warn").length;
  badge.hidden = actionable === 0;
  if (actionable > 0) badge.textContent = actionable;
}

async function boot() {
  paintIcons();
  render(); // скелетон, пока едут данные
  state.data = await loadData();
  setStatus(state.data);
  render();

  document.getElementById("nav").addEventListener("click", (e) => {
    const item = e.target.closest(".navitem");
    if (!item) return;
    document.querySelectorAll(".navitem").forEach(n => n.classList.remove("on"));
    item.classList.add("on");
    state.view = item.dataset.view;
    render();
  });
  document.getElementById("refreshBtn").addEventListener("click", async () => {
    const btn = document.getElementById("refreshBtn");
    if (btn.classList.contains("spinning")) return; // защита от повторных кликов
    btn.classList.add("spinning");
    try {
      state.data = await loadData(); setStatus(state.data); render();
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

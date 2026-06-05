/**
 * src/dates.js — local-date helpers (#112)
 *
 * Класс багов #111/#112: дата вычисляется в локальном времени,
 * а toISOString() конвертирует в UTC. При TZ=UTC+N и запуске до N:00
 * локальная дата съезжает на день назад — «понедельник» недели
 * становится воскресеньем (week_start=2026-05-24 при реальном 2026-05-25).
 *
 * Правило: для ЛОКАЛЬНЫХ календарных дат — только эти хелперы,
 * toISOString().slice(0,10) допустим только для UTC-семантики
 * (сравнение с datetime('now') в SQLite).
 */

/** Local calendar date as 'YYYY-MM-DD' (no UTC conversion — see #112). */
export function localYMD(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Monday of the week containing `now` (local time), as 'YYYY-MM-DD'. */
export function lastMondayLocal(now = new Date()) {
  const day = now.getDay(); // 0=Sun, 1=Mon … 6=Sat
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  return localYMD(monday);
}

const BARBERS = ["Sami", "Amine"];
// Set by the setup: the Cloudflare worker address that safely talks to Neon.
const WORKER_URL = "https://barbershop.ezalazil.workers.dev";
const EVENTS_KEY = "barbershop_events_v1";
const PENDING_KEY = "barbershop_pending_v1";

const state = {
  view: "home",
  tab: "register",
  selectedBarber: null,
  amount: "",
  weekOffset: 0,
  editingId: null,
  coupon: false,
  entryDate: null, // YYYY-MM-DD; null = today
  sync: "idle", // idle | syncing | offline
  events: loadCache(),
  pending: loadPending(),
  data: { entries: [], checkins: [], expenses: [], deleted: [] },
};

function loadCache() {
  try {
    const raw = localStorage.getItem(EVENTS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return [];
}
function saveCache() {
  localStorage.setItem(EVENTS_KEY, JSON.stringify(state.events));
}
function loadPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return [];
}
function savePending() {
  localStorage.setItem(PENDING_KEY, JSON.stringify(state.pending));
}

function rebuildData() {
  const d = { entries: [], checkins: [], expenses: [], deleted: [] };
  for (const e of state.events) {
    const time = Number(e.ts);
    if (e.deleted_at) {
      d.deleted.push({
        id: e.id,
        type: e.type,
        barber: e.barber,
        amount: e.amount,
        method: e.method,
        coupon: !!e.coupon,
        time,
        createdAt: e.created_at || null,
        deletedAt: e.deleted_at,
      });
      continue;
    }
    if (e.type === "entry")
      d.entries.push({
        id: e.id,
        barber: e.barber,
        amount: e.amount,
        method: e.method,
        coupon: !!e.coupon,
        time,
        createdAt: e.created_at || null,
      });
    else if (e.type === "expense")
      d.expenses.push({ id: e.id, amount: e.amount, time, createdAt: e.created_at || null });
    else if (e.type === "checkin")
      d.checkins.push({ id: e.id, barber: e.barber, time, createdAt: e.created_at || null });
  }
  state.data = d;
}

function localInsert(row) {
  state.events.push(row);
  saveCache();
  state.pending.push({ op: "insert", row });
  savePending();
  rebuildData();
}
function localUpdate(id, patch) {
  const ev = state.events.find((e) => e.id === id);
  if (ev) Object.assign(ev, patch);
  saveCache();
  state.pending.push({ op: "update", id, patch });
  savePending();
  rebuildData();
}
function localDelete(id) {
  const ev = state.events.find((e) => e.id === id);
  if (ev) ev.deleted_at = new Date().toISOString();
  saveCache();
  state.pending.push({ op: "delete", id });
  savePending();
  rebuildData();
}

async function postWorker(payload) {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("worker " + res.status);
  return res.json();
}

async function flushPending() {
  while (state.pending.length) {
    const job = state.pending[0];
    try {
      if (job.op === "insert") {
        await postWorker({ op: "insert", row: job.row });
      } else if (job.op === "update") {
        await postWorker({ op: "update", id: job.id, patch: job.patch });
      } else if (job.op === "delete") {
        await postWorker({ op: "delete", id: job.id });
      }
      state.pending.shift();
      savePending();
    } catch (err) {
      return false;
    }
  }
  return true;
}

async function fetchAll() {
  const res = await fetch(WORKER_URL, { method: "GET" });
  if (!res.ok) throw new Error("fetch " + res.status);
  const rows = await res.json();
  state.events = rows.map((r) => ({
    id: r.id,
    type: r.type,
    barber: r.barber,
    amount: r.amount == null ? null : Number(r.amount),
    method: r.method,
    ts: Number(r.ts),
    deleted_at: r.deleted_at || null,
    coupon: r.coupon === true || r.coupon === "t" || r.coupon === "true",
    created_at: r.created_at || null,
  }));
  saveCache();
  rebuildData();
}

let syncing = false;
async function syncNow() {
  if (syncing) return;
  syncing = true;
  setSync("syncing");
  try {
    const flushed = await flushPending();
    if (flushed === false) {
      setSync("offline");
      return;
    }
    await fetchAll();
    setSync("idle");
    if (!isMidEntry()) render();
  } catch (err) {
    setSync("offline");
  } finally {
    syncing = false;
  }
}

function isMidEntry() {
  return (
    state.tab === "register" &&
    (state.view === "amount" || state.view === "payment" || state.view === "expense-amount")
  );
}

function setSync(s) {
  state.sync = s;
  const badge = document.getElementById("sync-badge");
  if (badge) {
    badge.className = "sync-badge " + s;
    badge.textContent =
      s === "syncing" ? "Syncing…" : s === "offline" ? "Offline – will retry" : "Synced";
  }
}

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
function endOfWeek(date) {
  const d = startOfWeek(date);
  d.setDate(d.getDate() + 7);
  return d;
}
function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
function formatDay(ts) {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
}
function getCurrentWeekRange() {
  const now = new Date();
  now.setDate(now.getDate() + state.weekOffset * 7);
  return { start: startOfWeek(now).getTime(), end: endOfWeek(now).getTime() };
}
function getWeekLabel() {
  const { start, end } = getCurrentWeekRange();
  const endDisplay = new Date(end - 1);
  if (state.weekOffset === 0) return `This week (${formatDate(start)} - ${formatDate(endDisplay)})`;
  if (state.weekOffset === -1) return `Last week (${formatDate(start)} - ${formatDate(endDisplay)})`;
  return `${formatDate(start)} - ${formatDate(endDisplay)}`;
}
function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function tsFromEntryDate() {
  // If no entryDate, use right now. Otherwise use the chosen calendar day
  // with the current time of day, so the entry sits sensibly inside that day.
  if (!state.entryDate || state.entryDate === todayISO()) return Date.now();
  const [y, m, d] = state.entryDate.split("-").map(Number);
  const now = new Date();
  return new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds()).getTime();
}

function isBackdated(time, createdAt) {
  if (!createdAt) return false;
  const c = new Date(createdAt);
  return todayKey(c.getTime()) !== todayKey(time);
}
function checkinToday(barber) {
  return state.data.checkins.find(
    (c) => c.barber === barber && todayKey(c.time) === todayKey()
  );
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 1800);
}

function newId() {
  return Date.now() + "-" + Math.random().toString(36).slice(2, 7);
}

function buildWeeklyReport() {
  const { start, end } = getCurrentWeekRange();
  const entries = state.data.entries.filter((e) => e.time >= start && e.time < end);
  const expenses = state.data.expenses.filter((e) => e.time >= start && e.time < end);

  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const cash = (arr) => arr.filter((e) => e.method === "ESP");
  const card = (arr) => arr.filter((e) => e.method === "CB");

  const totals = {
    customers: entries.length,
    gross: sum(entries, (e) => e.amount),
    cash: sum(cash(entries), (e) => e.amount),
    card: sum(card(entries), (e) => e.amount),
    expensesTotal: sum(expenses, (e) => e.amount),
  };

  const days = [];
  for (let i = 0; i < 7; i++) {
    const dStart = start + i * 86400000;
    const dEnd = dStart + 86400000;
    const dE = entries.filter((e) => e.time >= dStart && e.time < dEnd);
    days.push({
      date: new Date(dStart),
      customers: dE.length,
      cash: sum(cash(dE), (e) => e.amount),
      card: sum(card(dE), (e) => e.amount),
      total: sum(dE, (e) => e.amount),
    });
  }

  const SPLIT = 0.5; // 50% barber / 50% house, same for both barbers
  const barbers = {};
  for (const b of BARBERS) {
    const bE = entries.filter((e) => e.barber === b);
    const gross = sum(bE, (e) => e.amount);
    barbers[b] = {
      customers: bE.length,
      gross,
      cash: sum(cash(bE), (e) => e.amount),
      card: sum(card(bE), (e) => e.amount),
      coupons: bE.filter((e) => e.coupon).length,
      share: gross * SPLIT,
    };
  }

  const houseGross = totals.gross * (1 - SPLIT);
  const houseNet = houseGross - totals.expensesTotal;

  return {
    startD: new Date(start),
    endD: new Date(end - 1),
    totals,
    days,
    barbers,
    houseGross,
    houseNet,
    split: SPLIT,
  };
}

function generateWeeklyPDF() {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast("PDF library not loaded — connect to internet and refresh");
    return;
  }
  const r = buildWeeklyReport();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210;
  const M = 15;
  const money = (n) => `${(Math.round(n * 100) / 100).toFixed(2)} €`;
  let y = M + 5;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text("Barbershop — Weekly Report", M, y);
  y += 8;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  const range = `${r.startD.toLocaleDateString(undefined, {
    day: "2-digit", month: "short", year: "numeric",
  })}  —  ${r.endD.toLocaleDateString(undefined, {
    day: "2-digit", month: "short", year: "numeric",
  })}`;
  doc.text(range, M, y);
  y += 10;

  // SUMMARY
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("Summary", M, y);
  y += 7;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  const sumRows = [
    ["Total customers", `${r.totals.customers}`],
    ["Gross revenue", money(r.totals.gross)],
    ["    Cash (ESP)", money(r.totals.cash)],
    ["    Card (CB)", money(r.totals.card)],
    ["Expenses (Dépenses)", `- ${money(r.totals.expensesTotal)}`],
    ["Net revenue", money(r.totals.gross - r.totals.expensesTotal)],
  ];
  for (const [k, v] of sumRows) {
    doc.text(k, M, y);
    doc.text(v, W - M, y, { align: "right" });
    y += 6;
  }
  y += 4;

  // PER DAY
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("Per day", M, y);
  y += 7;
  doc.setFontSize(10);
  const cols = { day: M, cust: M + 60, cash: M + 95, card: M + 130, total: M + 165 };
  doc.text("Day", cols.day, y);
  doc.text("Customers", cols.cust, y);
  doc.text("Cash", cols.cash, y);
  doc.text("Card", cols.card, y);
  doc.text("Total", cols.total, y);
  y += 1.5;
  doc.line(M, y, W - M, y);
  y += 4.5;
  doc.setFont("helvetica", "normal");
  for (const d of r.days) {
    const lbl = d.date.toLocaleDateString(undefined, {
      weekday: "short", day: "2-digit", month: "short",
    });
    doc.text(lbl, cols.day, y);
    doc.text(`${d.customers}`, cols.cust, y);
    doc.text(money(d.cash), cols.cash, y);
    doc.text(money(d.card), cols.card, y);
    doc.text(money(d.total), cols.total, y);
    y += 6;
  }
  y += 4;

  if (y > 230) { doc.addPage(); y = M; }

  // PER BARBER
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("Per barber", M, y);
  y += 7;
  doc.setFontSize(11);
  for (const b of BARBERS) {
    const s = r.barbers[b];
    doc.setFont("helvetica", "bold");
    doc.text(b, M, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    const rows = [
      ["Customers", `${s.customers}`],
      ["Gross revenue", money(s.gross)],
      ["    Cash", money(s.cash)],
      ["    Card", money(s.card)],
      ["Coupons used", `${s.coupons}`],
    ];
    for (const [k, v] of rows) {
      doc.text(k, M + 5, y);
      doc.text(v, W - M, y, { align: "right" });
      y += 5.5;
    }
    y += 3;
  }

  if (y > 230) { doc.addPage(); y = M; }

  // SPLIT
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(`Split (${Math.round(r.split * 100)}% barber / ${Math.round((1 - r.split) * 100)}% house)`, M, y);
  y += 7;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  for (const b of BARBERS) {
    const s = r.barbers[b];
    doc.text(`${b} keeps (${Math.round(r.split * 100)}% of ${money(s.gross)}):`, M, y);
    doc.text(money(s.share), W - M, y, { align: "right" });
    y += 6;
  }
  doc.line(M, y, W - M, y);
  y += 6;
  doc.setFont("helvetica", "bold");
  doc.text("House share (before expenses):", M, y);
  doc.text(money(r.houseGross), W - M, y, { align: "right" });
  y += 6;
  doc.setFont("helvetica", "normal");
  doc.text("Expenses (house absorbs):", M, y);
  doc.text(`- ${money(r.totals.expensesTotal)}`, W - M, y, { align: "right" });
  y += 6;
  doc.setFont("helvetica", "bold");
  doc.text("House net (yours):", M, y);
  doc.text(money(r.houseNet), W - M, y, { align: "right" });
  y += 12;

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(120);
  doc.text(
    `Generated ${new Date().toLocaleString()} · Barbershop App`,
    M,
    287
  );

  const fname = `Barbershop-Week-${r.startD.toISOString().slice(0, 10)}.pdf`;
  doc.save(fname);
  showToast("PDF saved: " + fname);
}

function render() {
  const root = document.getElementById("app");
  let html = `<header>
    <h1>Barbershop</h1>
    <button id="sync-badge" class="sync-badge ${state.sync}" data-action="sync">${
    state.sync === "syncing" ? "Syncing…" : state.sync === "offline" ? "Offline – will retry" : "Synced"
  }</button>
  </header>`;

  html += `<div class="tabs">
    <button class="tab ${state.tab === "register" ? "active" : ""}" data-tab="register">Register</button>
    <button class="tab ${state.tab === "checkin" ? "active" : ""}" data-tab="checkin">Check-In</button>
    <button class="tab ${state.tab === "stats" ? "active" : ""}" data-tab="stats">Stats</button>
  </div>`;

  if (state.tab === "register") html += renderRegister();
  else if (state.tab === "checkin") html += renderCheckin();
  else html += renderStats();

  root.innerHTML = html;
  attachHandlers();
}

function renderRegister() {
  if (state.view === "home") {
    return `<div class="screen">
      <h2>Who served the customer?</h2>
      <div class="barbers">
        <button class="barber-box sami" data-action="select-barber" data-barber="Sami">Sami</button>
        <button class="barber-box amine" data-action="select-barber" data-barber="Amine">Amine</button>
      </div>
      <button class="depense-btn" data-action="start-expense">Dépense</button>
    </div>`;
  }

  if (state.view === "expense-amount") {
    const display = state.amount ? state.amount : "0";
    const empty = state.amount ? "" : "empty";
    const editing = state.editingId ? " (editing)" : "";
    const curDate = state.entryDate || todayISO();
    const backDated = curDate !== todayISO();
    return `<div class="screen">
      <button class="back-btn" data-action="back-home">&larr; ${state.editingId ? "Cancel" : "Back"}</button>
      <h2>Dépense — Amount?${editing}</h2>
      ${state.editingId ? "" : `<div class="date-row ${backDated ? "backdated" : ""}">
        <label for="entry-date-input">Date</label>
        <input id="entry-date-input" class="date-input" type="date" value="${curDate}" max="${todayISO()}" min="${isoDaysAgo(60)}">
      </div>`}
      <div class="amount-display ${empty}">${display}<span class="currency">€</span></div>
      <div class="keypad">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="key" data-action="key" data-key="${n}">${n}</button>`).join("")}
        <button class="key del" data-action="key" data-key="del">⌫</button>
        <button class="key" data-action="key" data-key="0">0</button>
        <button class="key ok" data-action="confirm-expense">OK</button>
      </div>
    </div>`;
  }

  if (state.view === "amount") {
    const empty = state.amount ? "" : "empty";
    const editing = state.editingId ? " (editing)" : "";
    const isEdit = !!state.editingId;
    const raw = parseInt(state.amount || "0", 10);
    const finalAmt = !isEdit && state.coupon ? Math.round(raw * 0.8) : raw;
    const amountInner =
      !isEdit && state.coupon && raw > 0
        ? `<span class="struck">${raw}</span> ${finalAmt}<span class="currency">€</span>`
        : `${state.amount ? state.amount : "0"}<span class="currency">€</span>`;
    const curDate = state.entryDate || todayISO();
    const backDated = curDate !== todayISO();
    return `<div class="screen">
      <button class="back-btn" data-action="back-home">&larr; ${state.editingId ? "Cancel" : "Back"}</button>
      <h2>${state.selectedBarber} — Amount?${editing}</h2>
      ${isEdit ? "" : `<div class="date-row ${backDated ? "backdated" : ""}">
        <label for="entry-date-input">Date</label>
        <input id="entry-date-input" class="date-input" type="date" value="${curDate}" max="${todayISO()}" min="${isoDaysAgo(60)}">
      </div>`}
      <div class="amount-display ${empty}">${amountInner}</div>
      <button class="coupon-btn ${state.coupon ? "on" : ""}" data-action="toggle-coupon">
        ${state.coupon ? "✓ Coupon −20% applied" : "Coupon −20%"}
      </button>
      <div class="keypad">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="key" data-action="key" data-key="${n}">${n}</button>`).join("")}
        <button class="key del" data-action="key" data-key="del">⌫</button>
        <button class="key" data-action="key" data-key="0">0</button>
        <button class="key ok" data-action="confirm-amount">OK</button>
      </div>
    </div>`;
  }

  if (state.view === "payment") {
    const editing = state.editingId ? " (editing)" : "";
    const isEdit = !!state.editingId;
    const raw = parseInt(state.amount || "0", 10);
    const finalAmt = !isEdit && state.coupon ? Math.round(raw * 0.8) : raw;
    const couponNote = state.coupon ? ` (coupon −20%)` : "";
    return `<div class="screen">
      <button class="back-btn" data-action="back-amount">&larr; Back</button>
      <h2>${state.selectedBarber} — ${finalAmt}€${couponNote} — Payment?${editing}</h2>
      <div class="payment">
        <button class="pay-box esp" data-action="pay" data-method="ESP">
          ESP<span class="label">Cash</span>
        </button>
        <button class="pay-box cb" data-action="pay" data-method="CB">
          CB<span class="label">Card</span>
        </button>
      </div>
    </div>`;
  }
  return "";
}

function renderCheckin() {
  let html = `<div class="screen"><h2>Check in when you arrive</h2>`;
  for (const b of BARBERS) {
    const ci = checkinToday(b);
    if (ci) {
      html += `<div class="checkin-status checked-in">
        <div class="name">${b}</div>
        <div class="time">Checked in at ${formatTime(ci.time)}</div>
      </div>`;
    } else {
      html += `<div class="checkin-status not-checked-in">
        <div class="name">${b}</div>
        <div class="time">Not checked in today</div>
        <button class="btn-secondary" style="margin-top:10px" data-action="checkin" data-barber="${b}">Check In</button>
      </div>`;
    }
  }

  const recent = [...state.data.checkins].sort((a, b) => b.time - a.time).slice(0, 10);
  if (recent.length) {
    html += `<div class="history" style="margin-top:16px"><h3>Recent check-ins</h3>`;
    for (const c of recent) {
      html += `<div class="entry">
        <div><span class="who">${c.barber}</span> <span class="meta">${formatDay(c.time)}</span></div>
        <div class="amt">${formatTime(c.time)}</div>
      </div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function renderStats() {
  const { start, end } = getCurrentWeekRange();
  const weekEntries = state.data.entries.filter((e) => e.time >= start && e.time < end);
  const weekExpenses = state.data.expenses.filter((e) => e.time >= start && e.time < end);
  const expensesTotal = weekExpenses.reduce((s, e) => s + e.amount, 0);

  const stats = {};
  for (const b of BARBERS) {
    stats[b] = { count: 0, esp: 0, cb: 0, total: 0, coupons: 0 };
  }
  for (const e of weekEntries) {
    if (!stats[e.barber]) continue;
    stats[e.barber].count++;
    stats[e.barber].total += e.amount;
    if (e.coupon) stats[e.barber].coupons++;
    if (e.method === "ESP") stats[e.barber].esp += e.amount;
    else stats[e.barber].cb += e.amount;
  }

  let html = `<div class="screen">
    <div class="week-nav">
      <button data-action="week-prev">&larr; Prev</button>
      <div class="week-label">${getWeekLabel()}</div>
      <button data-action="week-next" ${state.weekOffset >= 0 ? "disabled style='opacity:0.4'" : ""}>Next &rarr;</button>
    </div>
    <button class="pdf-btn" data-action="download-pdf">📄 Download weekly PDF report</button>
    <div class="summary">`;

  for (const b of BARBERS) {
    const s = stats[b];
    html += `<div class="stat-card">
      <h3>${b}</h3>
      <div class="row"><span class="label">Customers</span><span class="value">${s.count}</span></div>
      <div class="row"><span class="label">Cash (ESP)</span><span class="value">${s.esp}€</span></div>
      <div class="row"><span class="label">Card (CB)</span><span class="value">${s.cb}€</span></div>
      <div class="row"><span class="label">Coupons</span><span class="value">${s.coupons}</span></div>
      <div class="row total"><span class="label">Total</span><span class="value">${s.total}€</span></div>
    </div>`;
  }
  html += `</div>`;

  html += `<div class="stat-card" style="margin-bottom:12px">
    <h3>Dépenses</h3>
    <div class="row"><span class="label">Count</span><span class="value">${weekExpenses.length}</span></div>
    <div class="row total"><span class="label">Total</span><span class="value">-${expensesTotal}€</span></div>
  </div>`;

  const merged = [
    ...weekEntries.map((e) => ({ ...e, kind: "entry" })),
    ...weekExpenses.map((e) => ({ ...e, kind: "expense" })),
  ].sort((a, b) => b.time - a.time);

  html += `<div class="history"><h3>This week's activity (${merged.length})</h3>`;
  if (merged.length === 0) {
    html += `<div style="text-align:center;color:#64748b;padding:20px">No entries yet</div>`;
  } else {
    for (const e of merged) {
      const back = isBackdated(e.time, e.createdAt);
      const backTag = back
        ? `<div class="meta added-later">added ${formatDay(new Date(e.createdAt).getTime())} ${formatTime(new Date(e.createdAt).getTime())}</div>`
        : "";
      if (e.kind === "expense") {
        html += `<div class="entry expense-entry ${back ? "is-backdated" : ""}">
          <div>
            <span class="who">Dépense</span>
            <span class="meta">${formatDay(e.time)} ${formatTime(e.time)}</span>
            ${backTag}
          </div>
          <div>
            <span class="amt expense-amt">-${e.amount}€</span>
            <button class="edit-btn" data-action="edit-entry" data-kind="expense" data-id="${e.id}" title="Edit">✎</button>
            <button class="del-btn" data-action="delete-entry" data-kind="expense" data-id="${e.id}" title="Delete">×</button>
          </div>
        </div>`;
      } else {
        html += `<div class="entry ${back ? "is-backdated" : ""}">
          <div>
            <span class="who">${e.barber}</span>
            <span class="meta">${formatDay(e.time)} ${formatTime(e.time)}</span>
            ${backTag}
          </div>
          <div>
            <span class="amt">${e.amount}€</span>
            ${e.coupon ? `<span class="coupon-tag">−20%</span>` : ""}
            <span class="pay ${e.method}">${e.method}</span>
            <button class="edit-btn" data-action="edit-entry" data-id="${e.id}" title="Edit">✎</button>
            <button class="del-btn" data-action="delete-entry" data-id="${e.id}" title="Delete">×</button>
          </div>
        </div>`;
      }
    }
  }
  html += `</div>`;

  const weekDeleted = state.data.deleted
    .filter((e) => e.time >= start && e.time < end)
    .sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
  if (weekDeleted.length) {
    html += `<div class="history deleted-history"><h3>Deleted this week (${weekDeleted.length}) — trace only</h3>`;
    for (const e of weekDeleted) {
      const label = e.type === "expense" ? "Dépense" : e.barber || e.type;
      const amt =
        e.type === "expense"
          ? `-${e.amount}€`
          : e.amount != null
          ? `${e.amount}€`
          : "";
      const pay =
        e.type === "entry" && e.method
          ? `<span class="pay ${e.method}">${e.method}</span>`
          : "";
      const cpn = e.coupon ? `<span class="coupon-tag">−20%</span>` : "";
      const delTs = new Date(e.deletedAt).getTime();
      html += `<div class="entry deleted-entry">
        <div>
          <span class="who">${label}</span>
          <span class="meta">${formatDay(e.time)} ${formatTime(e.time)}</span>
          <div class="meta removed">removed ${formatDay(delTs)} ${formatTime(delTs)}</div>
        </div>
        <div><span class="amt">${amt}</span> ${cpn} ${pay}</div>
      </div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function attachHandlers() {
  document.querySelectorAll("[data-tab]").forEach((el) => {
    el.addEventListener("click", () => {
      state.tab = el.dataset.tab;
      state.view = "home";
      state.selectedBarber = null;
      state.amount = "";
      state.editingId = null;
      state.coupon = false;
      state.entryDate = null;
      render();
      if (state.tab === "stats" || state.tab === "checkin") syncNow();
    });
  });

  document.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", (e) => handleAction(el.dataset.action, el.dataset, e));
  });

  const dateInput = document.getElementById("entry-date-input");
  if (dateInput) {
    dateInput.addEventListener("change", () => {
      const v = dateInput.value;
      state.entryDate = v && v !== todayISO() ? v : null;
      render();
    });
  }
}

function handleAction(action, data) {
  switch (action) {
    case "sync":
      syncNow();
      break;
    case "download-pdf":
      generateWeeklyPDF();
      break;
    case "select-barber":
      state.selectedBarber = data.barber;
      state.amount = "";
      state.coupon = false;
      state.entryDate = null;
      state.view = "amount";
      render();
      break;
    case "toggle-coupon":
      state.coupon = !state.coupon;
      render();
      break;
    case "start-expense":
      state.amount = "";
      state.entryDate = null;
      state.view = "expense-amount";
      render();
      break;
    case "confirm-expense": {
      const amt = parseInt(state.amount, 10);
      if (!amt || amt <= 0) return;
      if (state.editingId) {
        localUpdate(state.editingId, { amount: amt });
        showToast(`Expense updated: ${amt}€`);
        state.editingId = null;
        state.tab = "stats";
      } else {
        const ts = tsFromEntryDate();
        localInsert({ id: newId(), type: "expense", amount: amt, ts });
        showToast(`Expense saved: ${amt}€${state.entryDate ? " (backdated)" : ""}`);
      }
      state.view = "home";
      state.amount = "";
      state.entryDate = null;
      render();
      syncNow();
      break;
    }
    case "back-home":
      if (state.editingId) {
        state.editingId = null;
        state.tab = "stats";
      }
      state.view = "home";
      state.selectedBarber = null;
      state.amount = "";
      state.coupon = false;
      state.entryDate = null;
      render();
      break;
    case "back-amount":
      state.view = "amount";
      render();
      break;
    case "key":
      if (data.key === "del") {
        state.amount = state.amount.slice(0, -1);
      } else if (state.amount.length < 5) {
        if (state.amount === "0") state.amount = data.key;
        else state.amount += data.key;
      }
      render();
      break;
    case "confirm-amount":
      if (state.amount && parseInt(state.amount, 10) > 0) {
        state.view = "payment";
        render();
      }
      break;
    case "pay": {
      const rawAmt = parseInt(state.amount, 10);
      if (state.editingId) {
        localUpdate(state.editingId, {
          amount: rawAmt,
          method: data.method,
          coupon: state.coupon,
        });
        showToast(`Updated: ${rawAmt}€ ${data.method}`);
        state.editingId = null;
        state.tab = "stats";
      } else {
        const finalAmt = state.coupon ? Math.round(rawAmt * 0.8) : rawAmt;
        const ts = tsFromEntryDate();
        localInsert({
          id: newId(),
          type: "entry",
          barber: state.selectedBarber,
          amount: finalAmt,
          method: data.method,
          ts,
          coupon: state.coupon,
        });
        showToast(
          `Saved: ${state.selectedBarber} ${finalAmt}€ ${data.method}${
            state.coupon ? " (−20%)" : ""
          }${state.entryDate ? " (backdated)" : ""}`
        );
      }
      state.view = "home";
      state.selectedBarber = null;
      state.amount = "";
      state.coupon = false;
      state.entryDate = null;
      render();
      syncNow();
      break;
    }
    case "checkin": {
      if (checkinToday(data.barber)) return;
      localInsert({ id: newId(), type: "checkin", barber: data.barber, ts: Date.now() });
      showToast(`${data.barber} checked in at ${formatTime(Date.now())}`);
      render();
      syncNow();
      break;
    }
    case "week-prev":
      state.weekOffset--;
      render();
      break;
    case "week-next":
      if (state.weekOffset < 0) {
        state.weekOffset++;
        render();
      }
      break;
    case "delete-entry":
      if (confirm("Delete this entry?")) {
        localDelete(data.id);
        render();
        syncNow();
      }
      break;
    case "edit-entry": {
      if (data.kind === "expense") {
        const exp = state.data.expenses.find((e) => e.id === data.id);
        if (!exp) return;
        state.editingId = exp.id;
        state.amount = String(exp.amount);
        state.tab = "register";
        state.view = "expense-amount";
        render();
        return;
      }
      const entry = state.data.entries.find((e) => e.id === data.id);
      if (!entry) return;
      state.editingId = entry.id;
      state.selectedBarber = entry.barber;
      state.amount = String(entry.amount);
      state.coupon = !!entry.coupon;
      state.tab = "register";
      state.view = "amount";
      render();
      break;
    }
  }
}

rebuildData();
render();
syncNow();
setInterval(syncNow, 20000);
window.addEventListener("online", syncNow);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) syncNow();
});

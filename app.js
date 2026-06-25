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
  analytics: { period: "week", scope: "all", offset: 0 },
  sync: "idle", // idle | syncing | offline
  events: loadCache(),
  pending: loadPending(),
  data: { entries: [], checkins: [], expenses: [], deleted: [], acomptes: [], products: [] },
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
  const d = { entries: [], checkins: [], expenses: [], deleted: [], acomptes: [], products: [] };
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
    else if (e.type === "acompte")
      d.acomptes.push({ id: e.id, barber: e.barber, amount: e.amount, time, createdAt: e.created_at || null });
    else if (e.type === "product")
      d.products.push({ id: e.id, barber: e.barber, amount: e.amount, time, createdAt: e.created_at || null });
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
  const acomptes = state.data.acomptes.filter((e) => e.time >= start && e.time < end);
  const products = state.data.products.filter((e) => e.time >= start && e.time < end);

  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const cash = (arr) => arr.filter((e) => e.method === "ESP");
  const card = (arr) => arr.filter((e) => e.method === "CB");

  const haircutGross = sum(entries, (e) => e.amount);
  const productsTotal = sum(products, (e) => e.amount);
  const totals = {
    customers: entries.length,
    haircutGross,
    productsTotal,
    productsCount: products.length,
    gross: haircutGross + productsTotal,
    cash: sum(cash(entries), (e) => e.amount),
    card: sum(card(entries), (e) => e.amount),
    expensesTotal: sum(expenses, (e) => e.amount),
    acomptesTotal: sum(acomptes, (e) => e.amount),
  };

  const days = [];
  for (let i = 0; i < 7; i++) {
    const dStart = start + i * 86400000;
    const dEnd = dStart + 86400000;
    const dE = entries.filter((e) => e.time >= dStart && e.time < dEnd);
    const dP = products.filter((e) => e.time >= dStart && e.time < dEnd);
    const dPTotal = sum(dP, (e) => e.amount);
    days.push({
      date: new Date(dStart),
      customers: dE.length,
      cash: sum(cash(dE), (e) => e.amount),
      card: sum(card(dE), (e) => e.amount),
      products: dPTotal,
      total: sum(dE, (e) => e.amount) + dPTotal,
    });
  }

  const SPLIT = 0.5; // 50% barber / 50% house, same for both barbers
  const barbers = {};
  for (const b of BARBERS) {
    const bE = entries.filter((e) => e.barber === b);
    const bA = acomptes.filter((e) => e.barber === b);
    const bP = products.filter((e) => e.barber === b);
    const haircutGrossB = sum(bE, (e) => e.amount);
    const productsB = sum(bP, (e) => e.amount);
    const gross = haircutGrossB + productsB;
    const acompteTotal = sum(bA, (e) => e.amount);
    const shareGross = gross * SPLIT;
    barbers[b] = {
      customers: bE.length,
      haircutGross: haircutGrossB,
      products: productsB,
      productCount: bP.length,
      gross,
      cash: sum(cash(bE), (e) => e.amount),
      card: sum(card(bE), (e) => e.amount),
      coupons: bE.filter((e) => e.coupon).length,
      acomptes: acompteTotal,
      shareGross,
      shareNet: shareGross - acompteTotal,
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
    ["Total customers (haircuts)", `${r.totals.customers}`],
    ["Haircut revenue", money(r.totals.haircutGross)],
    ["    Cash (ESP)", money(r.totals.cash)],
    ["    Card (CB)", money(r.totals.card)],
    ["Products sold", `${r.totals.productsCount}  (${money(r.totals.productsTotal)})`],
    ["Gross revenue (haircuts + products)", money(r.totals.gross)],
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
      ["Haircut revenue", money(s.haircutGross)],
      ["    Cash", money(s.cash)],
      ["    Card", money(s.card)],
      ["Products sold", `${s.productCount}  (${money(s.products)})`],
      ["Gross revenue (haircuts + products)", money(s.gross)],
      ["Coupons used", `${s.coupons}`],
      ["Acomptes (advances) taken", `- ${money(s.acomptes)}`],
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
    doc.text(`${b} share (${Math.round(r.split * 100)}% of ${money(s.gross)}):`, M, y);
    doc.text(money(s.shareGross), W - M, y, { align: "right" });
    y += 5.5;
    doc.text(`    Less Acomptes taken:`, M, y);
    doc.text(`- ${money(s.acomptes)}`, W - M, y, { align: "right" });
    y += 5.5;
    doc.setFont("helvetica", "bold");
    doc.text(`    End-of-week payout to ${b}:`, M, y);
    doc.text(money(s.shareNet), W - M, y, { align: "right" });
    doc.setFont("helvetica", "normal");
    y += 7;
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
    <h1>LX Barbershop</h1>
    <button id="sync-badge" class="sync-badge ${state.sync}" data-action="sync">${
    state.sync === "syncing" ? "Syncing…" : state.sync === "offline" ? "Offline – will retry" : "Synced"
  }</button>
  </header>`;

  html += `<div class="tabs">
    <button class="tab ${state.tab === "register" ? "active" : ""}" data-tab="register">Register</button>
    <button class="tab ${state.tab === "checkin" ? "active" : ""}" data-tab="checkin">Check-In</button>
    <button class="tab ${state.tab === "stats" ? "active" : ""}" data-tab="stats">Stats</button>
    <button class="tab ${state.tab === "analytics" ? "active" : ""}" data-tab="analytics">Analytics</button>
  </div>`;

  if (state.tab === "register") html += renderRegister();
  else if (state.tab === "checkin") html += renderCheckin();
  else if (state.tab === "stats") html += renderStats();
  else if (state.tab === "analytics") html += renderAnalytics();

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
      <div class="secondary-actions">
        <button class="depense-btn" data-action="start-expense">Dépense</button>
        <button class="acompte-btn" data-action="start-acompte">Acompte</button>
        <button class="product-btn" data-action="start-product">Product</button>
      </div>
    </div>`;
  }

  if (state.view === "product-barber") {
    return `<div class="screen">
      <button class="back-btn" data-action="back-home">&larr; Back</button>
      <h2>Product sold — by who?</h2>
      <div class="barbers">
        <button class="barber-box sami" data-action="select-product-barber" data-barber="Sami">Sami</button>
        <button class="barber-box amine" data-action="select-product-barber" data-barber="Amine">Amine</button>
      </div>
    </div>`;
  }

  if (state.view === "product-amount") {
    const display = state.amount ? state.amount : "0";
    const empty = state.amount ? "" : "empty";
    const editing = state.editingId ? " (editing)" : "";
    const curDate = state.entryDate || todayISO();
    const backDated = curDate !== todayISO();
    return `<div class="screen">
      <button class="back-btn" data-action="back-home">&larr; ${state.editingId ? "Cancel" : "Back"}</button>
      <h2>${state.selectedBarber} — Product amount?${editing}</h2>
      ${state.editingId ? "" : `<div class="date-row ${backDated ? "backdated" : ""}">
        <label for="entry-date-input">Date</label>
        <input id="entry-date-input" class="date-input" type="date" value="${curDate}" max="${todayISO()}" min="${isoDaysAgo(60)}">
      </div>`}
      <div class="amount-display ${empty}">${display}<span class="currency">€</span></div>
      <div class="keypad">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="key" data-action="key" data-key="${n}">${n}</button>`).join("")}
        <button class="key del" data-action="key" data-key="del">⌫</button>
        <button class="key" data-action="key" data-key="0">0</button>
        <button class="key ok" data-action="confirm-product">OK</button>
      </div>
    </div>`;
  }

  if (state.view === "acompte-barber") {
    return `<div class="screen">
      <button class="back-btn" data-action="back-home">&larr; Back</button>
      <h2>Acompte — Who's taking it?</h2>
      <div class="barbers">
        <button class="barber-box sami" data-action="select-acompte-barber" data-barber="Sami">Sami</button>
        <button class="barber-box amine" data-action="select-acompte-barber" data-barber="Amine">Amine</button>
      </div>
    </div>`;
  }

  if (state.view === "acompte-amount") {
    const display = state.amount ? state.amount : "0";
    const empty = state.amount ? "" : "empty";
    const editing = state.editingId ? " (editing)" : "";
    const curDate = state.entryDate || todayISO();
    const backDated = curDate !== todayISO();
    return `<div class="screen">
      <button class="back-btn" data-action="back-home">&larr; ${state.editingId ? "Cancel" : "Back"}</button>
      <h2>${state.selectedBarber} — Acompte amount?${editing}</h2>
      ${state.editingId ? "" : `<div class="date-row ${backDated ? "backdated" : ""}">
        <label for="entry-date-input">Date</label>
        <input id="entry-date-input" class="date-input" type="date" value="${curDate}" max="${todayISO()}" min="${isoDaysAgo(60)}">
      </div>`}
      <div class="amount-display ${empty}">${display}<span class="currency">€</span></div>
      <div class="keypad">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="key" data-action="key" data-key="${n}">${n}</button>`).join("")}
        <button class="key del" data-action="key" data-key="del">⌫</button>
        <button class="key" data-action="key" data-key="0">0</button>
        <button class="key ok" data-action="confirm-acompte">OK</button>
      </div>
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

  const weekAcomptes = state.data.acomptes.filter((e) => e.time >= start && e.time < end);
  const weekProducts = state.data.products.filter((e) => e.time >= start && e.time < end);

  const stats = {};
  for (const b of BARBERS) {
    stats[b] = { count: 0, esp: 0, cb: 0, total: 0, coupons: 0, acomptes: 0, products: 0 };
  }
  for (const e of weekEntries) {
    if (!stats[e.barber]) continue;
    stats[e.barber].count++;
    stats[e.barber].total += e.amount;
    if (e.coupon) stats[e.barber].coupons++;
    if (e.method === "ESP") stats[e.barber].esp += e.amount;
    else stats[e.barber].cb += e.amount;
  }
  for (const a of weekAcomptes) {
    if (stats[a.barber]) stats[a.barber].acomptes += a.amount;
  }
  for (const p of weekProducts) {
    if (stats[p.barber]) {
      stats[p.barber].products += p.amount;
      stats[p.barber].total += p.amount;
    }
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
      <div class="row"><span class="label">Products</span><span class="value product-val">+${s.products}€</span></div>
      <div class="row total"><span class="label">Total</span><span class="value">${s.total}€</span></div>
      <div class="row"><span class="label">Acomptes</span><span class="value acompte-val">-${s.acomptes}€</span></div>
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
    ...weekAcomptes.map((e) => ({ ...e, kind: "acompte" })),
    ...weekProducts.map((e) => ({ ...e, kind: "product" })),
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
      } else if (e.kind === "acompte") {
        html += `<div class="entry acompte-entry ${back ? "is-backdated" : ""}">
          <div>
            <span class="who">${e.barber} — Acompte</span>
            <span class="meta">${formatDay(e.time)} ${formatTime(e.time)}</span>
            ${backTag}
          </div>
          <div>
            <span class="amt acompte-amt">-${e.amount}€</span>
            <button class="edit-btn" data-action="edit-entry" data-kind="acompte" data-id="${e.id}" title="Edit">✎</button>
            <button class="del-btn" data-action="delete-entry" data-kind="acompte" data-id="${e.id}" title="Delete">×</button>
          </div>
        </div>`;
      } else if (e.kind === "product") {
        html += `<div class="entry product-entry ${back ? "is-backdated" : ""}">
          <div>
            <span class="who">${e.barber} — Product</span>
            <span class="meta">${formatDay(e.time)} ${formatTime(e.time)}</span>
            ${backTag}
          </div>
          <div>
            <span class="amt product-amt">${e.amount}€</span>
            <button class="edit-btn" data-action="edit-entry" data-kind="product" data-id="${e.id}" title="Edit">✎</button>
            <button class="del-btn" data-action="delete-entry" data-kind="product" data-id="${e.id}" title="Delete">×</button>
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
      const label =
        e.type === "expense"
          ? "Dépense"
          : e.type === "acompte"
          ? `${e.barber} — Acompte`
          : e.type === "product"
          ? `${e.barber} — Product`
          : e.barber || e.type;
      const amt =
        e.type === "expense" || e.type === "acompte"
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

function getAnalyticsRange() {
  const { period, offset } = state.analytics;
  if (period === "all") {
    return { start: 0, end: Date.now() + 1, label: "All time", days: 1, canNav: false };
  }
  if (period === "week") {
    const now = new Date();
    now.setDate(now.getDate() + offset * 7);
    const start = startOfWeek(now).getTime();
    const end = endOfWeek(now).getTime();
    const endDisp = new Date(end - 1);
    const label =
      offset === 0
        ? `This week (${formatDate(start)} – ${formatDate(endDisp)})`
        : offset === -1
        ? `Last week (${formatDate(start)} – ${formatDate(endDisp)})`
        : `${formatDate(start)} – ${formatDate(endDisp)}`;
    return { start, end, label, days: 7, canNav: true };
  }
  // month
  const now = new Date();
  now.setMonth(now.getMonth() + offset);
  const s = new Date(now.getFullYear(), now.getMonth(), 1);
  const e = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const start = s.getTime();
  const end = e.getTime();
  const days = Math.round((end - start) / 86400000);
  const label =
    offset === 0
      ? `This month (${s.toLocaleDateString(undefined, { month: "long", year: "numeric" })})`
      : s.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return { start, end, label, days, canNav: true };
}

function buildHistoricalInsights() {
  const all = [...state.data.entries, ...state.data.products];
  if (all.length === 0) return null;

  // --- Week-of-month average ---
  const wmBuckets = new Map(); // "YYYY-MM-WM" -> total
  for (const e of all) {
    const d = new Date(e.time);
    const wm = Math.ceil(d.getDate() / 7); // 1..5
    const key = `${d.getFullYear()}-${d.getMonth()}-${wm}`;
    wmBuckets.set(key, (wmBuckets.get(key) || 0) + e.amount);
  }
  const wmAgg = [0, 0, 0, 0, 0, 0].map(() => ({ total: 0, count: 0 }));
  for (const [k, total] of wmBuckets) {
    const wm = parseInt(k.split("-")[2], 10);
    if (wm >= 1 && wm <= 5) {
      wmAgg[wm].total += total;
      wmAgg[wm].count += 1;
    }
  }
  const wmAvg = wmAgg
    .map((b, wm) => ({ wm, avg: b.count ? b.total / b.count : 0, count: b.count }))
    .filter((x) => x.wm >= 1 && x.count > 0);
  const bestWm = wmAvg.length ? wmAvg.reduce((a, b) => (a.avg > b.avg ? a : b)) : null;

  // --- Weekday averages (per active day of that weekday) ---
  const wdNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const wdTotal = [0, 0, 0, 0, 0, 0, 0];
  const wdActive = wdNames.map(() => new Set());
  for (const e of all) {
    const d = new Date(e.time);
    wdTotal[d.getDay()] += e.amount;
    wdActive[d.getDay()].add(todayKey(e.time));
  }
  const wdAvg = wdTotal
    .map((total, i) => ({
      name: wdNames[i],
      total,
      active: wdActive[i].size,
      avg: wdActive[i].size ? total / wdActive[i].size : 0,
    }))
    .filter((x) => x.active > 0);
  const sortedWd = [...wdAvg].sort((a, b) => b.avg - a.avg);
  const bestDays = sortedWd.slice(0, 2);
  const bestNames = new Set(bestDays.map((d) => d.name));
  const slowDays =
    sortedWd.length > 2
      ? [...sortedWd].sort((a, b) => a.avg - b.avg).filter((d) => !bestNames.has(d.name)).slice(0, 2)
      : [];

  // --- Highest single day on record ---
  const dayMap = new Map();
  for (const e of all) {
    const k = todayKey(e.time);
    dayMap.set(k, (dayMap.get(k) || 0) + e.amount);
  }
  let bestDay = null;
  for (const [k, total] of dayMap) {
    if (!bestDay || total > bestDay.total) bestDay = { date: k, total };
  }

  return { bestWm, wmAvg, bestDays, slowDays, bestDay, totalDaysOnRecord: dayMap.size };
}

function computeBucket(start, end, barberFilter) {
  const sel = (e) => e.time >= start && e.time < end && (barberFilter ? e.barber === barberFilter : true);
  const entries = state.data.entries.filter(sel);
  const acomptes = state.data.acomptes.filter(sel);
  const products = state.data.products.filter(sel);
  const cash = entries.filter((e) => e.method === "ESP");
  const card = entries.filter((e) => e.method === "CB");
  const haircutRevenue = entries.reduce((s, e) => s + e.amount, 0);
  const productsTotal = products.reduce((s, e) => s + e.amount, 0);
  const revenue = haircutRevenue + productsTotal;
  const cashTotal = cash.reduce((s, e) => s + e.amount, 0);
  const cardTotal = card.reduce((s, e) => s + e.amount, 0);
  const coupons = entries.filter((e) => e.coupon).length;
  const acompteTotal = acomptes.reduce((s, e) => s + e.amount, 0);
  const dayKeys = new Set(
    [...entries, ...products].map((e) => todayKey(e.time))
  );
  return {
    customers: entries.length,
    revenue,
    haircutRevenue,
    products: productsTotal,
    productCount: products.length,
    cash: cashTotal,
    card: cardTotal,
    coupons,
    acomptes: acompteTotal,
    avgPerCustomer: entries.length ? haircutRevenue / entries.length : 0,
    activeDays: dayKeys.size,
  };
}

function fmtEuro(n) {
  return `${(Math.round(n * 100) / 100).toFixed(2)} €`;
}
function fmtEuroInt(n) {
  return `${Math.round(n)} €`;
}
function fmtPct(now, prev) {
  if (!prev) return now ? "—" : "0%";
  const p = ((now - prev) / prev) * 100;
  const sign = p >= 0 ? "+" : "";
  return `${sign}${p.toFixed(0)}%`;
}

function renderAnalytics() {
  const { period, scope, offset } = state.analytics;
  const range = getAnalyticsRange();
  const barberFilter = scope === "all" ? null : scope;
  const expensesAll = state.data.expenses.filter(
    (e) => e.time >= range.start && e.time < range.end
  );
  const expensesTotal = expensesAll.reduce((s, e) => s + e.amount, 0);

  const cur = computeBucket(range.start, range.end, barberFilter);

  // Previous-period bucket
  let prev = null;
  if (period !== "all") {
    const prevRange =
      period === "week"
        ? { start: range.start - 7 * 86400000, end: range.start }
        : (() => {
            const s = new Date(range.start);
            const ps = new Date(s.getFullYear(), s.getMonth() - 1, 1);
            const pe = new Date(s.getFullYear(), s.getMonth(), 1);
            return { start: ps.getTime(), end: pe.getTime() };
          })();
    prev = computeBucket(prevRange.start, prevRange.end, barberFilter);
  }

  // Period progress and projection
  const isCurrentPeriod = offset === 0 && period !== "all";
  const nowMs = Math.min(Date.now(), range.end - 1);
  const elapsedMs = Math.max(0, nowMs - range.start);
  const totalMs = range.end - range.start;
  const elapsedDays = Math.max(
    1,
    Math.min(range.days, Math.ceil(elapsedMs / 86400000))
  );
  const totalDays = range.days;
  const progressPct = period === "all" ? 100 : Math.round((elapsedMs / totalMs) * 100);

  const canProject =
    isCurrentPeriod && elapsedDays < totalDays && cur.revenue > 0;
  const linearProj = canProject ? (cur.revenue / elapsedDays) * totalDays : null;
  const projVsPrev =
    canProject && prev && prev.revenue
      ? ((linearProj - prev.revenue) / prev.revenue) * 100
      : null;

  // Weekday + hour patterns
  const periodEntries = state.data.entries.filter(
    (e) => e.time >= range.start && e.time < range.end && (!barberFilter || e.barber === barberFilter)
  );
  const periodProducts = state.data.products.filter(
    (e) => e.time >= range.start && e.time < range.end && (!barberFilter || e.barber === barberFilter)
  );
  const wdNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const wdRev = [0, 0, 0, 0, 0, 0, 0];
  const wdCount = [0, 0, 0, 0, 0, 0, 0];
  const wdActiveDays = [new Set(), new Set(), new Set(), new Set(), new Set(), new Set(), new Set()];
  for (const e of periodEntries) {
    const d = new Date(e.time);
    wdRev[d.getDay()] += e.amount;
    wdCount[d.getDay()]++;
    wdActiveDays[d.getDay()].add(todayKey(e.time));
  }
  for (const p of periodProducts) {
    const d = new Date(p.time);
    wdRev[d.getDay()] += p.amount;
  }
  const bestWdIdx = wdRev.indexOf(Math.max(...wdRev));
  const bestWdHasData = wdRev[bestWdIdx] > 0;
  const bestWdActiveCount = Math.max(1, wdActiveDays[bestWdIdx].size);
  const bestWdAvg = wdRev[bestWdIdx] / bestWdActiveCount;

  const hourBuckets = new Array(24).fill(0);
  for (const e of periodEntries) hourBuckets[new Date(e.time).getHours()]++;
  const bestHour = hourBuckets.indexOf(Math.max(...hourBuckets));
  const bestHourHasData = hourBuckets[bestHour] > 0;

  // Cash mix + coupon rate
  const hairBase = cur.haircutRevenue || 1;
  const cashPct = (cur.cash / hairBase) * 100;
  const cardPct = (cur.card / hairBase) * 100;
  const couponRate = cur.customers ? (cur.coupons / cur.customers) * 100 : 0;

  // ----- Render -----
  let html = `<div class="screen">`;

  // Period pills
  html += `<div class="pills">`;
  for (const [val, lbl] of [["week", "Weekly"], ["month", "Monthly"], ["all", "All time"]]) {
    html += `<button class="pill ${period === val ? "active" : ""}" data-action="set-analytics-period" data-value="${val}">${lbl}</button>`;
  }
  html += `</div>`;

  // Scope pills
  html += `<div class="pills">`;
  for (const [val, lbl] of [["all", "Both barbers"], ["Sami", "Sami"], ["Amine", "Amine"]]) {
    html += `<button class="pill ${scope === val ? "active" : ""}" data-action="set-analytics-scope" data-value="${val}">${lbl}</button>`;
  }
  html += `</div>`;

  // Period nav
  if (range.canNav) {
    html += `<div class="week-nav">
      <button data-action="analytics-prev">&larr; Prev</button>
      <div class="week-label">${range.label}</div>
      <button data-action="analytics-next" ${offset >= 0 ? "disabled style='opacity:0.4'" : ""}>Next &rarr;</button>
    </div>`;
  } else {
    html += `<div class="week-nav"><div class="week-label" style="width:100%;text-align:center">${range.label}</div></div>`;
  }

  // HEADLINE
  const trendClass = (a, b) => (b ? (a >= b ? "up" : "down") : "");
  const trendTxt = (a, b) => (b ? fmtPct(a, b) : "");
  html += `<div class="stat-card analytics-headline">
    <div class="hl-row">
      <div class="hl-label">${scope === "all" ? "Total revenue" : `${scope}'s revenue`}</div>
      <div class="hl-value">${fmtEuroInt(cur.revenue)} ${
    prev ? `<span class="trend ${trendClass(cur.revenue, prev.revenue)}">${trendTxt(cur.revenue, prev.revenue)}</span>` : ""
  }</div>
    </div>
    <div class="hl-sub">
      <span>${cur.customers} customers ${prev ? `<span class="trend ${trendClass(cur.customers, prev.customers)}">${trendTxt(cur.customers, prev.customers)}</span>` : ""}</span>
      <span>${fmtEuro(cur.avgPerCustomer)} avg ticket</span>
    </div>
    ${isCurrentPeriod ? `<div class="progress-bar"><div class="progress-fill" style="width:${progressPct}%"></div></div>
      <div class="hl-sub"><span>Day ${elapsedDays} of ${totalDays}</span><span>${progressPct}% through</span></div>` : ""}
  </div>`;

  // PROJECTION INSIGHT
  if (canProject) {
    const projTxt = `On current pace, ${period === "week" ? "this week" : "this month"} ends at <b>${fmtEuroInt(linearProj)}</b>.`;
    const vsTxt =
      projVsPrev != null
        ? ` That's ${projVsPrev >= 0 ? "+" : ""}${projVsPrev.toFixed(0)}% vs ${
            period === "week" ? "last week" : "last month"
          } (${fmtEuroInt(prev.revenue)}).`
        : "";
    const remainDays = totalDays - elapsedDays;
    const needPerDay = remainDays > 0 ? (linearProj - cur.revenue) / remainDays : 0;
    html += `<div class="insight-card">
      <h3>📈 Projection</h3>
      <p>${projTxt}${vsTxt}</p>
      <p class="insight-sub">Needs roughly <b>${fmtEuroInt(needPerDay)}/day</b> over the remaining ${remainDays} day${remainDays === 1 ? "" : "s"}.</p>
    </div>`;
  } else if (period !== "all" && prev) {
    // Past period — compare totals
    const delta = cur.revenue - prev.revenue;
    const pct = prev.revenue ? (delta / prev.revenue) * 100 : 0;
    html += `<div class="insight-card">
      <h3>📊 Comparison</h3>
      <p>${
        delta >= 0
          ? `Up <b>${fmtEuroInt(delta)}</b> (+${pct.toFixed(0)}%)`
          : `Down <b>${fmtEuroInt(-delta)}</b> (${pct.toFixed(0)}%)`
      } vs ${period === "week" ? "the week before" : "the month before"}.</p>
    </div>`;
  }

  // PATTERNS
  if (bestWdHasData || bestHourHasData) {
    html += `<div class="insight-card">
      <h3>🗓️ Patterns</h3>`;
    if (bestWdHasData) {
      const wdLine =
        period === "week"
          ? `Best day this week: <b>${wdNames[bestWdIdx]}</b> (${fmtEuroInt(wdRev[bestWdIdx])}, ${wdCount[bestWdIdx]} customer${wdCount[bestWdIdx] === 1 ? "" : "s"}).`
          : `Best weekday: <b>${wdNames[bestWdIdx]}</b> — avg <b>${fmtEuroInt(bestWdAvg)}/day</b> across ${bestWdActiveCount} ${wdNames[bestWdIdx]}${bestWdActiveCount === 1 ? "" : "s"}.`;
      html += `<p>${wdLine}</p>`;
    }
    if (bestHourHasData) {
      const cnt = hourBuckets[bestHour];
      html += `<p>Busiest hour: <b>${String(bestHour).padStart(2, "0")}:00</b> — ${cnt} customer${cnt === 1 ? "" : "s"}.</p>`;
    }
    // mini weekday bars
    const wdMax = Math.max(...wdRev, 1);
    const wdOrder = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
    html += `<div class="wd-grid">`;
    for (const i of wdOrder) {
      const h = (wdRev[i] / wdMax) * 100;
      html += `<div class="wd-col">
        <div class="wd-bar"><div class="wd-fill" style="height:${Math.max(h, 4)}%"></div></div>
        <div class="wd-name">${wdNames[i].slice(0, 3)}</div>
        <div class="wd-val">${wdRev[i] > 0 ? fmtEuroInt(wdRev[i]) : ""}</div>
      </div>`;
    }
    html += `</div></div>`;
  }

  // ALL-TIME HISTORICAL PATTERNS (uses every event ever logged)
  const hist = buildHistoricalInsights();
  if (hist && hist.totalDaysOnRecord >= 2) {
    const ord = ["", "1st", "2nd", "3rd", "4th", "5th"];
    html += `<div class="insight-card">
      <h3>📅 All-time patterns</h3>`;
    if (hist.bestWm && hist.bestWm.count >= 2) {
      html += `<p>Highest week of the month: <b>${ord[hist.bestWm.wm]} week</b> — avg <b>${fmtEuroInt(hist.bestWm.avg)}/week</b> (across ${hist.bestWm.count} months).</p>`;
    }
    if (hist.bestDays.length) {
      const list = hist.bestDays.map((d) => `<b>${d.name}</b> (${fmtEuroInt(d.avg)})`).join(" and ");
      html += `<p>Strongest days: ${list}.</p>`;
    }
    if (hist.slowDays.length) {
      const list = hist.slowDays.map((d) => `<b>${d.name}</b> (${fmtEuroInt(d.avg)})`).join(" and ");
      html += `<p>Slowest days: ${list}.</p>`;
    }
    if (hist.bestDay) {
      html += `<p>Highest single day on record: <b>${formatDay(hist.bestDay.date)}</b> with <b>${fmtEuroInt(hist.bestDay.total)}</b>.</p>`;
    }
    html += `<p class="insight-sub">Based on ${hist.totalDaysOnRecord} day${hist.totalDaysOnRecord === 1 ? "" : "s"} of logged activity.</p>`;
    html += `</div>`;
  }

  // MONEY MIX
  html += `<div class="insight-card">
    <h3>💶 Money mix</h3>
    ${cur.haircutRevenue > 0 ? `<p><b>${cashPct.toFixed(0)}%</b> in cash, <b>${cardPct.toFixed(0)}%</b> by card on haircuts.</p>
      <div class="mix-bar">
        <div class="mix-fill esp" style="width:${cashPct}%"></div>
        <div class="mix-fill cb" style="width:${cardPct}%"></div>
      </div>` : `<p>No haircuts logged yet.</p>`}
    ${cur.products > 0 ? `<p>Products: <b>${fmtEuroInt(cur.products)}</b> from ${cur.productCount} sale${cur.productCount === 1 ? "" : "s"} (<b>${((cur.products / Math.max(cur.revenue, 1)) * 100).toFixed(0)}%</b> of revenue).</p>` : ""}
    ${cur.customers > 0 ? `<p>Coupons: <b>${cur.coupons}</b>/${cur.customers} customers (<b>${couponRate.toFixed(0)}%</b>) used the -20% discount.</p>` : ""}
    ${scope === "all" ? `<p>Expenses: <b>-${fmtEuroInt(expensesTotal)}</b>. House net (after split + expenses): <b>${fmtEuroInt(cur.revenue * 0.5 - expensesTotal)}</b>.</p>` : `<p>Acomptes already taken: <b>-${fmtEuroInt(cur.acomptes)}</b>. Pending share: <b>${fmtEuroInt(cur.revenue * 0.5 - cur.acomptes)}</b>.</p>`}
  </div>`;

  // SAMI vs AMINE (when both)
  if (scope === "all") {
    const sami = computeBucket(range.start, range.end, "Sami");
    const amine = computeBucket(range.start, range.end, "Amine");
    const maxRev = Math.max(sami.revenue, amine.revenue, 1);
    const maxCust = Math.max(sami.customers, amine.customers, 1);

    // Sentence insights
    const lines = [];
    if (sami.revenue !== amine.revenue) {
      const lead = sami.revenue > amine.revenue ? "Sami" : "Amine";
      const diff = Math.abs(sami.revenue - amine.revenue);
      const pct = ((diff / Math.max(Math.min(sami.revenue, amine.revenue), 1)) * 100).toFixed(0);
      lines.push(`<b>${lead}</b> brought in <b>${fmtEuroInt(diff)}</b> more (+${pct}%).`);
    }
    if (sami.customers !== amine.customers) {
      const lead = sami.customers > amine.customers ? "Sami" : "Amine";
      lines.push(`<b>${lead}</b> saw more customers (${sami.customers} vs ${amine.customers}).`);
    }
    if (sami.avgPerCustomer !== amine.avgPerCustomer && sami.customers && amine.customers) {
      const lead = sami.avgPerCustomer > amine.avgPerCustomer ? "Sami" : "Amine";
      lines.push(`<b>${lead}</b> has the higher avg ticket (${fmtEuro(sami.avgPerCustomer)} vs ${fmtEuro(amine.avgPerCustomer)}).`);
    }
    if (sami.products !== amine.products && (sami.products || amine.products)) {
      const lead = sami.products > amine.products ? "Sami" : "Amine";
      lines.push(`<b>${lead}</b> sold more products (${fmtEuroInt(sami.products)} vs ${fmtEuroInt(amine.products)}).`);
    }

    html += `<div class="stat-card" style="margin-bottom:12px">
      <h3>Sami vs Amine</h3>
      <div class="cmp-section-label">Revenue</div>
      <div class="cmp-row">
        <div class="cmp-label">Sami</div>
        <div class="cmp-bar"><div class="cmp-fill sami" style="width:${(sami.revenue / maxRev) * 100}%"></div></div>
        <div class="cmp-val">${fmtEuroInt(sami.revenue)}</div>
      </div>
      <div class="cmp-row">
        <div class="cmp-label">Amine</div>
        <div class="cmp-bar"><div class="cmp-fill amine" style="width:${(amine.revenue / maxRev) * 100}%"></div></div>
        <div class="cmp-val">${fmtEuroInt(amine.revenue)}</div>
      </div>
      <div class="cmp-section-label">Customers</div>
      <div class="cmp-row">
        <div class="cmp-label">Sami</div>
        <div class="cmp-bar"><div class="cmp-fill sami" style="width:${(sami.customers / maxCust) * 100}%"></div></div>
        <div class="cmp-val">${sami.customers}</div>
      </div>
      <div class="cmp-row">
        <div class="cmp-label">Amine</div>
        <div class="cmp-bar"><div class="cmp-fill amine" style="width:${(amine.customers / maxCust) * 100}%"></div></div>
        <div class="cmp-val">${amine.customers}</div>
      </div>
    </div>`;

    if (lines.length) {
      html += `<div class="insight-card">
        <h3>🥊 Head-to-head</h3>`;
      for (const l of lines) html += `<p>${l}</p>`;
      html += `</div>`;
    }
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
    case "set-analytics-period":
      state.analytics.period = data.value;
      state.analytics.offset = 0;
      render();
      break;
    case "set-analytics-scope":
      state.analytics.scope = data.value;
      render();
      break;
    case "analytics-prev":
      state.analytics.offset--;
      render();
      break;
    case "analytics-next":
      if (state.analytics.offset < 0) {
        state.analytics.offset++;
        render();
      }
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
    case "start-acompte":
      state.amount = "";
      state.entryDate = null;
      state.selectedBarber = null;
      state.view = "acompte-barber";
      render();
      break;
    case "start-product":
      state.amount = "";
      state.entryDate = null;
      state.selectedBarber = null;
      state.view = "product-barber";
      render();
      break;
    case "select-product-barber":
      state.selectedBarber = data.barber;
      state.amount = "";
      state.view = "product-amount";
      render();
      break;
    case "confirm-product": {
      const amt = parseInt(state.amount, 10);
      if (!amt || amt <= 0) return;
      if (state.editingId) {
        localUpdate(state.editingId, { amount: amt });
        showToast(`Product updated: ${amt}€`);
        state.editingId = null;
        state.tab = "stats";
      } else {
        const ts = tsFromEntryDate();
        localInsert({
          id: newId(),
          type: "product",
          barber: state.selectedBarber,
          amount: amt,
          ts,
        });
        showToast(
          `Product sold: ${state.selectedBarber} ${amt}€${
            state.entryDate ? " (backdated)" : ""
          }`
        );
      }
      state.view = "home";
      state.amount = "";
      state.selectedBarber = null;
      state.entryDate = null;
      render();
      syncNow();
      break;
    }
    case "select-acompte-barber":
      state.selectedBarber = data.barber;
      state.amount = "";
      state.view = "acompte-amount";
      render();
      break;
    case "confirm-acompte": {
      const amt = parseInt(state.amount, 10);
      if (!amt || amt <= 0) return;
      if (state.editingId) {
        localUpdate(state.editingId, { amount: amt });
        showToast(`Acompte updated: ${amt}€`);
        state.editingId = null;
        state.tab = "stats";
      } else {
        const ts = tsFromEntryDate();
        localInsert({
          id: newId(),
          type: "acompte",
          barber: state.selectedBarber,
          amount: amt,
          ts,
        });
        showToast(
          `Acompte saved: ${state.selectedBarber} ${amt}€${
            state.entryDate ? " (backdated)" : ""
          }`
        );
      }
      state.view = "home";
      state.amount = "";
      state.selectedBarber = null;
      state.entryDate = null;
      render();
      syncNow();
      break;
    }
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
      if (data.kind === "acompte") {
        const ac = state.data.acomptes.find((e) => e.id === data.id);
        if (!ac) return;
        state.editingId = ac.id;
        state.selectedBarber = ac.barber;
        state.amount = String(ac.amount);
        state.tab = "register";
        state.view = "acompte-amount";
        render();
        return;
      }
      if (data.kind === "product") {
        const pr = state.data.products.find((e) => e.id === data.id);
        if (!pr) return;
        state.editingId = pr.id;
        state.selectedBarber = pr.barber;
        state.amount = String(pr.amount);
        state.tab = "register";
        state.view = "product-amount";
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

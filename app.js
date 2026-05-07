const BARBERS = ["Sami", "Amine"];
const STORAGE_KEY = "barbershop_data_v1";

const state = {
  view: "home",
  tab: "register",
  selectedBarber: null,
  amount: "",
  weekOffset: 0,
  editingId: null,
  data: loadData(),
};

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { entries: [], checkins: [] };
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
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
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatDay(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short" });
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

function render() {
  const root = document.getElementById("app");
  let html = `<header><h1>Barbershop</h1></header>`;

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
    </div>`;
  }

  if (state.view === "amount") {
    const display = state.amount ? state.amount : "0";
    const empty = state.amount ? "" : "empty";
    const editing = state.editingId ? " (editing)" : "";
    return `<div class="screen">
      <button class="back-btn" data-action="back-home">&larr; ${state.editingId ? "Cancel" : "Back"}</button>
      <h2>${state.selectedBarber} — Amount?${editing}</h2>
      <div class="amount-display ${empty}">${display}<span class="currency">€</span></div>
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
    return `<div class="screen">
      <button class="back-btn" data-action="back-amount">&larr; Back</button>
      <h2>${state.selectedBarber} — ${state.amount}€ — Payment?${editing}</h2>
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

  const stats = {};
  for (const b of BARBERS) {
    stats[b] = { count: 0, esp: 0, cb: 0, total: 0 };
  }
  for (const e of weekEntries) {
    if (!stats[e.barber]) continue;
    stats[e.barber].count++;
    stats[e.barber].total += e.amount;
    if (e.method === "ESP") stats[e.barber].esp += e.amount;
    else stats[e.barber].cb += e.amount;
  }

  let html = `<div class="screen">
    <div class="week-nav">
      <button data-action="week-prev">&larr; Prev</button>
      <div class="week-label">${getWeekLabel()}</div>
      <button data-action="week-next" ${state.weekOffset >= 0 ? "disabled style='opacity:0.4'" : ""}>Next &rarr;</button>
    </div>
    <div class="summary">`;

  for (const b of BARBERS) {
    const s = stats[b];
    html += `<div class="stat-card">
      <h3>${b}</h3>
      <div class="row"><span class="label">Customers</span><span class="value">${s.count}</span></div>
      <div class="row"><span class="label">Cash (ESP)</span><span class="value">${s.esp}€</span></div>
      <div class="row"><span class="label">Card (CB)</span><span class="value">${s.cb}€</span></div>
      <div class="row total"><span class="label">Total</span><span class="value">${s.total}€</span></div>
    </div>`;
  }
  html += `</div>`;

  const sorted = [...weekEntries].sort((a, b) => b.time - a.time);
  html += `<div class="history"><h3>This week's entries (${sorted.length})</h3>`;
  if (sorted.length === 0) {
    html += `<div style="text-align:center;color:#64748b;padding:20px">No entries yet</div>`;
  } else {
    for (const e of sorted) {
      html += `<div class="entry">
        <div>
          <span class="who">${e.barber}</span>
          <span class="meta">${formatDay(e.time)} ${formatTime(e.time)}</span>
        </div>
        <div>
          <span class="amt">${e.amount}€</span>
          <span class="pay ${e.method}">${e.method}</span>
          <button class="edit-btn" data-action="edit-entry" data-id="${e.id}" title="Edit">✎</button>
          <button class="del-btn" data-action="delete-entry" data-id="${e.id}" title="Delete">×</button>
        </div>
      </div>`;
    }
  }
  html += `</div></div>`;
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
      render();
    });
  });

  document.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", (e) => handleAction(el.dataset.action, el.dataset, e));
  });
}

function handleAction(action, data) {
  switch (action) {
    case "select-barber":
      state.selectedBarber = data.barber;
      state.amount = "";
      state.view = "amount";
      render();
      break;
    case "back-home":
      if (state.editingId) {
        state.editingId = null;
        state.tab = "stats";
      }
      state.view = "home";
      state.selectedBarber = null;
      state.amount = "";
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
      if (state.editingId) {
        const entry = state.data.entries.find((e) => e.id === state.editingId);
        if (entry) {
          entry.amount = parseInt(state.amount, 10);
          entry.method = data.method;
          saveData();
          showToast(`Updated: ${entry.barber} ${entry.amount}€ ${entry.method}`);
        }
        state.editingId = null;
        state.tab = "stats";
      } else {
        const entry = {
          id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
          barber: state.selectedBarber,
          amount: parseInt(state.amount, 10),
          method: data.method,
          time: Date.now(),
        };
        state.data.entries.push(entry);
        saveData();
        showToast(`Saved: ${entry.barber} ${entry.amount}€ ${entry.method}`);
      }
      state.view = "home";
      state.selectedBarber = null;
      state.amount = "";
      render();
      break;
    }
    case "checkin": {
      const existing = checkinToday(data.barber);
      if (existing) return;
      state.data.checkins.push({
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
        barber: data.barber,
        time: Date.now(),
      });
      saveData();
      showToast(`${data.barber} checked in at ${formatTime(Date.now())}`);
      render();
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
        state.data.entries = state.data.entries.filter((e) => e.id !== data.id);
        saveData();
        render();
      }
      break;
    case "edit-entry": {
      const entry = state.data.entries.find((e) => e.id === data.id);
      if (!entry) return;
      state.editingId = entry.id;
      state.selectedBarber = entry.barber;
      state.amount = String(entry.amount);
      state.tab = "register";
      state.view = "amount";
      render();
      break;
    }
  }
}

render();

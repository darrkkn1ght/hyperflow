const $ = (id) => document.getElementById(id);

const VAULT_TOKEN_KEY = "hyperflow_workspace_token";
const PRESETS_STORAGE_KEY = "hyperflow_saved_presets_v1";
const SELECTED_UIDS_KEY = "hyperflow_selected_uids_v1";

let workspaceToken = localStorage.getItem(VAULT_TOKEN_KEY) || "";
let accounts = [];
let selectedUids = new Set(JSON.parse(localStorage.getItem(SELECTED_UIDS_KEY) || "[]"));
let activeMode = "split_total";
let currentChallenge = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtMoney(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return "₦0";
  if (v >= 1e15) return `₦${(v / 1e15).toFixed(2).replace(/\.00$/, "")}Q`;
  if (v >= 1e12) return `₦${(v / 1e12).toFixed(2).replace(/\.00$/, "")}T`;
  if (v >= 1e9) return `₦${(v / 1e9).toFixed(2).replace(/\.00$/, "")}B`;
  if (v >= 1e6) return `₦${(v / 1e6).toFixed(2).replace(/\.00$/, "")}M`;
  return `₦${Math.floor(v).toLocaleString()}`;
}

function openModal(id) {
  $(id)?.classList.remove("hidden");
  document.body.classList.add("modal-open");
}

function closeModal(id) {
  $(id)?.classList.add("hidden");
  const anyOpen = document.querySelectorAll(".modal-overlay:not(.hidden)").length > 0;
  if (!anyOpen) document.body.classList.remove("modal-open");
}

function showToast(msg, type = "info") {
  const c = $("toast-container");
  if (!c) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

async function api(path, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (workspaceToken) headers["x-client-token"] = workspaceToken;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (data.token && data.token !== workspaceToken) {
    workspaceToken = data.token;
    localStorage.setItem(VAULT_TOKEN_KEY, workspaceToken);
  }
  return { ok: res.ok, status: res.status, data };
}

function loadSavedPresets() {
  try {
    const arr = JSON.parse(localStorage.getItem(PRESETS_STORAGE_KEY) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function syncPresetsFromAccounts(acctList) {
  const existing = new Map(loadSavedPresets().map((p) => [p.uid, p]));
  for (const a of acctList) {
    existing.set(a.uid, {
      uid: a.uid,
      user: a.user,
      name: a.name,
      cookie: a.cookie,
      pin: existing.get(a.uid)?.pin || ""
    });
  }
  localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify([...existing.values()]));
}

function saveSelectedUids() {
  localStorage.setItem(SELECTED_UIDS_KEY, JSON.stringify([...selectedUids]));
}

function formatDurationShort(ms) {
  const sec = Math.max(1, Math.ceil(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatJobEta(j) {
  if (j.status === "COMPLETED" || (j.total > 0 && j.remaining === 0)) {
    return j.finishedAt
      ? `✅ Finished at ${new Date(j.finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "✅ Finished";
  }
  if (j.status === "CANCELLED") return "🛑 Cancelled";
  if (j.status === "FAILED") return "⚠️ Stopped";

  const remMs = j.estimatedFinishAt ? Math.max(0, j.estimatedFinishAt - Date.now()) : (j.estimatedRemainingMs || 0);
  if (j.status === "SCHEDULED" && j.scheduledTimestamp) {
    const fin = new Date(j.scheduledTimestamp + remMs);
    return `⏱️ Starts ${new Date(j.scheduledTimestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} • Finishes ~${fin.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  if (j.status === "PAUSED") {
    return `⏸️ Paused (~${formatDurationShort(remMs)} left once resumed)`;
  }
  const fin = new Date(Date.now() + remMs);
  return `⏱️ ETA: ~${formatDurationShort(remMs)} left (finishes ~${fin.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`;
}

function parseAmountClient(raw) {
  const cleaned = String(raw || "").trim().toLowerCase().replace(/[₦,\s]/g, "");
  const m = cleaned.match(/^(\d+(?:\.\d+)?)([kmbtq]?)$/);
  if (!m) return 0;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num <= 0) return 0;
  const mult = { "": 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 };
  return Math.floor(num * (mult[m[2]] || 1));
}

function updateThroughputAndPreflight() {
  const selected = accounts.filter((a) => selectedUids.has(a.uid) && a.status !== "EXPIRED");
  const n = selected.length;
  const strip = $("throughput-badge");
  if (strip) {
    strip.textContent = n > 0
      ? `⚡ ${n}× Parallel Speed · Up to ${fmtMoney(n * 100e9)} / 30.5s`
      : "⚡ 0× Speed · 30.5s cooldown per lane";
  }

  const pf = $("preflight-preview");
  if (!pf) return;
  if (n === 0) {
    pf.className = "hf-preflight";
    pf.textContent = "Select at least 1 sender account to preview speed & ETA.";
    return;
  }

  const rawAmt = $("amount-input")?.value || "";
  const amt = parseAmountClient(rawAmt);
  let totalToSend = 0;
  let maxChunksOnOneLane = 0;

  if (activeMode === "drain") {
    totalToSend = selected.reduce((s, a) => s + Math.floor(a.money || 0), 0);
    maxChunksOnOneLane = Math.max(...selected.map((a) => Math.ceil(Math.floor(a.money || 0) / 100e9)), 0);
  } else if (activeMode === "per_account") {
    if (amt <= 0) {
      pf.className = "hf-preflight";
      pf.textContent = `Enter an amount per account (${n} selected).`;
      return;
    }
    const eligible = selected.filter((a) => Number(a.money || 0) >= amt);
    totalToSend = eligible.length * amt;
    maxChunksOnOneLane = Math.ceil(amt / 100e9);
  } else {
    if (amt <= 0) {
      pf.className = "hf-preflight";
      pf.textContent = `Enter total amount to split across ${n} selected account(s).`;
      return;
    }
    totalToSend = amt;
    maxChunksOnOneLane = Math.ceil(Math.ceil(amt / n) / 100e9);
  }

  if (totalToSend <= 0 || maxChunksOnOneLane <= 0) {
    pf.className = "hf-preflight";
    pf.textContent = "Selected accounts have insufficient balance for this configuration.";
    return;
  }

  const estMs = Math.max(1, maxChunksOnOneLane - 1) * 30950 + 700;
  const fin = new Date(Date.now() + estMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  pf.className = "hf-preflight ready";
  pf.textContent = `⚡ ${n} lane(s) · ${fmtMoney(totalToSend)} total · Est. ${formatDurationShort(estMs)} (finishes ~${fin})`;
}

// ---------------------------------------------------------------------------
// Render Fleet & Summary
// ---------------------------------------------------------------------------
function renderFleet() {
  const validIds = new Set(accounts.map((a) => a.uid));
  for (const id of [...selectedUids]) {
    if (!validIds.has(id)) selectedUids.delete(id);
  }
  if (selectedUids.size === 0 && accounts.length > 0) {
    accounts.forEach((a) => selectedUids.add(a.uid));
  }
  saveSelectedUids();

  let selectedSum = 0;
  let totalSum = 0;
  let selectedCount = 0;
  for (const a of accounts) {
    totalSum += Number(a.money || 0);
    if (selectedUids.has(a.uid)) {
      selectedSum += Number(a.money || 0);
      selectedCount++;
    }
  }

  $("fleet-selected-balance").textContent = fmtMoney(selectedSum);
  $("fleet-total-balance").textContent = fmtMoney(totalSum);
  $("fleet-account-count").textContent = String(accounts.length);
  $("selected-count-pill").textContent = `${selectedCount} Selected`;

  const list = $("fleet-list");
  if (accounts.length === 0) {
    list.innerHTML = `<div class="empty-state" style="padding:20px 10px;"><p>No sender accounts connected yet. Click <strong>+ Add Account</strong> to log in your first account.</p></div>`;
    return;
  }

  list.innerHTML = accounts
    .map((a) => {
      const checked = selectedUids.has(a.uid) ? "checked" : "";
      const expiredBadge = a.status === "EXPIRED" ? `<span class="badge-expired">Expired</span>` : "";
      const pinBadge = a.hasPin ? `<span class="badge-pin">PIN Set</span>` : "";
      return `
        <div class="fleet-row ${checked ? "selected" : ""}" data-uid="${a.uid}">
          <label class="fleet-check-wrap">
            <input type="checkbox" class="fleet-checkbox" data-uid="${a.uid}" ${checked}>
            <div>
              <div class="fleet-user">@${a.user} ${expiredBadge} ${pinBadge}</div>
              <div class="fleet-name">${a.name || a.user}</div>
            </div>
          </label>
          <div class="fleet-right">
            <span class="fleet-bal">${fmtMoney(a.money)}</span>
            <button type="button" class="hf-btn hf-btn-xs" onclick="promptAccountPin('${a.uid}')">PIN</button>
            <button type="button" class="hf-icon-btn" onclick="removeAccount('${a.uid}')" title="Remove preset">✕</button>
          </div>
        </div>
      `;
    })
    .join("");

  list.querySelectorAll(".fleet-checkbox").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const uid = e.target.dataset.uid;
      if (e.target.checked) selectedUids.add(uid);
      else selectedUids.delete(uid);
      saveSelectedUids();
      renderFleet();
    });
  });
  updateThroughputAndPreflight();
}

window.promptAccountPin = async (uid) => {
  const pin = window.prompt("Enter 4-digit Transaction PIN for this sender (leave blank to clear):");
  if (pin === null) return;
  const r = await api("/api/vault/pin", { method: "POST", body: JSON.stringify({ uid, pin: pin.trim() }) });
  if (r.ok) {
    const presets = loadSavedPresets().map((p) => (p.uid === uid ? { ...p, pin: pin.trim() } : p));
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
    showToast("Preset PIN updated.", "success");
    await refreshStatus();
  }
};

window.removeAccount = async (uid) => {
  const presets = loadSavedPresets().filter((p) => p.uid !== uid);
  localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
  selectedUids.delete(uid);
  saveSelectedUids();
  const r = await api("/api/vault/remove", { method: "POST", body: JSON.stringify({ uid }) });
  if (r.ok) {
    accounts = r.data.accounts || [];
    renderFleet();
    showToast("Account removed from presets.", "info");
  }
};

// ---------------------------------------------------------------------------
// Render Pipeline Jobs + Per-Lane 2FA/PIN
// ---------------------------------------------------------------------------
function renderJobs(jobs) {
  const container = $("jobs-list");
  const badge = $("active-badge");
  const runningCount = jobs.filter((j) => j.status === "RUNNING").length;
  const pausedCount = jobs.filter((j) => j.status === "PAUSED").length;
  badge.textContent = runningCount > 0 ? `${runningCount} Running` : pausedCount > 0 ? `${pausedCount} Paused` : "0 Active";

  if (!jobs || jobs.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚡</div><p>No active pipelines yet. Select accounts above and launch a transfer!</p></div>`;
    return;
  }

  const empty = container.querySelector(".empty-state");
  if (empty) empty.remove();

  const ids = new Set(jobs.slice(0, 10).map((j) => j.id));
  container.querySelectorAll(".job-card[data-job-id]").forEach((el) => {
    if (!ids.has(el.dataset.jobId)) el.remove();
  });

  jobs.slice(0, 10).forEach((j) => {
    const pct = j.total > 0 ? Math.min(100, Math.round(((j.total - j.remaining) / j.total) * 100)) : 0;
    const etaText = formatJobEta(j);
    const isCompleted = j.status === "COMPLETED" || (j.total > 0 && j.remaining === 0);
    const isCancelled = j.status === "CANCELLED";

    let actionsHtml = "";
    if (j.status === "SCHEDULED") {
      actionsHtml = `<div class="job-actions"><button class="btn-pause" onclick="jobAction('start-now','${j.id}')">Start Now</button><button class="btn-stop" onclick="jobAction('stop','${j.id}')">Cancel</button></div>`;
    } else if (j.status === "RUNNING") {
      actionsHtml = `<div class="job-actions"><button class="btn-pause" onclick="jobAction('pause','${j.id}')">Pause</button><button class="btn-stop" onclick="jobAction('stop','${j.id}')">Stop</button></div>`;
    } else if (j.status === "PAUSED") {
      actionsHtml = `<div class="job-actions"><button class="btn-resume" onclick="jobAction('resume','${j.id}')">Resume</button><button class="btn-stop" onclick="jobAction('stop','${j.id}')">Stop</button></div>`;
    } else {
      actionsHtml = `<div class="job-actions"><span style="font-size:11px;font-weight:700;color:${isCompleted ? "var(--apple-green)" : "var(--text-tertiary)"};">${j.status}</span><button class="btn-dismiss-job" onclick="jobAction('dismiss','${j.id}')">✕</button></div>`;
    }

    const lanesHtml = (j.lanes || [])
      .map((l) => {
        const lPct = l.total > 0 ? Math.min(100, Math.round(((l.total - l.remaining) / l.total) * 100)) : 0;
        const needsCode = l.needsTwoStep && l.status === "PAUSED";
        return `
          <div class="lane-row" data-lane-uid="${l.uid}">
            <div class="lane-top">
              <span><strong>@${l.user}</strong> · ${fmtMoney(l.total - l.remaining)} / ${fmtMoney(l.total)} (${lPct}%)</span>
              <span class="lane-status">${l.status}</span>
            </div>
            <div class="progress-bar-bg" style="height:4px; margin:5px 0;">
              <div class="progress-bar-fill" style="width:${lPct}%;"></div>
            </div>
            ${
              needsCode
                ? `<div class="lane-code-box">
                    <input type="text" id="lane-code-${j.id}-${l.uid}" placeholder="${l.twoStepType === "2fa" ? "6-digit 2FA code" : "4-digit PIN"}" inputmode="numeric" maxlength="10" class="mono-input">
                    <button type="button" class="btn btn-gold btn-mini" onclick="submitLaneCode('${j.id}','${l.uid}')">Resume @${l.user}</button>
                  </div>`
                : `<div class="lane-log">${l.lastLog || ""}</div>`
            }
          </div>
        `;
      })
      .join("");

    let card = container.querySelector(`.job-card[data-job-id="${j.id}"]`);
    if (!card) {
      card = document.createElement("div");
      card.className = "job-card";
      card.dataset.jobId = j.id;
      card.innerHTML = `
        <div class="job-header">
          <span class="job-title">To ${j.targetLabel} <span class="lane-count-tag">${j.lanes.length} lanes</span></span>
          <div class="job-actions-slot">${actionsHtml}</div>
        </div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="job-meta">
          <span class="job-progress-text">Progress: ${pct}% (${j.txCount}/${j.totalTxs} TXs)</span>
          <span class="job-remaining-text">Remaining: ${fmtMoney(j.remaining)}</span>
        </div>
        <div class="job-eta" style="font-size:11px; color:var(--text-secondary); margin-top:4px; font-weight:500;">${etaText}</div>
        <div class="lanes-container">${lanesHtml}</div>
      `;
      container.appendChild(card);
    } else {
      card.querySelector(".job-actions-slot").innerHTML = actionsHtml;
      card.querySelector(".progress-bar-fill").style.width = `${pct}%`;
      card.querySelector(".job-progress-text").textContent = `Progress: ${pct}% (${j.txCount}/${j.totalTxs} TXs)`;
      card.querySelector(".job-remaining-text").textContent = `Remaining: ${fmtMoney(j.remaining)}`;
      card.querySelector(".job-eta").textContent = etaText;

      // Update lanes without wiping focused lane inputs
      const lanesWrap = card.querySelector(".lanes-container");
      const focusedId = document.activeElement?.id || "";
      if (!focusedId.startsWith(`lane-code-${j.id}-`)) {
        lanesWrap.innerHTML = lanesHtml;
      }
    }
  });
}

window.jobAction = async (act, jobId) => {
  await api(`/api/pipeline/${act}`, { method: "POST", body: JSON.stringify({ jobId }) });
  await refreshStatus();
};

window.submitLaneCode = async (jobId, uid) => {
  const input = $(`lane-code-${jobId}-${uid}`);
  const code = input?.value.trim();
  if (!code) return showToast("Enter PIN or 2FA code", "error");
  const r = await api("/api/pipeline/lane-resume", {
    method: "POST",
    body: JSON.stringify({ jobId, uid, code })
  });
  if (r.ok) {
    showToast("Code verified — lane resumed!", "success");
    await refreshStatus();
  } else {
    showToast(r.data.error || "Invalid code", "error");
  }
};

// ---------------------------------------------------------------------------
// Sync & Auto-Restore Presets
// ---------------------------------------------------------------------------
async function refreshStatus() {
  if (!workspaceToken) return;
  const r = await api("/api/vault/status");
  if (r.ok) {
    accounts = r.data.accounts || [];
    syncPresetsFromAccounts(accounts);
    renderFleet();
    renderJobs(r.data.jobs || []);
  }
}

async function restorePresetsOnBoot() {
  const presets = loadSavedPresets();
  if (presets.length === 0) return;
  const r = await api("/api/vault/restore", {
    method: "POST",
    body: JSON.stringify({ presets })
  });
  if (r.ok) {
    accounts = r.data.accounts || [];
    renderFleet();
    if (r.data.restored > 0) {
      showToast(`Restored ${r.data.restored} saved sender preset(s).`, "success");
    }
    if (r.data.expired?.length > 0) {
      showToast(`${r.data.expired.length} preset(s) expired — re-login to refresh.`, "info");
    }
  }
}

// ---------------------------------------------------------------------------
// Event Wiring
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  // Theme Toggle (Light / Obsidian Dark)
  const savedTheme = localStorage.getItem("hyperflow_theme") || "light";
  document.documentElement.setAttribute("data-theme", savedTheme);
  $("btn-theme-toggle").textContent = savedTheme === "dark" ? "☀️ Light" : "🌙 Dark";
  $("btn-theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("hyperflow_theme", next);
    $("btn-theme-toggle").textContent = next === "dark" ? "☀️ Light" : "🌙 Dark";
  });

  $("amount-input").addEventListener("input", updateThroughputAndPreflight);

  await restorePresetsOnBoot();
  await refreshStatus();
  setInterval(refreshStatus, 1500);

  // Mode Switcher
  const hints = {
    split_total: "Splits one total amount across your checked accounts and sends in parallel.",
    per_account: "Sends this exact amount from EVERY checked account simultaneously.",
    drain: "Drains the full available balance of every checked account to the recipient."
  };
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeMode = btn.dataset.mode;
      $("mode-hint").textContent = hints[activeMode] || "";
      $("amount-group").classList.toggle("hidden", activeMode === "drain");
      $("amount-label").textContent =
        activeMode === "per_account" ? "Amount Per Selected Account (₦)" : "Total Amount to Send (₦)";
      updateThroughputAndPreflight();
    });
  });

  document.querySelectorAll(".chip").forEach((c) => {
    c.addEventListener("click", () => {
      $("amount-input").value = c.dataset.val;
      updateThroughputAndPreflight();
    });
  });

  // Selection shortcuts
  $("btn-select-all").addEventListener("click", () => {
    accounts.forEach((a) => selectedUids.add(a.uid));
    saveSelectedUids();
    renderFleet();
  });
  $("btn-select-funded").addEventListener("click", () => {
    selectedUids.clear();
    accounts.filter((a) => Number(a.money) > 0).forEach((a) => selectedUids.add(a.uid));
    saveSelectedUids();
    renderFleet();
  });
  $("btn-select-none").addEventListener("click", () => {
    selectedUids.clear();
    saveSelectedUids();
    renderFleet();
  });
  $("btn-refresh-all").addEventListener("click", async () => {
    const r = await api("/api/vault/refresh", { method: "POST" });
    if (r.ok) {
      accounts = r.data.accounts || [];
      renderFleet();
      showToast("Live balances refreshed.", "success");
    }
  });

  // Add Account Modal
  $("btn-open-add-account").addEventListener("click", () => openModal("add-account-modal"));
  $("btn-close-add-modal").addEventListener("click", () => closeModal("add-account-modal"));
  document.querySelectorAll("#add-account-modal .auth-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#add-account-modal .auth-tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll("#add-account-modal .auth-tab-content").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      $(`auth-tab-${btn.dataset.auth}`).classList.add("active");
    });
  });

  $("btn-submit-login").addEventListener("click", async () => {
    const username = $("login-username").value.trim();
    const password = $("login-password").value;
    const pin = $("login-pin").value.trim();
    if (!username || !password) return showToast("Enter username and password.", "error");
    const r = await api("/api/vault/login", {
      method: "POST",
      body: JSON.stringify({ username, password, pin })
    });
    if (r.data.twoFactorRequired) {
      currentChallenge = r.data.challenge;
      closeModal("add-account-modal");
      $("twofactor-desc").textContent =
        r.data.method === "email"
          ? `Enter the 6-digit code emailed to ${r.data.to || "your email"}:`
          : "Type the 6-digit code from your authenticator app:";
      $("twofactor-resend-row").classList.toggle("hidden", r.data.method !== "email");
      $("twofactor-code-input").value = "";
      openModal("twofactor-modal");
      return;
    }
    if (r.ok && r.data.account) {
      accounts = r.data.accounts || [];
      selectedUids.add(r.data.account.uid);
      saveSelectedUids();
      syncPresetsFromAccounts(accounts);
      renderFleet();
      $("login-username").value = "";
      $("login-password").value = "";
      $("login-pin").value = "";
      closeModal("add-account-modal");
      showToast(`Added @${r.data.account.user} to pipeline!`, "success");
    } else {
      showToast(r.data.error || "Login failed.", "error");
    }
  });

  $("btn-twofactor-cancel").addEventListener("click", () => closeModal("twofactor-modal"));
  $("btn-twofactor-resend").addEventListener("click", async () => {
    if (!currentChallenge) return;
    await api("/api/vault/2fa/resend", { method: "POST", body: JSON.stringify({ challenge: currentChallenge }) });
    showToast("Code resent!", "info");
  });
  $("btn-twofactor-submit").addEventListener("click", async () => {
    const code = $("twofactor-code-input").value.trim();
    if (!code || !currentChallenge) return;
    const r = await api("/api/vault/2fa", {
      method: "POST",
      body: JSON.stringify({ challenge: currentChallenge, code })
    });
    if (r.ok && r.data.account) {
      accounts = r.data.accounts || [];
      selectedUids.add(r.data.account.uid);
      saveSelectedUids();
      syncPresetsFromAccounts(accounts);
      renderFleet();
      closeModal("twofactor-modal");
      showToast(`Added @${r.data.account.user} to pipeline!`, "success");
    } else {
      showToast(r.data.error || "Invalid 2FA code.", "error");
    }
  });

  $("btn-submit-cookie").addEventListener("click", async () => {
    const cookie = $("cookie-input").value.trim();
    const pin = $("cookie-pin").value.trim();
    if (!cookie) return showToast("Paste a session cookie.", "error");
    const r = await api("/api/vault/import-cookie", {
      method: "POST",
      body: JSON.stringify({ cookie, pin })
    });
    if (r.ok && r.data.account) {
      accounts = r.data.accounts || [];
      selectedUids.add(r.data.account.uid);
      saveSelectedUids();
      syncPresetsFromAccounts(accounts);
      renderFleet();
      $("cookie-input").value = "";
      $("cookie-pin").value = "";
      closeModal("add-account-modal");
      showToast(`Imported @${r.data.account.user}!`, "success");
    } else {
      showToast(r.data.error || "Invalid cookie.", "error");
    }
  });

  $("btn-submit-bulk-cookie").addEventListener("click", async () => {
    const cookies = $("bulk-cookie-input").value.trim();
    const pin = $("bulk-cookie-pin").value.trim();
    if (!cookies) return showToast("Paste cookies (one per line).", "error");
    const r = await api("/api/vault/import-bulk", {
      method: "POST",
      body: JSON.stringify({ cookies, pin })
    });
    if (r.ok) {
      accounts = r.data.accounts || [];
      accounts.forEach((a) => selectedUids.add(a.uid));
      saveSelectedUids();
      syncPresetsFromAccounts(accounts);
      renderFleet();
      $("bulk-cookie-input").value = "";
      $("bulk-cookie-pin").value = "";
      closeModal("add-account-modal");
      showToast(`Imported ${r.data.imported} account(s)${r.data.failed ? ` (${r.data.failed} invalid)` : ""}!`, "success");
    } else {
      showToast(r.data.error || "Bulk import failed.", "error");
    }
  });

  // Launch Multi-Pipeline Send
  $("btn-launch-pipeline").addEventListener("click", async () => {
    const to = $("target-input").value.trim();
    const amount = $("amount-input").value.trim();
    const scheduledAt = $("schedule-input").value;
    const pin = $("global-pin-input").value.trim();
    const senderUids = [...selectedUids];

    if (senderUids.length === 0) return showToast("Select at least one sender account.", "error");
    if (!to) return showToast("Enter a target recipient.", "error");
    if (activeMode !== "drain" && !amount) return showToast("Enter an amount.", "error");

    const r = await api("/api/pipeline/send", {
      method: "POST",
      body: JSON.stringify({ senderUids, to, mode: activeMode, amount, pin, scheduledAt })
    });
    if (r.ok) {
      showToast(`Pipeline launched across ${r.data.job.lanes.length} sender(s)!`, "success");
      await refreshStatus();
    } else {
      showToast(r.data.error || "Failed to launch pipeline.", "error");
    }
  });

  // Presets Export/Import
  $("btn-vault-backup").addEventListener("click", () => {
    $("backup-json-box").value = JSON.stringify(loadSavedPresets(), null, 2);
    openModal("backup-modal");
  });
  $("btn-close-backup").addEventListener("click", () => closeModal("backup-modal"));
  $("btn-copy-backup").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("backup-json-box").value);
    showToast("Presets JSON copied!", "success");
  });
  $("btn-import-backup").addEventListener("click", async () => {
    try {
      const parsed = JSON.parse($("backup-json-box").value);
      if (!Array.isArray(parsed)) throw new Error("Must be a JSON array");
      localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(parsed));
      closeModal("backup-modal");
      await restorePresetsOnBoot();
    } catch (e) {
      showToast("Invalid JSON: " + e.message, "error");
    }
  });

  // Donate Modal
  $("btn-open-donate").addEventListener("click", () => {
    const sel = $("donate-from-select");
    sel.innerHTML = accounts
      .map((a) => `<option value="${a.uid}">@${a.user} (${fmtMoney(a.money)})</option>`)
      .join("");
    openModal("donate-modal");
  });
  $("btn-close-donate").addEventListener("click", () => closeModal("donate-modal"));
  $("btn-send-donate").addEventListener("click", async () => {
    const uid = $("donate-from-select").value;
    const amount = $("donate-amount-input").value.trim();
    if (!uid || !amount) return showToast("Choose an account and amount.", "error");
    const r = await api("/api/pipeline/send", {
      method: "POST",
      body: JSON.stringify({ senderUids: [uid], to: "milespete", mode: "split_total", amount })
    });
    if (r.ok) {
      closeModal("donate-modal");
      showToast("Thank you for supporting HyperFlow! 💛", "success");
      await refreshStatus();
    } else {
      showToast(r.data.error || "Could not send tip.", "error");
    }
  });
});

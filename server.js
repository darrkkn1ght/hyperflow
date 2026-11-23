import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_TRANSFER_CHUNK = 100_000_000_000; // ₦100B LagosLife max per transfer
const CHUNK_DELAY_MS = 250;

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// In-Memory State (Workspaces + 2FA Challenges + Rate-Limit Backoff)
// ---------------------------------------------------------------------------
const workspaces = new Map(); // token -> { token, accounts: Map<uid, Account>, jobs: [] }
const pendingChallenges = new Map(); // challenge -> { token, username, interimCookies, pin, createdAt }
const laneWorkers = new Map(); // `${jobId}:${uid}` -> { paused, cancelled }
const cookieBackoffs = new Map(); // cookieKey -> { consecutive429, until }

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

const KNOWN_IDS = {
  milespete: "bc745837935d45efbf47",
  blaqsebastian: "7785cae4f157450490d5",
  bigola2823: "6e3c4bdaac6f4765ba52",
  lldc: "802ef46ea4eb4b1b8b47",
  princedavid: "7e791760cd644f13ba5a"
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getOrCreateWorkspace(token) {
  if (token && workspaces.has(token)) {
    return workspaces.get(token);
  }
  const newToken = token || `hf_${crypto.randomUUID().replace(/-/g, "")}`;
  const ws = { token: newToken, accounts: new Map(), jobs: [] };
  workspaces.set(newToken, ws);
  return ws;
}

function serializeAccount(acc) {
  return {
    uid: acc.uid,
    user: acc.user,
    name: acc.name,
    money: Number(acc.money || 0),
    hasPin: Boolean(acc.pin),
    cookie: acc.cookie,
    status: acc.status || "ACTIVE",
    lastSyncedAt: acc.lastSyncedAt || Date.now()
  };
}

function serializeJob(job) {
  return {
    id: job.id,
    type: job.type,
    mode: job.mode,
    target: job.target,
    targetLabel: job.targetLabel,
    originalInput: job.originalInput,
    total: job.total,
    remaining: job.remaining,
    txCount: job.txCount,
    totalTxs: job.totalTxs,
    status: job.status,
    scheduledTimestamp: job.scheduledTimestamp || null,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    estimatedFinishAt: job.estimatedFinishAt || null,
    estimatedRemainingMs: job.estimatedRemainingMs ?? null,
    lanes: job.lanes.map((l) => ({
      uid: l.uid,
      user: l.user,
      name: l.name,
      total: l.total,
      remaining: l.remaining,
      txCount: l.txCount,
      totalTxs: l.totalTxs,
      status: l.status,
      needsTwoStep: Boolean(l.needsTwoStep),
      twoStepType: l.twoStepType || null,
      avgChunkMs: l.avgChunkMs || null,
      estimatedFinishAt: l.estimatedFinishAt || null,
      finishedAt: l.finishedAt || null,
      lastLog: l.logs[l.logs.length - 1] || ""
    })),
    logs: job.logs.slice(-10)
  };
}

function parseAmount(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.floor(raw) : 0;
  const cleaned = String(raw || "").trim().toLowerCase().replace(/[₦,\s]/g, "");
  if (!cleaned) return 0;
  const m = cleaned.match(/^(\d+(?:\.\d+)?)([kmbtq]?)$/);
  if (!m) return 0;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num <= 0) return 0;
  const mult = { "": 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 };
  return Math.floor(num * (mult[m[2]] || 1));
}

function mergeCookies(existing, incomingList) {
  const map = new Map();
  for (const part of String(existing || "").split(";")) {
    const t = part.trim();
    const eq = t.indexOf("=");
    if (eq > 0) map.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
  }
  for (const part of incomingList || []) {
    const t = String(part || "").split(";")[0].trim();
    const eq = t.indexOf("=");
    if (eq > 0) map.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function extractSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie().map((c) => c.split(";")[0]);
  }
  const raw = headers.get("set-cookie");
  return raw ? [raw.split(";")[0]] : [];
}

async function fetchAccountIdentityAndBalance(cookie) {
  const headers = { cookie, accept: "application/json", "user-agent": UA };
  const [meRes, saveRes] = await Promise.all([
    fetch("https://lagoslife.app/api/auth/me", { headers }),
    fetch("https://lagoslife.app/api/save", { headers })
  ]);
  const meData = await meRes.json().catch(() => ({}));
  const saveData = await saveRes.json().catch(() => ({}));
  const user = meData.user || null;
  if (!user || !user.id) {
    return { ok: false, status: meRes.status || 401 };
  }
  const money = Number(saveData.game?.money ?? 0);
  return {
    ok: true,
    uid: user.id,
    user: user.username || user.id,
    name: user.name || user.username || user.id,
    money: Number.isFinite(money) ? money : 0
  };
}

async function resolveTarget(input, cookie) {
  const trimmed = String(input || "").trim().replace(/^@/, "");
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/[?&](?:with|host|of)=([a-f0-9]{16,})/i)
    || trimmed.match(/lagoslife\.app\/.*?([a-f0-9]{16,})/i);
  if (urlMatch) return { id: urlMatch[1].toLowerCase(), username: urlMatch[1].toLowerCase() };
  if (/^[a-f0-9]{20}$/i.test(trimmed)) return { id: trimmed.toLowerCase(), username: trimmed.toLowerCase() };

  const clean = trimmed.toLowerCase();
  if (KNOWN_IDS[clean]) return { id: KNOWN_IDS[clean], username: clean };

  try {
    const res = await fetch(`https://lagoslife.app/api/players?q=${encodeURIComponent(clean)}`, {
      headers: { accept: "application/json", cookie: cookie || "", "user-agent": UA }
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const list = data.players || [];
      const exact = list.find((p) => (p.username || "").toLowerCase().replace(/^@/, "") === clean);
      if (exact) return { id: exact.id, username: exact.username, name: exact.name };
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Vault Authentication & Account Management Routes
// ---------------------------------------------------------------------------
app.post("/api/vault/login", async (req, res) => {
  const rawToken = req.headers["x-client-token"] || req.body?.token || null;
  const { username, password, pin } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required." });
  }
  const cleanUser = String(username).trim().replace(/^@/, "");
  const ws = getOrCreateWorkspace(rawToken);

  try {
    const loginRes = await fetch("https://lagoslife.app/api/auth/login", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://lagoslife.app",
        referer: "https://lagoslife.app/",
        "user-agent": UA
      },
      body: JSON.stringify({ username: cleanUser, password })
    });
    const loginData = await loginRes.json().catch(() => ({}));
    const setCookies = extractSetCookies(loginRes.headers);

    if (loginData.code === "two_factor" || loginData.challenge) {
      const interimCookies = setCookies.join("; ");
      if (loginData.challenge) {
        pendingChallenges.set(loginData.challenge, {
          token: ws.token,
          username: cleanUser,
          interimCookies,
          pin: pin ? String(pin).trim() : null,
          createdAt: Date.now()
        });
      }
      return res.json({
        token: ws.token,
        twoFactorRequired: true,
        challenge: loginData.challenge,
        method: loginData.method || "app",
        to: loginData.to || null
      });
    }

    if (!loginRes.ok) {
      return res.status(loginRes.status).json({ error: loginData.error || "Invalid LagosLife credentials." });
    }

    const cookieStr = setCookies.join("; ");
    const info = await fetchAccountIdentityAndBalance(cookieStr);
    if (!info.ok) {
      return res.status(401).json({ error: "Failed to verify LagosLife session after login." });
    }

    const account = {
      uid: info.uid,
      user: info.user,
      name: info.name,
      money: info.money,
      cookie: cookieStr,
      pin: pin ? String(pin).trim() : (ws.accounts.get(info.uid)?.pin || null),
      twoStepCode: null,
      status: "ACTIVE",
      lastSyncedAt: Date.now()
    };
    ws.accounts.set(account.uid, account);

    res.json({
      success: true,
      token: ws.token,
      account: serializeAccount(account),
      accounts: [...ws.accounts.values()].map(serializeAccount)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/vault/2fa", async (req, res) => {
  const { challenge, code } = req.body || {};
  if (!challenge || !code) {
    return res.status(400).json({ error: "Challenge and 6-digit code required." });
  }
  const pending = pendingChallenges.get(challenge);
  if (!pending) {
    return res.status(400).json({ error: "2FA challenge expired. Please sign in again." });
  }

  try {
    const twoFaRes = await fetch("https://lagoslife.app/api/auth/2fa", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://lagoslife.app",
        referer: "https://lagoslife.app/",
        "user-agent": UA,
        ...(pending.interimCookies ? { cookie: pending.interimCookies } : {})
      },
      body: JSON.stringify({ action: "login", challenge, code: String(code).trim().toUpperCase() })
    });
    const twoFaData = await twoFaRes.json().catch(() => ({}));
    if (!twoFaRes.ok) {
      return res.status(twoFaRes.status).json({ error: twoFaData.error || "Invalid 2FA code." });
    }

    const cookieStr = mergeCookies(pending.interimCookies, extractSetCookies(twoFaRes.headers));
    pendingChallenges.delete(challenge);

    const info = await fetchAccountIdentityAndBalance(cookieStr);
    if (!info.ok) {
      return res.status(401).json({ error: "Could not load account after 2FA." });
    }

    const ws = getOrCreateWorkspace(pending.token);
    const account = {
      uid: info.uid,
      user: info.user,
      name: info.name,
      money: info.money,
      cookie: cookieStr,
      pin: pending.pin || ws.accounts.get(info.uid)?.pin || null,
      twoStepCode: null,
      status: "ACTIVE",
      lastSyncedAt: Date.now()
    };
    ws.accounts.set(account.uid, account);

    res.json({
      success: true,
      token: ws.token,
      account: serializeAccount(account),
      accounts: [...ws.accounts.values()].map(serializeAccount)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/vault/2fa/resend", async (req, res) => {
  const { challenge } = req.body || {};
  if (!challenge) return res.status(400).json({ error: "Challenge required." });
  try {
    const r = await fetch("https://lagoslife.app/api/auth/2fa", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://lagoslife.app",
        referer: "https://lagoslife.app/",
        "user-agent": UA
      },
      body: JSON.stringify({ action: "resend", challenge })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: d.error || "Could not resend code." });
    res.json({ ok: true, to: d.to || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/vault/import-cookie", async (req, res) => {
  const rawToken = req.headers["x-client-token"] || req.body?.token || null;
  const { cookie, pin } = req.body || {};
  if (!cookie || !String(cookie).trim()) {
    return res.status(400).json({ error: "Cookie string required." });
  }
  const cleanCookie = String(cookie).trim();
  const ws = getOrCreateWorkspace(rawToken);

  try {
    const info = await fetchAccountIdentityAndBalance(cleanCookie);
    if (!info.ok) {
      return res.status(401).json({ error: "Cookie is invalid or expired." });
    }
    const account = {
      uid: info.uid,
      user: info.user,
      name: info.name,
      money: info.money,
      cookie: cleanCookie,
      pin: pin ? String(pin).trim() : (ws.accounts.get(info.uid)?.pin || null),
      twoStepCode: null,
      status: "ACTIVE",
      lastSyncedAt: Date.now()
    };
    ws.accounts.set(account.uid, account);

    res.json({
      success: true,
      token: ws.token,
      account: serializeAccount(account),
      accounts: [...ws.accounts.values()].map(serializeAccount)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/vault/restore", async (req, res) => {
  const rawToken = req.headers["x-client-token"] || req.body?.token || null;
  const { presets } = req.body || {};
  const ws = getOrCreateWorkspace(rawToken);

  if (!Array.isArray(presets) || presets.length === 0) {
    return res.json({
      token: ws.token,
      restored: 0,
      expired: [],
      accounts: [...ws.accounts.values()].map(serializeAccount)
    });
  }

  const expired = [];
  let restored = 0;

  await Promise.all(
    presets.map(async (item) => {
      if (!item?.cookie) return;
      try {
        const info = await fetchAccountIdentityAndBalance(String(item.cookie).trim());
        if (!info.ok) {
          expired.push(item.user || "unknown");
          return;
        }
        const acc = {
          uid: info.uid,
          user: info.user,
          name: info.name,
          money: info.money,
          cookie: String(item.cookie).trim(),
          pin: item.pin ? String(item.pin).trim() : (ws.accounts.get(info.uid)?.pin || null),
          twoStepCode: null,
          status: "ACTIVE",
          lastSyncedAt: Date.now()
        };
        ws.accounts.set(acc.uid, acc);
        restored++;
      } catch {
        expired.push(item.user || "unknown");
      }
    })
  );

  res.json({
    token: ws.token,
    restored,
    expired,
    accounts: [...ws.accounts.values()].map(serializeAccount)
  });
});

app.post("/api/vault/pin", (req, res) => {
  const token = req.headers["x-client-token"];
  if (!token || !workspaces.has(token)) return res.status(401).json({ error: "Unauthenticated" });
  const ws = workspaces.get(token);
  const { uid, pin } = req.body || {};
  const acc = ws.accounts.get(uid);
  if (!acc) return res.status(404).json({ error: "Account not found." });
  acc.pin = pin ? String(pin).trim() : null;
  res.json({ success: true, account: serializeAccount(acc) });
});

app.post("/api/vault/remove", (req, res) => {
  const token = req.headers["x-client-token"];
  if (!token || !workspaces.has(token)) return res.status(401).json({ error: "Unauthenticated" });
  const ws = workspaces.get(token);
  const { uid } = req.body || {};
  if (uid === "__all__") {
    ws.accounts.clear();
  } else if (uid) {
    ws.accounts.delete(uid);
  }
  res.json({ success: true, accounts: [...ws.accounts.values()].map(serializeAccount) });
});

app.post("/api/vault/refresh", async (req, res) => {
  const token = req.headers["x-client-token"];
  if (!token || !workspaces.has(token)) return res.status(401).json({ error: "Unauthenticated" });
  const ws = workspaces.get(token);
  await Promise.all(
    [...ws.accounts.values()].map(async (acc) => {
      try {
        const info = await fetchAccountIdentityAndBalance(acc.cookie);
        if (info.ok) {
          acc.money = info.money;
          acc.status = "ACTIVE";
          acc.lastSyncedAt = Date.now();
        } else if (info.status === 401) {
          acc.status = "EXPIRED";
        }
      } catch {}
    })
  );
  res.json({ accounts: [...ws.accounts.values()].map(serializeAccount) });
});

app.get("/api/vault/status", (req, res) => {
  const token = req.headers["x-client-token"] || req.query.token;
  if (!token || !workspaces.has(token)) {
    return res.status(401).json({ error: "Session not found" });
  }
  const ws = workspaces.get(token);
  res.json({
    accounts: [...ws.accounts.values()].map(serializeAccount),
    jobs: ws.jobs.map(serializeJob)
  });
});

// ---------------------------------------------------------------------------
// Parallel Multi-Pipeline Transfer Engine
// ---------------------------------------------------------------------------
function updateMasterJobProgress(job) {
  let remaining = 0;
  let txCount = 0;
  let totalTxs = 0;
  let anyRunning = false;
  let anyPaused = false;
  let allDone = true;
  let maxFinishAt = 0;

  for (const lane of job.lanes) {
    remaining += Math.max(0, lane.remaining);
    txCount += lane.txCount;
    totalTxs += lane.totalTxs;
    if (lane.status === "RUNNING") {
      anyRunning = true;
      allDone = false;
      if (lane.estimatedFinishAt && lane.estimatedFinishAt > maxFinishAt) {
        maxFinishAt = lane.estimatedFinishAt;
      }
    } else if (lane.status === "PAUSED") {
      anyPaused = true;
      allDone = false;
      if (lane.estimatedFinishAt && lane.estimatedFinishAt > maxFinishAt) {
        maxFinishAt = lane.estimatedFinishAt;
      }
    } else if (lane.status === "SCHEDULED") {
      allDone = false;
    }
  }

  job.remaining = remaining;
  job.txCount = txCount;
  job.totalTxs = totalTxs;

  if (job.status === "CANCELLED") return;

  if (allDone && remaining === 0) {
    job.status = "COMPLETED";
    job.finishedAt = job.finishedAt || Date.now();
    job.estimatedRemainingMs = 0;
    job.estimatedFinishAt = job.finishedAt;
  } else if (anyRunning) {
    job.status = "RUNNING";
    job.estimatedFinishAt = maxFinishAt || Date.now();
    job.estimatedRemainingMs = Math.max(0, job.estimatedFinishAt - Date.now());
  } else if (anyPaused) {
    job.status = "PAUSED";
    job.estimatedFinishAt = maxFinishAt || Date.now();
    job.estimatedRemainingMs = Math.max(0, job.estimatedFinishAt - Date.now());
  }
}

function recordLaneTiming(job, lane) {
  const now = Date.now();
  if (lane._lastChunkAt) {
    const dt = Math.min(Math.max(now - lane._lastChunkAt, 150), 15000);
    lane.avgChunkMs = lane.avgChunkMs ? Math.round(lane.avgChunkMs * 0.7 + dt * 0.3) : dt;
  }
  lane._lastChunkAt = now;
  const remTxs = Math.max(0, lane.totalTxs - lane.txCount);
  const perTxMs = lane.avgChunkMs || (CHUNK_DELAY_MS + 450);
  lane.estimatedFinishAt = remTxs > 0 ? now + remTxs * perTxMs : now;
  updateMasterJobProgress(job);
}

async function sendChunk(cookie, toId, amount, pin) {
  const key = cookie.slice(0, 48);
  const b = cookieBackoffs.get(key);
  if (b && b.until > Date.now()) {
    await sleep(b.until - Date.now());
  }
  const payload = { action: "send", to: toId, amount };
  if (pin) payload.pin = pin;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch("https://lagoslife.app/api/bank", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        accept: "application/json",
        origin: "https://lagoslife.app",
        referer: "https://lagoslife.app/",
        "user-agent": UA
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    if (res.status === 200) {
      cookieBackoffs.delete(key);
    } else if (res.status === 429) {
      const prev = cookieBackoffs.get(key) || { consecutive429: 0, until: 0 };
      prev.consecutive429 += 1;
      let waitMs = 0;
      const numeric = Number(data?.retryIn || data?.wait || data?.retryAfter || data?.cooldown || 0);
      if (numeric > 0) {
        waitMs = numeric < 120 ? numeric * 1000 : numeric;
      } else {
        const msg = String(data?.error || data?.message || "");
        const secMatch = msg.match(/(\d+(?:\.\d+)?)\s*(?:s|sec)/i);
        if (secMatch) waitMs = Math.ceil(parseFloat(secMatch[1]) * 1000);
      }
      if (!waitMs) {
        waitMs = Math.min(2000 * prev.consecutive429, 15000);
      }
      prev.until = Date.now() + waitMs;
      cookieBackoffs.set(key, prev);
      return { status: 429, data, waitMs };
    }
    return { status: res.status, data };
  } catch (err) {
    clearTimeout(timer);
    return { status: 0, error: err.message };
  }
}

function runPipelineLane(job, lane, account) {
  const workerKey = `${job.id}:${lane.uid}`;
  if (laneWorkers.has(workerKey)) return;

  const state = { paused: false, cancelled: false };
  laneWorkers.set(workerKey, state);
  lane.status = "RUNNING";
  lane._lastChunkAt = Date.now();
  lane.estimatedFinishAt = Date.now() + Math.max(0, lane.totalTxs - lane.txCount) * (lane.avgChunkMs || 700);
  updateMasterJobProgress(job);

  (async () => {
    try {
      while (lane.remaining > 0 && !state.cancelled) {
        if (state.paused) {
          await sleep(800);
          continue;
        }

        const sendAmt = Math.min(lane.remaining, MAX_TRANSFER_CHUNK);
        const effectivePin = lane.pin || account.pin || job.globalPin || null;
        const r = await sendChunk(account.cookie, job.target, sendAmt, effectivePin);

        if (r.status === 200) {
          lane.remaining = Math.max(0, lane.remaining - sendAmt);
          lane.txCount += 1;
          account.money = Math.max(0, Number(account.money || 0) - sendAmt);
          recordLaneTiming(job, lane);

          const msg = `@${lane.user} [${lane.txCount}/${lane.totalTxs}] Sent ₦${sendAmt.toLocaleString()} ✅`;
          lane.logs.push(msg);
          job.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
          if (job.logs.length > 60) job.logs.shift();

          if (lane.remaining > 0 && !state.cancelled) {
            await sleep(CHUNK_DELAY_MS);
          }
        } else if (r.status === 429) {
          lane.logs.push(`Rate limited — cooling down ${Math.ceil((r.waitMs || 3000) / 1000)}s`);
          await sleep(r.waitMs || 3000);
        } else {
          const errMsg = r.data?.error || r.data?.message || r.error || `HTTP ${r.status}`;
          const lower = String(errMsg).toLowerCase();

          if (lower.includes("pin") || lower.includes("passcode")) {
            lane.status = "PAUSED";
            lane.needsTwoStep = true;
            lane.twoStepType = "pin";
            if (lower.includes("incorrect") || lower.includes("invalid") || lower.includes("wrong")) {
              lane.pin = null;
              account.pin = null;
            }
            lane.logs.push(`PIN required: ${errMsg}`);
            job.logs.push(`[${new Date().toLocaleTimeString()}] 🔒 @${lane.user}: ${errMsg}`);
            updateMasterJobProgress(job);
            return;
          }

          if (
            lower.includes("two-step") ||
            lower.includes("two step") ||
            lower.includes("2fa") ||
            lower.includes("verification") ||
            lower.includes("challenge")
          ) {
            lane.status = "PAUSED";
            lane.needsTwoStep = true;
            lane.twoStepType = "2fa";
            lane.logs.push(`2FA required: ${errMsg}`);
            job.logs.push(`[${new Date().toLocaleTimeString()}] 🛡️ @${lane.user}: ${errMsg}`);
            updateMasterJobProgress(job);
            return;
          }

          if (lower.includes("insufficient") || lower.includes("balance") || lower.includes("funds")) {
            lane.status = "FAILED";
            lane.logs.push(`Insufficient funds: ${errMsg}`);
            job.logs.push(`[${new Date().toLocaleTimeString()}] ❌ @${lane.user}: ${errMsg}`);
            updateMasterJobProgress(job);
            return;
          }

          lane.logs.push(`Retrying (${errMsg})...`);
          await sleep(4000);
        }
      }

      if (state.cancelled) {
        lane.status = "CANCELLED";
      } else if (lane.remaining === 0) {
        lane.status = "COMPLETED";
        lane.finishedAt = Date.now();
        lane.logs.push(`Completed ₦${lane.total.toLocaleString()} ✅`);
        job.logs.push(`[${new Date().toLocaleTimeString()}] 🎉 @${lane.user} finished ₦${lane.total.toLocaleString()}!`);
      }
      updateMasterJobProgress(job);
    } finally {
      laneWorkers.delete(workerKey);
    }
  })();
}

app.post("/api/pipeline/send", async (req, res) => {
  const token = req.headers["x-client-token"];
  if (!token || !workspaces.has(token)) return res.status(401).json({ error: "Unauthenticated" });
  const ws = workspaces.get(token);

  const { senderUids, to, mode = "split_total", amount, pin, scheduledAt } = req.body || {};
  if (!to) return res.status(400).json({ error: "Recipient username required." });

  const selectedAccounts = (Array.isArray(senderUids) && senderUids.length > 0
    ? senderUids.map((id) => ws.accounts.get(id)).filter(Boolean)
    : [...ws.accounts.values()]
  ).filter((a) => a.status !== "EXPIRED");

  if (selectedAccounts.length === 0) {
    return res.status(400).json({ error: "Select at least one active sender account." });
  }

  // Resolve target using first active account cookie
  const resolved = await resolveTarget(to, selectedAccounts[0].cookie);
  if (!resolved || !resolved.id) {
    return res.status(400).json({ error: `Player '${to}' could not be found.` });
  }

  // Filter out self-transfer if target is one of the selected accounts
  const eligible = selectedAccounts.filter((a) => a.uid !== resolved.id);
  if (eligible.length === 0) {
    return res.status(400).json({ error: "Cannot send to the same account as the only sender." });
  }

  // Refresh live balances of eligible accounts before splitting
  await Promise.all(
    eligible.map(async (acc) => {
      const info = await fetchAccountIdentityAndBalance(acc.cookie).catch(() => ({ ok: false }));
      if (info.ok) acc.money = info.money;
    })
  );

  const allocations = [];
  if (mode === "drain") {
    for (const acc of eligible) {
      const amt = Math.floor(acc.money || 0);
      if (amt > 0) allocations.push({ acc, amount: amt });
    }
    if (allocations.length === 0) {
      return res.status(400).json({ error: "Selected accounts have ₦0 available balance." });
    }
  } else if (mode === "per_account") {
    const perAmt = parseAmount(amount);
    if (perAmt <= 0) return res.status(400).json({ error: "Enter a valid amount per account." });
    for (const acc of eligible) {
      if (acc.money >= perAmt) {
        allocations.push({ acc, amount: perAmt });
      }
    }
    if (allocations.length === 0) {
      return res.status(400).json({ error: "None of the selected accounts have enough balance for that amount." });
    }
  } else {
    // split_total (smart proportional/greedy allocation across selected senders)
    const totalTarget = parseAmount(amount);
    if (totalTarget <= 0) return res.status(400).json({ error: "Enter a valid total transfer amount." });
    const totalAvail = eligible.reduce((s, a) => s + Math.floor(a.money || 0), 0);
    if (totalAvail < totalTarget) {
      return res.status(400).json({
        error: `Selected accounts have ₦${totalAvail.toLocaleString()} combined, which is less than ₦${totalTarget.toLocaleString()}.`
      });
    }

    // Sort highest balance first and split evenly/greedily capped by each balance
    const sorted = [...eligible].filter((a) => a.money > 0).sort((a, b) => b.money - a.money);
    let rem = totalTarget;
    const mapAmt = new Map(sorted.map((a) => [a.uid, 0]));

    // Round-robin balanced fill so parallel lanes finish around the same time
    while (rem > 0) {
      const active = sorted.filter((a) => Math.floor(a.money) - mapAmt.get(a.uid) > 0);
      if (active.length === 0) break;
      const share = Math.max(1, Math.floor(rem / active.length));
      let progressed = false;
      for (const a of active) {
        if (rem <= 0) break;
        const cap = Math.floor(a.money) - mapAmt.get(a.uid);
        const take = Math.min(cap, share, rem);
        if (take > 0) {
          mapAmt.set(a.uid, mapAmt.get(a.uid) + take);
          rem -= take;
          progressed = true;
        }
      }
      if (!progressed) {
        // Handle remainder < active.length
        for (const a of active) {
          if (rem <= 0) break;
          const cap = Math.floor(a.money) - mapAmt.get(a.uid);
          if (cap > 0) {
            mapAmt.set(a.uid, mapAmt.get(a.uid) + 1);
            rem -= 1;
          }
        }
      }
    }

    for (const a of sorted) {
      const amt = mapAmt.get(a.uid) || 0;
      if (amt > 0) allocations.push({ acc: a, amount: amt });
    }
  }

  let isScheduled = false;
  let scheduledTimestamp = null;
  if (scheduledAt) {
    const ms = new Date(scheduledAt).getTime();
    if (!Number.isNaN(ms) && ms > Date.now()) {
      isScheduled = true;
      scheduledTimestamp = ms;
    }
  }

  const jobId = `hf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const targetLabel = resolved.name ? `${resolved.name} (@${resolved.username})` : `@${resolved.username}`;
  const cleanGlobalPin = pin ? String(pin).trim() : null;

  const lanes = allocations.map(({ acc, amount: amt }) => {
    const totalTxs = Math.ceil(amt / MAX_TRANSFER_CHUNK);
    return {
      uid: acc.uid,
      user: acc.user,
      name: acc.name,
      total: amt,
      remaining: amt,
      txCount: 0,
      totalTxs,
      pin: acc.pin || cleanGlobalPin || null,
      status: isScheduled ? "SCHEDULED" : "RUNNING",
      needsTwoStep: false,
      twoStepType: null,
      avgChunkMs: null,
      estimatedFinishAt: isScheduled ? scheduledTimestamp + totalTxs * 700 : Date.now() + totalTxs * 700,
      finishedAt: null,
      logs: [`Queued ₦${amt.toLocaleString()} (${totalTxs} chunks)`]
    };
  });

  const totalAmount = lanes.reduce((s, l) => s + l.total, 0);
  const totalTxs = lanes.reduce((s, l) => s + l.totalTxs, 0);

  const job = {
    id: jobId,
    type: "pipeline",
    mode,
    target: resolved.id,
    targetLabel,
    originalInput: to,
    globalPin: cleanGlobalPin,
    total: totalAmount,
    remaining: totalAmount,
    txCount: 0,
    totalTxs,
    status: isScheduled ? "SCHEDULED" : "RUNNING",
    scheduledTimestamp,
    startedAt: isScheduled ? null : Date.now(),
    finishedAt: null,
    estimatedFinishAt: Math.max(...lanes.map((l) => l.estimatedFinishAt || Date.now())),
    estimatedRemainingMs: null,
    lanes,
    logs: [
      `[${new Date().toLocaleTimeString()}] ⚡ Pipeline initialized: ₦${totalAmount.toLocaleString()} to ${targetLabel} across ${lanes.length} sender(s)`
    ]
  };

  ws.jobs.unshift(job);

  if (!isScheduled) {
    for (const lane of job.lanes) {
      const acc = ws.accounts.get(lane.uid);
      if (acc) runPipelineLane(job, lane, acc);
    }
  }

  res.json({ success: true, job: serializeJob(job) });
});

app.post("/api/pipeline/lane-resume", async (req, res) => {
  const token = req.headers["x-client-token"];
  if (!token || !workspaces.has(token)) return res.status(401).json({ error: "Unauthenticated" });
  const ws = workspaces.get(token);

  const { jobId, uid, code } = req.body || {};
  const job = ws.jobs.find((j) => j.id === jobId);
  if (!job) return res.status(404).json({ error: "Job not found." });
  const lane = job.lanes.find((l) => l.uid === uid);
  const acc = ws.accounts.get(uid);
  if (!lane || !acc) return res.status(404).json({ error: "Sender lane not found." });

  const cleanCode = String(code || "").trim();
  if (!cleanCode) return res.status(400).json({ error: "Code or PIN required." });

  if (lane.twoStepType === "2fa") {
    try {
      const twoFaRes = await fetch("https://lagoslife.app/api/auth/2fa", {
        method: "POST",
        headers: {
          cookie: acc.cookie,
          "content-type": "application/json",
          origin: "https://lagoslife.app",
          referer: "https://lagoslife.app/",
          "user-agent": UA
        },
        body: JSON.stringify({ action: "step", code: cleanCode })
      });
      const twoFaData = await twoFaRes.json().catch(() => ({}));
      if (!twoFaRes.ok) {
        return res.status(400).json({ error: twoFaData.error || "Invalid 2FA code." });
      }
      const newCookies = extractSetCookies(twoFaRes.headers);
      if (newCookies.length) acc.cookie = mergeCookies(acc.cookie, newCookies);
      job.logs.push(`[${new Date().toLocaleTimeString()}] 🛡️ @${lane.user} 2FA verified ✅`);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    lane.pin = cleanCode;
    acc.pin = cleanCode;
    job.logs.push(`[${new Date().toLocaleTimeString()}] 🔒 @${lane.user} PIN saved ✅`);
  }

  lane.needsTwoStep = false;
  lane.twoStepType = null;
  runPipelineLane(job, lane, acc);
  res.json({ success: true, job: serializeJob(job) });
});

app.post("/api/pipeline/start-now", (req, res) => {
  const token = req.headers["x-client-token"];
  if (!token || !workspaces.has(token)) return res.status(401).json({ error: "Unauthenticated" });
  const ws = workspaces.get(token);
  const job = ws.jobs.find((j) => j.id === req.body?.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  job.status = "RUNNING";
  job.scheduledTimestamp = null;
  job.startedAt = Date.now();
  for (const lane of job.lanes) {
    if (lane.remaining > 0) {
      const acc = ws.accounts.get(lane.uid);
      if (acc) runPipelineLane(job, lane, acc);
    }
  }
  res.json({ success: true, job: serializeJob(job) });
});

app.post("/api/pipeline/pause", (req, res) => {
  const token = req.headers["x-client-token"];
  if (!token || !workspaces.has(token)) return res.status(401).json({ error: "Unauthenticated" });
  const ws = workspaces.get(token);
  const job = ws.jobs.find((j) => j.id === req.body?.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  for (const lane of job.lanes) {
    if (lane.status === "RUNNING") {
      lane.status = "PAUSED";
      const w = laneWorkers.get(`${job.id}:${lane.uid}`);
      if (w) w.paused = true;
    }
  }
  job.status = "PAUSED";
  res.json({ success: true, job: serializeJob(job) });
});

app.post("/api/pipeline/resume", (req, res) => {
  const token = req.headers["x-client-token"];
  if (!token || !workspaces.has(token)) return res.status(401).json({ error: "Unauthenticated" });
  const ws = workspaces.get(token);
  const job = ws.jobs.find((j) => j.id === req.body?.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  for (const lane of job.lanes) {
    if (lane.remaining > 0 && lane.status === "PAUSED" && !lane.needsTwoStep) {
      const w = laneWorkers.get(`${job.id}:${lane.uid}`);
      if (w) {
        w.paused = false;
        lane.status = "RUNNING";
      } else {
        const acc = ws.accounts.get(lane.uid);
        if (acc) runPipelineLane(job, lane, acc);
      }
    }
  }
  updateMasterJobProgress(job);
  res.json({ success: true, job: serializeJob(job) });
});

app.post("/api/pipeline/stop", (req, res) => {
  const token = req.headers["x-client-token"];
  if (!token || !workspaces.has(token)) return res.status(401).json({ error: "Unauthenticated" });
  const ws = workspaces.get(token);
  const job = ws.jobs.find((j) => j.id === req.body?.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  job.status = "CANCELLED";
  for (const lane of job.lanes) {
    if (lane.status !== "COMPLETED") lane.status = "CANCELLED";
    const w = laneWorkers.get(`${job.id}:${lane.uid}`);
    if (w) w.cancelled = true;
  }
  res.json({ success: true, job: serializeJob(job) });
});

app.post("/api/pipeline/dismiss", (req, res) => {
  const token = req.headers["x-client-token"];
  if (!token || !workspaces.has(token)) return res.status(401).json({ error: "Unauthenticated" });
  const ws = workspaces.get(token);
  ws.jobs = ws.jobs.filter((j) => j.id !== req.body?.jobId);
  res.json({ success: true });
});

// Scheduled job ticker
setInterval(() => {
  const now = Date.now();
  for (const ws of workspaces.values()) {
    for (const job of ws.jobs) {
      if (job.status === "SCHEDULED" && job.scheduledTimestamp && now >= job.scheduledTimestamp) {
        job.status = "RUNNING";
        job.scheduledTimestamp = null;
        job.startedAt = now;
        for (const lane of job.lanes) {
          if (lane.remaining > 0) {
            const acc = ws.accounts.get(lane.uid);
            if (acc) runPipelineLane(job, lane, acc);
          }
        }
      }
    }
  }
}, 1000);

app.listen(PORT, () => {
  console.log(`⚡ HyperFlow running on http://localhost:${PORT}`);
});

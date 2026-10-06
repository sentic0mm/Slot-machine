// Serverseitige Spins: Der Worker würfelt, rechnet den Gewinn aus und
// verwaltet den Kontostand. Der Browser zeigt das Ergebnis nur noch an.
// Damit gibt es nichts mehr, was ein Client "melden" könnte - weder den
// Kontostand noch den Rangliste-Rekord noch das Geld im Multiplayer.
//
//   POST /spin        { token, mode, bet, count? }       Solo-Spins (Online-Konto)
//   POST /balance     { token }                   Kontostände aller Modi
//   POST /wallet/reset { token, mode }            "Geld zurücksetzen" -> 10$
//   POST /mp/start    { token, code }             Host startet die Runde
//   POST /mp/spin     { token, code, pid, bet, count? }  Spins in einer Lobby-Runde
//
// count > 1: Der Worker würfelt alle Spins auf einmal (eine Anfrage) und
// schickt die Liste zurück; die Seite spielt nur noch die Animationen ab.
// Hört von selbst auf, wenn das Geld nicht mehr reicht.
//
// Freigabe nach Zeit (Solo): Die Gewinne einer Serie werden NICHT sofort
// gutgeschrieben, sondern ein Spin pro SPIN_STEP_MS - so schnell, wie die
// Animation sie zeigt. Wer mittendrin neu lädt, hat nur das Geld der schon
// "gelaufenen" Spins; der Rest läuft im Hintergrund weiter, und bis die Serie
// fertig ist, gibt es keine neuen Spins. Gespeichert unter
// walletSync/<uid>/pending/<mode> = { start, step, base, balances[] }.
//
// Kontostände: walletSync/<uid>/<mode> (für Clients gesperrt).
// Lobby-Geld: lobbies/<code>/players/<pid>/money (für Clients gesperrt).

import { spin, cents, START_MONEY, MODE_CFG } from "./game.js";

const MODES = Object.keys(MODE_CFG);
const MAX_RETRIES = 4;
const MP_GRACE_MS = 3000; // Spins, die kurz vor Rundenende losgingen
const MAX_BATCH = 100;    // höchstens so viele Spins pro Anfrage
const SPIN_STEP_MS = 1500; // Freigabe-Takt: ein Spin pro 1,5 s (Animation dauert länger)
const MP_SPIN_MS = SPIN_STEP_MS;

const num = (v) => v === null || v === undefined ? START_MONEY : Number(v);

// Wie viel einer laufenden Serie ist schon freigegeben? Rein rechnerisch,
// ändert w nur, wenn final=true und die Serie komplett durch ist.
export function settleMode(w, mode, now, final) {
  const p = w && w.pending && w.pending[mode];
  // Firebase liefert Listen manchmal als Objekt {"0":…, "1":…} zurück
  const bals = !p || !p.balances ? [] : Array.isArray(p.balances) ? p.balances
    : Object.keys(p.balances).sort((a, b) => a - b).map(k => p.balances[k]);
  if (!bals.length) {
    return { balance: num(w && w[mode]), waitMs: 0, peak: null, done: false };
  }
  const n = bals.length;
  const k = Math.floor((now - p.start) / p.step);
  if (k >= n) {
    const last = Number(bals[n - 1]);
    if (final) { w[mode] = last; delete w.pending[mode]; }
    return { balance: last, waitMs: 0, peak: Math.max(...bals), done: true };
  }
  return {
    balance: k > 0 ? Number(bals[k - 1]) : Number(p.base),
    waitMs: p.start + n * p.step - now,
    peak: k > 0 ? Math.max(...bals.slice(0, k)) : null,
    done: false
  };
}

// Freigegebene Kontostände aller Modi (für /balance und den Login)
export function effectiveBalances(w, now) {
  const out = {};
  for (const m of MODES) out[m] = settleMode(w || {}, m, now || Date.now(), false).balance;
  return out;
}

export function makeSpinHandlers(deps) {
  const { fbGet, fbGetEtag, fbPut, fbPatch, jsonResponse, readJson, verifyToken } = deps;
  const enc = (s) => encodeURIComponent(s);

  // Gebannte Accounts (banned/<uid>, setzt das Admin-Panel) dürfen nicht
  // mehr spinnen - ihr altes Token zählt dann als ungültig.
  async function auth(body, env) {
    const p = await verifyToken(body.token, env.WORKER_SECRET);
    if (!p) return null;
    if (await fbGet(env, "banned/" + enc(p.uid) + ".json")) return null;
    return p.uid;
  }
  function parseCount(v, max) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : 1;
  }
  function parseBet(v) {
    const bet = cents(Number(v));
    return Number.isFinite(bet) && bet > 0 ? bet : null;
  }

  // Kontostand atomar ändern: fn(aktuell) -> neuer Wert oder {error}.
  // Bei gleichzeitigen Spins (zwei Tabs) wird per ETag neu versucht.
  async function atomic(env, path, init, fn) {
    for (let i = 0; i < MAX_RETRIES; i++) {
      const { value, etag } = await fbGetEtag(env, path);
      const cur = value === null || value === undefined ? init : Number(value);
      const res = fn(cur);
      if (res.error) return res;
      if (await fbPut(env, path, res.value, etag)) return res;
    }
    return { error: "busy" };
  }

  // Wie atomic, aber für einen ganzen Knoten (Objekt)
  async function atomicObj(env, path, fn) {
    for (let i = 0; i < MAX_RETRIES; i++) {
      const { value, etag } = await fbGetEtag(env, path);
      const obj = value && typeof value === "object" ? value : {};
      const res = fn(obj);
      if (res.error) return res;
      if (await fbPut(env, path, res.value, etag)) return res;
    }
    return { error: "busy" };
  }

  // Würfelt bis zu count Spins nacheinander auf den Kontostand cur
  function runBatch(cur, bet, count, mode, easy) {
    const results = [];
    for (let i = 0; i < count && cur >= bet; i++) {
      const r = spin(mode, bet, easy);
      cur = cents(cur - bet + r.win);
      results.push({ symbols: r.symbols, win: cents(r.win), jackpot: r.jackpot, balance: cur });
    }
    return { results, balance: cur };
  }
  // Antwort; symbols/win/jackpot des ersten Spins zusätzlich oben drin,
  // damit ältere Seiten (ein Spin pro Anfrage) weiter funktionieren.
  function batchResponse(batch) {
    const first = batch.results[0];
    return jsonResponse({ ok: true, symbols: first.symbols, win: first.win, jackpot: first.jackpot,
                          balance: batch.balance, results: batch.results });
  }

  // Rangliste-Rekord: nur noch hier, nie mehr vom Client
  async function noteBest(env, uid, balance) {
    const entry = await fbGet(env, "leaderboard/" + enc(uid) + ".json") || {};
    if (balance <= (Number(entry.money) || 0)) return;
    const patch = { money: balance, updatedAt: { ".sv": "timestamp" } };
    if (!entry.name) {
      const user = await fbGet(env, "users/" + enc(uid) + ".json") || {};
      patch.name = String(user.nick || user.handle || "?").slice(0, 40);
      patch.handle = "@" + String(user.handle || "").slice(0, 19);
    }
    await fbPatch(env, "leaderboard/" + enc(uid) + ".json", patch);
  }

  // ---------- Solo ----------
  async function handleSpin(request, env) {
    const body = await readJson(request);
    const uid = await auth(body, env);
    if (!uid) return jsonResponse({ ok: false, error: "invalid_token" }, 401);
    const mode = body.mode;
    if (!MODES.includes(mode)) return jsonResponse({ ok: false, error: "bad_mode" }, 400);
    const bet = parseBet(body.bet);
    if (!bet) return jsonResponse({ ok: false, error: "bad_bet" }, 400);
    const count = parseCount(body.count, MAX_BATCH);

    let batch = null, oldPeak = null;
    const res = await atomicObj(env, "walletSync/" + enc(uid) + ".json", w => {
      const now = Date.now();
      const st = settleMode(w, mode, now, true);
      if (!st.done && st.waitMs > 0) return { error: "pending", waitMs: st.waitMs, balance: st.balance };
      oldPeak = st.peak;
      const cur = st.balance;
      if (cur < bet) return { error: "insufficient", balance: cur };
      batch = runBatch(cur, bet, count, mode, false); // Online-Konten haben keinen Easy Mode
      w.pending = w.pending || {};
      w.pending[mode] = { start: now, step: SPIN_STEP_MS, base: cur, balances: batch.results.map(r => r.balance) };
      w[mode] = cur;
      return { value: w };
    });
    if (res.error) {
      const status = res.error === "busy" || res.error === "pending" ? 429 : 400;
      return jsonResponse({ ok: false, error: res.error, balance: res.balance, waitMs: res.waitMs }, status);
    }
    // Rekord der VORHERIGEN, jetzt komplett freigegebenen Serie eintragen.
    // Die neue Serie zählt erst, wenn sie gelaufen ist (/balance oder nächster Spin).
    if (oldPeak !== null) {
      try { await noteBest(env, uid, oldPeak); } catch (e) { console.log("spin " + uid + ": Rekord nicht gespeichert - " + e.message); }
    }
    return batchResponse(batch);
  }

  async function handleBalance(request, env) {
    const body = await readJson(request);
    const uid = await auth(body, env);
    if (!uid) return jsonResponse({ ok: false, error: "invalid_token" }, 401);
    const w = await fbGet(env, "walletSync/" + enc(uid) + ".json") || {};
    const now = Date.now();
    const balances = {}, waitMs = {};
    let peak = null;
    for (const m of MODES) {
      const st = settleMode(w, m, now, false);
      balances[m] = st.balance;
      if (st.waitMs > 0) waitMs[m] = st.waitMs;
      if (st.peak !== null) peak = Math.max(peak || 0, st.peak);
    }
    if (peak !== null) {
      try { await noteBest(env, uid, peak); } catch (e) {}
    }
    return jsonResponse({ ok: true, balances, waitMs });
  }

  async function handleWalletReset(request, env) {
    const body = await readJson(request);
    const uid = await auth(body, env);
    if (!uid) return jsonResponse({ ok: false, error: "invalid_token" }, 401);
    const mode = body.mode;
    if (!MODES.includes(mode)) return jsonResponse({ ok: false, error: "bad_mode" }, 400);
    const res = await atomicObj(env, "walletSync/" + enc(uid) + ".json", w => {
      const st = settleMode(w, mode, Date.now(), true);
      if (!st.done && st.waitMs > 0) return { error: "pending", waitMs: st.waitMs };
      w[mode] = START_MONEY;
      return { value: w };
    });
    if (res.error) return jsonResponse({ ok: false, error: res.error, waitMs: res.waitMs }, 429);
    return jsonResponse({ ok: true, balance: START_MONEY });
  }

  // ---------- Multiplayer ----------
  async function handleMpStart(request, env) {
    const body = await readJson(request);
    const uid = await auth(body, env);
    if (!uid) return jsonResponse({ ok: false, error: "invalid_token" }, 401);
    const code = String(body.code || "");
    if (!/^[A-Z0-9]{5}$/.test(code)) return jsonResponse({ ok: false, error: "bad_code" }, 400);
    const lobby = await fbGet(env, "lobbies/" + code + ".json");
    if (!lobby) return jsonResponse({ ok: false, error: "no_lobby" }, 404);
    if (lobby.hostUid !== uid) return jsonResponse({ ok: false, error: "not_host" }, 403);
    if (lobby.status !== "waiting") return jsonResponse({ ok: false, error: "not_waiting" }, 409);

    const settings = lobby.settings || {};
    const startMoney = cents(Number(settings.startMoney));
    if (!Number.isFinite(startMoney) || startMoney <= 0 || startMoney > 1e9) {
      return jsonResponse({ ok: false, error: "bad_settings" }, 400);
    }
    const patch = { status: "playing", startedAt: { ".sv": "timestamp" }, result: null };
    for (const pid of Object.keys(lobby.players || {})) patch["players/" + pid + "/money"] = startMoney;
    await fbPatch(env, "lobbies/" + code + ".json", patch);
    return jsonResponse({ ok: true, startMoney });
  }

  async function handleMpSpin(request, env) {
    const body = await readJson(request);
    const uid = await auth(body, env);
    if (!uid) return jsonResponse({ ok: false, error: "invalid_token" }, 401);
    const code = String(body.code || ""), pid = String(body.pid || "");
    if (!/^[A-Z0-9]{5}$/.test(code) || !/^[A-Za-z0-9_-]{1,40}$/.test(pid)) return jsonResponse({ ok: false, error: "bad_request" }, 400);
    const bet = parseBet(body.bet);
    if (!bet) return jsonResponse({ ok: false, error: "bad_bet" }, 400);

    const lobby = await fbGet(env, "lobbies/" + code + ".json");
    const player = lobby && lobby.players && lobby.players[pid];
    if (!player || player.uid !== uid) return jsonResponse({ ok: false, error: "not_in_lobby" }, 403);
    if (lobby.status !== "playing") return jsonResponse({ ok: false, error: "not_playing" }, 409);
    const settings = lobby.settings || {};
    const endsAt = Number(lobby.startedAt) + Number(settings.duration) * 1000 + MP_GRACE_MS;
    if (!(Date.now() <= endsAt)) return jsonResponse({ ok: false, error: "round_over" }, 409);
    const mode = MODES.includes(settings.mode) ? settings.mode : "classic";
    const easy = !!settings.easy;
    // Nur so viele Spins, wie bis Rundenende noch abgespielt werden können -
    // sonst könnte man kurz vor Schluss 100 Spins "vorbestellen".
    const left = endsAt - MP_GRACE_MS - Date.now();
    const count = parseCount(body.count, Math.max(1, Math.min(MAX_BATCH, Math.floor(left / MP_SPIN_MS))));

    let batch = null;
    const res = await atomic(env, "lobbies/" + code + "/players/" + enc(pid) + "/money.json", 0, cur => {
      if (cur < bet) return { error: "insufficient", balance: cur };
      batch = runBatch(cur, bet, count, mode, easy);
      return { value: batch.balance };
    });
    if (res.error) {
      return jsonResponse({ ok: false, error: res.error, balance: res.balance }, res.error === "busy" ? 429 : 400);
    }
    return batchResponse(batch);
  }

  return { handleSpin, handleBalance, handleWalletReset, handleMpStart, handleMpSpin };
}

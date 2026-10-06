// Serverseitige Spins: Der Worker würfelt, rechnet den Gewinn aus und
// verwaltet den Kontostand. Der Browser zeigt das Ergebnis nur noch an.
// Damit gibt es nichts mehr, was ein Client "melden" könnte - weder den
// Kontostand noch den Rangliste-Rekord noch das Geld im Multiplayer.
//
//   POST /spin        { token, mode, bet }        Solo-Spin (Online-Konto)
//   POST /balance     { token }                   Kontostände aller Modi
//   POST /wallet/reset { token, mode }            "Geld zurücksetzen" -> 10$
//   POST /mp/start    { token, code }             Host startet die Runde
//   POST /mp/spin     { token, code, pid, bet }   Spin in einer Lobby-Runde
//
// Kontostände: walletSync/<uid>/<mode> (für Clients gesperrt).
// Lobby-Geld: lobbies/<code>/players/<pid>/money (für Clients gesperrt).

import { spin, cents, START_MONEY, MODE_CFG } from "./game.js";

const MODES = Object.keys(MODE_CFG);
const MAX_RETRIES = 4;
const MP_GRACE_MS = 3000; // Spins, die kurz vor Rundenende losgingen

export function makeSpinHandlers(deps) {
  const { fbGet, fbGetEtag, fbPut, fbPatch, jsonResponse, readJson, verifyToken } = deps;
  const enc = (s) => encodeURIComponent(s);

  async function auth(body, env) {
    const p = await verifyToken(body.token, env.WORKER_SECRET);
    return p ? p.uid : null;
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

    let result = null;
    const res = await atomic(env, "walletSync/" + enc(uid) + "/" + mode + ".json", START_MONEY, cur => {
      if (cur < bet) return { error: "insufficient", balance: cur };
      result = spin(mode, bet, false); // Online-Konten haben keinen Easy Mode
      return { value: cents(cur - bet + result.win) };
    });
    if (res.error) {
      return jsonResponse({ ok: false, error: res.error, balance: res.balance }, res.error === "busy" ? 429 : 400);
    }
    try { await noteBest(env, uid, res.value); } catch (e) { console.log("spin " + uid + ": Rekord nicht gespeichert - " + e.message); }
    return jsonResponse({ ok: true, symbols: result.symbols, win: cents(result.win), jackpot: result.jackpot, balance: res.value });
  }

  async function handleBalance(request, env) {
    const body = await readJson(request);
    const uid = await auth(body, env);
    if (!uid) return jsonResponse({ ok: false, error: "invalid_token" }, 401);
    const w = await fbGet(env, "walletSync/" + enc(uid) + ".json") || {};
    const balances = {};
    for (const m of MODES) balances[m] = w[m] === undefined ? START_MONEY : Number(w[m]);
    return jsonResponse({ ok: true, balances });
  }

  async function handleWalletReset(request, env) {
    const body = await readJson(request);
    const uid = await auth(body, env);
    if (!uid) return jsonResponse({ ok: false, error: "invalid_token" }, 401);
    if (!MODES.includes(body.mode)) return jsonResponse({ ok: false, error: "bad_mode" }, 400);
    await fbPut(env, "walletSync/" + enc(uid) + "/" + body.mode + ".json", START_MONEY);
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

    let result = null;
    const res = await atomic(env, "lobbies/" + code + "/players/" + enc(pid) + "/money.json", 0, cur => {
      if (cur < bet) return { error: "insufficient", balance: cur };
      result = spin(mode, bet, easy);
      return { value: cents(cur - bet + result.win) };
    });
    if (res.error) {
      return jsonResponse({ ok: false, error: res.error, balance: res.balance }, res.error === "busy" ? 429 : 400);
    }
    return jsonResponse({ ok: true, symbols: result.symbols, win: cents(result.win), jackpot: result.jackpot, balance: res.value });
  }

  return { handleSpin, handleBalance, handleWalletReset, handleMpStart, handleMpSpin };
}

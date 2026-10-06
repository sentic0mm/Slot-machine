// Admin-Panel für "gamblen ist toll" - eigener Worker, NUR für den Betreiber.
// Sicherheit: siehe security.js (Cloudflare Access + Spielkonto + Browser-Schlüssel).
//
//   GET  /              Admin-Seite (nur mit gültigem Access-Login)
//   POST /api/device    Ist dieser Browser freigeschaltet?
//   POST /api/login     { handle, pass }           -> Admin-Token (30 Min.)
//   POST /api/search    { token, q }               Spieler nach @Name / Nickname / UID
//   POST /api/user      { token, uid }             Kontostände, Online-Status, Lobbys
//   POST /api/grant     { token, uid, target, mode|code+pid, op, amount, live }
//
// Geld wird direkt in Firebase geändert, genauso atomar (ETag) wie bei den
// Spins. "live": der Spieler bekommt sofort einen Hinweis und sein Stand
// wird neu geladen; sonst sieht er es erst beim nächsten Laden/Spin.

import PANEL_HTML from "./panel.html";
import { makeFirebase } from "./firebase.js";
import {
  verifyAccess, verifyDevice, signAdminToken, verifyAdminToken, configMissing, ADMIN_TOKEN_TTL_SEC
} from "./security.js";
import { settleMode } from "../../leaderboard-worker/src/spin.js";
import { MODE_CFG, START_MONEY, cents } from "../../leaderboard-worker/src/game.js";

const MODES = Object.keys(MODE_CFG);
const MAX_AMOUNT = 1e9;
const MAX_RETRIES = 5;
const enc = (s) => encodeURIComponent(s);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const missing = configMissing(env);
      if (missing.length) {
        console.log("admin: nicht eingerichtet, fehlt: " + missing.join(", "));
        return text("Admin-Panel ist noch nicht eingerichtet (siehe admin-worker/README.md).", 503);
      }
      // Schloss 1 - ohne gültigen Cloudflare-Access-Login gibt es gar nichts
      const email = await verifyAccess(request, env);
      if (!email) {
        console.log("admin: Access abgelehnt " + url.pathname + " von " + (request.headers.get("CF-Connecting-IP") || "?"));
        return text("Kein Zugriff.", 403);
      }

      if (request.method === "GET" && url.pathname === "/") return panel();
      if (request.method !== "POST" || !url.pathname.startsWith("/api/")) return text("Nicht gefunden.", 404);

      // Gleiche Herkunft erzwingen (keine Anfragen von fremden Seiten)
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ ok: false, error: "bad_origin" }, 403);

      const bodyText = await request.text();
      if (bodyText.length > 10000) return json({ ok: false, error: "too_large" }, 413);
      let body = {};
      try { body = bodyText ? JSON.parse(bodyText) : {}; } catch (e) { return json({ ok: false, error: "bad_json" }, 400); }

      // Schloss 3 - jede Anfrage muss von einem freigeschalteten Browser signiert sein
      const dev = await verifyDevice(request, url.pathname, bodyText, env);
      if (url.pathname === "/api/device") {
        return json({ ok: dev.ok, known: !!dev.known, device: dev.device || null, reason: dev.reason || null, email });
      }
      if (!dev.ok) {
        console.log("admin: Geraet abgelehnt (" + dev.reason + ") " + url.pathname);
        return json({ ok: false, error: "device_" + dev.reason }, 403);
      }

      if (url.pathname === "/api/login") return await handleLogin(body, env, dev.device, email);

      // Schloss 2 - Admin-Token aus dem Spielkonto-Login
      const session = await verifyAdminToken(body.token, env, dev.device, email);
      if (!session) return json({ ok: false, error: "login_required" }, 401);

      const fb = makeFirebase(env);
      if (url.pathname === "/api/search") return await handleSearch(body, fb);
      if (url.pathname === "/api/user") return await handleUser(body, fb);
      if (url.pathname === "/api/grant") return await handleGrant(body, fb, email);
      return json({ ok: false, error: "not_found" }, 404);
    } catch (err) {
      console.error("admin: Fehler " + String(err && err.message || err));
      return json({ ok: false, error: "server_error" }, 500);
    }
  }
};

// ---------- Login über den Spiel-Worker ----------

async function handleLogin(body, env, device, email) {
  const handle = String(body.handle || "").trim().replace(/^@/, "").toLowerCase();
  const pass = typeof body.pass === "string" ? body.pass : "";
  if (!handle || !pass) return json({ ok: false, error: "missing_fields" }, 400);
  const resp = await env.GAME.fetch(new Request("https://game.internal/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle, pass })
  }));
  let data = {};
  try { data = await resp.json(); } catch (e) {}
  if (!resp.ok || !data.ok) {
    console.log("admin: Spiel-Login fehlgeschlagen (" + (data.error || resp.status) + ")");
    return json({ ok: false, error: data.error || "invalid_login", retryAfter: data.retryAfter }, 401);
  }
  if (data.uid !== env.ADMIN_UID) {
    console.log("admin: Login mit fremdem Konto " + data.uid + " abgelehnt");
    return json({ ok: false, error: "not_admin" }, 403);
  }
  const exp = Math.floor(Date.now() / 1000) + ADMIN_TOKEN_TTL_SEC;
  const token = await signAdminToken({ uid: data.uid, dev: device, email, exp }, env);
  console.log("admin: Login ok (" + email + ", Geraet " + device.slice(0, 8) + ")");
  return json({ ok: true, token, exp, handle: data.handle });
}

// ---------- Suche ----------

async function handleSearch(body, fb) {
  const q = String(body.q || "").trim().replace(/^@/, "");
  if (q.length < 1 || q.length > 64) return json({ ok: false, error: "bad_query" }, 400);
  const lower = q.toLowerCase();
  const hits = [];

  // Genaue UID zuerst
  if (/^[A-Za-z0-9_-]+$/.test(q)) {
    const exact = await fb.get("users/" + enc(q) + ".json");
    if (exact && typeof exact === "object") hits.push(userHit(q, exact));
  }
  const all = await fb.get("users.json") || {};
  for (const uid of Object.keys(all)) {
    if (hits.length >= 30) break;
    if (hits.some(h => h.uid === uid)) continue;
    const u = all[uid] || {};
    const handle = String(u.handle || "").toLowerCase();
    const nick = String(u.nick || "").toLowerCase();
    if (handle.includes(lower) || nick.includes(lower) || uid.toLowerCase().startsWith(lower)) hits.push(userHit(uid, u));
  }
  // Genaue Treffer nach oben
  hits.sort((a, b) => rank(b, lower) - rank(a, lower));
  const status = await Promise.all(hits.map(h => fb.get("status/" + enc(h.uid) + ".json").catch(() => null)));
  hits.forEach((h, i) => { h.online = !!(status[i] && status[i].online); h.lobby = (status[i] && status[i].lobby) || null; });
  return json({ ok: true, hits });
}
function userHit(uid, u) { return { uid, handle: u.handle || "", nick: u.nick || null }; }
function rank(h, q) {
  if (h.uid === q || h.handle.toLowerCase() === q) return 3;
  if (h.handle.toLowerCase().startsWith(q)) return 2;
  return 1;
}

// ---------- Spieler-Details ----------

async function handleUser(body, fb) {
  const uid = String(body.uid || "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return json({ ok: false, error: "bad_uid" }, 400);
  const [user, wallet, status] = await Promise.all([
    fb.get("users/" + enc(uid) + ".json"),
    fb.get("walletSync/" + enc(uid) + ".json"),
    fb.get("status/" + enc(uid) + ".json")
  ]);
  if (!user) return json({ ok: false, error: "no_user" }, 404);

  const now = Date.now();
  const solo = {};
  for (const m of MODES) {
    const st = settleMode(wallet || {}, m, now, false);
    solo[m] = { balance: st.balance, waitMs: st.waitMs > 0 ? st.waitMs : 0 };
  }
  return json({
    ok: true,
    user: { uid, handle: user.handle || "", nick: user.nick || null },
    online: !!(status && status.online),
    lastSeen: (status && status.lastSeen) || null,
    solo,
    lobbies: await findLobbies(fb, uid, status && status.lobby)
  });
}

// Alle Lobbys, in denen der Spieler steckt
async function findLobbies(fb, uid, hintCode) {
  const codes = Object.keys(await fb.get("lobbies.json?shallow=true") || {}).filter(c => /^[A-Z0-9]{5}$/.test(c));
  if (hintCode && codes.includes(hintCode)) codes.unshift(hintCode);
  const unique = [...new Set(codes)].slice(0, 60);
  const lobbies = await Promise.all(unique.map(async code => {
    const [players, status, settings, startedAt] = await Promise.all([
      fb.get("lobbies/" + code + "/players.json"),
      fb.get("lobbies/" + code + "/status.json"),
      fb.get("lobbies/" + code + "/settings.json"),
      fb.get("lobbies/" + code + "/startedAt.json")
    ]);
    const out = [];
    for (const pid of Object.keys(players || {})) {
      const p = players[pid] || {};
      if (p.uid !== uid) continue;
      const s = settings || {};
      out.push({
        code, pid, status: status || "?", money: Number(p.money) || 0,
        mode: s.mode || "classic", endsAt: startedAt && s.duration ? Number(startedAt) + Number(s.duration) * 1000 : null
      });
    }
    return out;
  }));
  return lobbies.flat();
}

// ---------- Geld geben / setzen ----------

async function handleGrant(body, fb, email) {
  const uid = String(body.uid || "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return json({ ok: false, error: "bad_uid" }, 400);
  const op = body.op === "set" ? "set" : "add";
  const amount = cents(Number(body.amount));
  if (!Number.isFinite(amount) || Math.abs(amount) > MAX_AMOUNT || (op === "add" && amount === 0)) {
    return json({ ok: false, error: "bad_amount" }, 400);
  }
  if (op === "set" && amount < 0) return json({ ok: false, error: "bad_amount" }, 400);
  const live = body.live !== false;
  const user = await fb.get("users/" + enc(uid) + ".json");
  if (!user) return json({ ok: false, error: "no_user" }, 404);

  let result;
  if (body.target === "mp") result = await grantLobby(fb, uid, String(body.code || ""), String(body.pid || ""), op, amount);
  else result = await grantSolo(fb, uid, String(body.mode || ""), op, amount);
  if (result.error) return json({ ok: false, error: result.error }, result.status || 400);

  if (live && result.delta !== 0) {
    const gift = {
      id: crypto.randomUUID(),
      kind: body.target === "mp" ? "mp" : "solo",
      mode: result.mode || null, code: result.code || null,
      amount: result.delta, balance: result.balance,
      time: { ".sv": "timestamp" }
    };
    try { await fb.put("users/" + enc(uid) + "/adminGift.json", gift); }
    catch (e) { console.log("admin: Live-Hinweis nicht geschrieben - " + e.message); }
  }
  console.log("admin: " + email + " -> " + uid + " (@" + (user.handle || "?") + ") " +
    (body.target === "mp" ? "Lobby " + result.code : "Solo " + result.mode) +
    " " + (result.delta >= 0 ? "+" : "") + result.delta + " = " + result.balance + (live ? " (live)" : " (still)"));
  return json({ ok: true, delta: result.delta, balance: result.balance, live });
}

function listOf(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return Object.keys(v).sort((a, b) => a - b).map(k => v[k]);
}

async function grantSolo(fb, uid, mode, op, amount) {
  if (!MODES.includes(mode)) return { error: "bad_mode" };
  const path = "walletSync/" + enc(uid) + ".json";
  for (let i = 0; i < MAX_RETRIES; i++) {
    const { value, etag } = await fb.getEtag(path);
    const w = value && typeof value === "object" ? value : {};
    // Sichtbarer Stand jetzt (berücksichtigt eine gerade laufende Spin-Serie)
    const cur = settleMode(w, mode, Date.now(), false).balance;
    const delta = cents(op === "set" ? amount - cur : amount);
    const after = cents(cur + delta);
    if (after < 0) return { error: "would_be_negative" };
    const stored = w[mode] === null || w[mode] === undefined ? START_MONEY : Number(w[mode]);
    w[mode] = cents(stored + delta);
    // Laufende Serie: alle noch kommenden Stände mit verschieben, sonst
    // würde das Geschenk beim Freigeben wieder "überschrieben".
    const p = w.pending && w.pending[mode];
    if (p && p.balances) {
      p.base = cents(Number(p.base) + delta);
      p.balances = listOf(p.balances).map(b => cents(Number(b) + delta));
    }
    if (await fb.put(path, w, etag)) return { delta, balance: after, mode };
  }
  return { error: "busy", status: 429 };
}

async function grantLobby(fb, uid, code, pid, op, amount) {
  if (!/^[A-Z0-9]{5}$/.test(code) || !/^[A-Za-z0-9_-]{1,40}$/.test(pid)) return { error: "bad_lobby" };
  const [player, status] = await Promise.all([
    fb.get("lobbies/" + code + "/players/" + enc(pid) + ".json"),
    fb.get("lobbies/" + code + "/status.json")
  ]);
  if (!player || player.uid !== uid) return { error: "not_in_lobby", status: 404 };
  // In der Warte-Phase setzt der Rundenstart das Geld sowieso neu
  if (status !== "playing") return { error: "lobby_not_playing", status: 409 };
  const path = "lobbies/" + code + "/players/" + enc(pid) + "/money.json";
  for (let i = 0; i < MAX_RETRIES; i++) {
    const { value, etag } = await fb.getEtag(path);
    const cur = Number(value) || 0;
    const after = cents(op === "set" ? amount : cur + amount);
    if (after < 0) return { error: "would_be_negative" };
    if (await fb.put(path, after, etag)) return { delta: cents(after - cur), balance: after, code };
  }
  return { error: "busy", status: 429 };
}

// ---------- Antworten ----------

function panel() {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  return new Response(PANEL_HTML.replace(/__NONCE__/g, nonce), {
    headers: Object.assign({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }, SEC_HEADERS)
  });
}

const SEC_HEADERS = {
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer"
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, SEC_HEADERS)
  });
}
function text(t, status) {
  return new Response(t, { status, headers: Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, SEC_HEADERS) });
}

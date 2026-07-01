import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, collection, query,
  where, onSnapshot, serverTimestamp, runTransaction, increment
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const symbols = ["🍒", "🍋", "⭐", "🔔", "7️⃣", "💎", "🍀"];
const MAX_PLAYERS = 10;

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------
const state = {
  code: null,
  username: null,
  pinHash: null,
  unsubLobby: null,
  unsubPlayers: null,
  lobby: null,
  players: {},        // username -> playerData
  spinning: false,
  countdownTimer: null,
};

// ---------------------------------------------------------------
// DOM
// ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const screens = {
  home: $("screen-home"),
  solo: $("screen-solo"),
  create: $("screen-create"),
  join: $("screen-join"),
  publicList: $("screen-public-list"),
  game: $("screen-game"),
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

// ---------------------------------------------------------------
// Lobby Code
// ---------------------------------------------------------------
function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

// ---------------------------------------------------------------
// Lobby erstellen / beitreten
// ---------------------------------------------------------------
async function createLobby({ username, pin, isPublic, lobbyName, durationMinutes }) {
  const pinHash = await sha256(pin);
  let code;
  for (let i = 0; i < 10; i++) {
    code = genCode();
    const snap = await getDoc(doc(db, "lobbies", code));
    if (!snap.exists()) break;
  }

  await setDoc(doc(db, "lobbies", code), {
    name: lobbyName || ("Lobby " + code),
    public: !!isPublic,
    status: "waiting",
    durationMinutes,
    maxPlayers: MAX_PLAYERS,
    playerCount: 0,
    hostUsername: username,
    createdAt: serverTimestamp(),
    startedAt: null,
    endsAt: null,
  });

  await joinLobbyDoc(code, username, pinHash);
  return code;
}

async function joinLobby({ code, username, pin }) {
  code = code.trim().toUpperCase();
  const pinHash = await sha256(pin);
  const lobbySnap = await getDoc(doc(db, "lobbies", code));
  if (!lobbySnap.exists()) throw new Error("Lobby nicht gefunden.");
  await joinLobbyDoc(code, username, pinHash);
  return code;
}

async function joinLobbyDoc(code, username, pinHash) {
  const lobbyRef = doc(db, "lobbies", code);
  const playerRef = doc(db, "lobbies", code, "players", username);

  await runTransaction(db, async (tx) => {
    const lobbySnap = await tx.get(lobbyRef);
    if (!lobbySnap.exists()) throw new Error("Lobby existiert nicht mehr.");
    const lobby = lobbySnap.data();

    const playerSnap = await tx.get(playerRef);

    if (playerSnap.exists()) {
      // Reconnect - PIN muss stimmen
      if (playerSnap.data().pinHash !== pinHash) {
        throw new Error("Falscher PIN für diesen Namen in dieser Lobby.");
      }
      tx.update(playerRef, { connected: true, lastSeenAt: serverTimestamp(), pinHash });
      return;
    }

    if (lobby.status === "ended") throw new Error("Diese Runde ist bereits vorbei.");
    if (lobby.playerCount >= MAX_PLAYERS) throw new Error("Lobby ist voll (max. 10 Spieler).");

    tx.set(playerRef, {
      username,
      pinHash,
      money: 10,
      startMoney: 10,
      joinedAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
      lastSpinAt: null,
      connected: true,
      aborted: false,
    });

    tx.update(lobbyRef, { playerCount: increment(1) });
  });

  // Nur fürs bequeme Auto-Rejoin bei normalem Reload. Der eigentliche
  // Geldstand hängt NICHT hiervon ab - er lebt in Firestore.
  localStorage.setItem("sm_code", code);
  localStorage.setItem("sm_username", username);
  localStorage.setItem("sm_pinhash", pinHash);

  state.code = code;
  state.username = username;
  state.pinHash = pinHash;
}

async function startRound(durationMinutes) {
  const lobbyRef = doc(db, "lobbies", state.code);
  const endsAt = Date.now() + durationMinutes * 60 * 1000;
  await updateDoc(lobbyRef, {
    status: "running",
    startedAt: serverTimestamp(),
    endsAt,
  });
}

async function abortForMe() {
  const playerRef = doc(db, "lobbies", state.code, "players", state.username);
  await updateDoc(playerRef, {
    pinHash: state.pinHash,
    aborted: true,
    connected: false,
    money: state.players[state.username]?.money ?? 0,
  });
  leaveLocally();
}

function leaveLocally() {
  localStorage.removeItem("sm_code");
  localStorage.removeItem("sm_username");
  localStorage.removeItem("sm_pinhash");
  if (state.unsubLobby) state.unsubLobby();
  if (state.unsubPlayers) state.unsubPlayers();
  clearInterval(state.countdownTimer);
  state.code = null;
  state.username = null;
  state.pinHash = null;
  showScreen("home");
}

// ---------------------------------------------------------------
// Firestore Live-Sync
// ---------------------------------------------------------------
function attachListeners() {
  const lobbyRef = doc(db, "lobbies", state.code);
  state.unsubLobby = onSnapshot(lobbyRef, (snap) => {
    if (!snap.exists()) return;
    state.lobby = snap.data();
    renderLobbyHeader();
    checkRoundEnd();
  });

  const playersRef = collection(db, "lobbies", state.code, "players");
  state.unsubPlayers = onSnapshot(playersRef, (snap) => {
    const players = {};
    snap.forEach(d => { players[d.id] = d.data(); });
    state.players = players;
    renderPlayers();
  });

  showScreen("game");
}

function renderLobbyHeader() {
  const l = state.lobby;
  if (!l) return;
  $("lobby-title").textContent = l.name + " (" + state.code + ")";
  $("lobby-status").textContent =
    l.status === "waiting" ? "Warte auf Start…" :
    l.status === "running" ? "Runde läuft" : "Runde beendet";

  $("btn-start-round").classList.toggle("hidden",
    !(l.status === "waiting" && l.hostUsername === state.username));

  if (l.status === "running" && l.endsAt) {
    startCountdown(l.endsAt);
  } else {
    clearInterval(state.countdownTimer);
    $("countdown").textContent = "";
  }
}

function startCountdown(endsAt) {
  clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(() => {
    const remaining = endsAt - Date.now();
    if (remaining <= 0) {
      $("countdown").textContent = "00:00";
      clearInterval(state.countdownTimer);
      return;
    }
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    $("countdown").textContent = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }, 250);
}

let roundEndHandled = false;
function checkRoundEnd() {
  const l = state.lobby;
  if (!l || l.status !== "running" || !l.endsAt) return;
  if (Date.now() < l.endsAt) { roundEndHandled = false; return; }
  if (roundEndHandled) return;
  roundEndHandled = true;

  // Irgendein Client markiert die Runde als beendet (best effort ohne Server).
  updateDoc(doc(db, "lobbies", state.code), { status: "ended" }).catch(() => {});
  showWinner();
}

function showWinner() {
  const entries = Object.values(state.players)
    .map(p => ({ ...p, profit: (p.money ?? 0) - (p.startMoney ?? 10) }))
    .sort((a, b) => b.profit - a.profit);

  const winner = entries[0];
  const box = $("winner-box");
  box.classList.remove("hidden");
  box.innerHTML = winner
    ? `🏆 <b>${escapeHtml(winner.username)}</b> gewinnt mit +${winner.profit.toFixed(2)}$ Profit!`
    : "Runde beendet.";
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ---------------------------------------------------------------
// Spieler-Kacheln rendern (eigene immer oben links)
// ---------------------------------------------------------------
function renderPlayers() {
  // Eigene Maschine (oben, klassisches Design) separat aktualisieren
  const me = state.players[state.username];
  if (me && !state.spinning) {
    $("my-money").textContent = "Geld: " + (me.money ?? 0).toFixed(2) + "$";
    if (me.lastSymbols) {
      $("my-r1").textContent = me.lastSymbols[0];
      $("my-r2").textContent = me.lastSymbols[1];
      $("my-r3").textContent = me.lastSymbols[2];
    }
  }

  // Mitspieler-Kacheln (ohne mich selbst)
  const grid = $("player-grid");
  grid.innerHTML = "";

  const others = Object.values(state.players)
    .filter(p => p.username !== state.username)
    .sort((a, b) => (b.money ?? 0) - (a.money ?? 0));

  others.forEach(p => {
    const tile = document.createElement("div");
    tile.className = "tile" + (p.aborted ? " tile-aborted" : "");

    const profit = (p.money ?? 0) - (p.startMoney ?? 10);
    const profitClass = profit >= 0 ? "profit-pos" : "profit-neg";

    tile.innerHTML = `
      <div class="tile-name">${escapeHtml(p.username)}</div>
      <div class="tile-reels">
        <span>${p.lastSymbols?.[0] ?? "🍒"}</span>
        <span>${p.lastSymbols?.[1] ?? "🍋"}</span>
        <span>${p.lastSymbols?.[2] ?? "⭐"}</span>
      </div>
      <div class="tile-money">${(p.money ?? 0).toFixed(2)}$</div>
      <div class="tile-profit ${profitClass}">${profit >= 0 ? "+" : ""}${profit.toFixed(2)}$</div>
      ${p.aborted ? '<div class="tile-tag">abgebrochen</div>' : ""}
      ${!p.connected && !p.aborted ? '<div class="tile-tag">getrennt</div>' : ""}
    `;
    grid.appendChild(tile);
  });
}

// ---------------------------------------------------------------
// Spin-Logik (eigener Spieler, mit klassischer Reel-Animation)
// ---------------------------------------------------------------
function randomSymbol() { return symbols[Math.floor(Math.random() * symbols.length)]; }

function animateReel(el, duration) {
  return new Promise(resolve => {
    const interval = setInterval(() => { el.textContent = randomSymbol(); }, 80);
    setTimeout(() => {
      clearInterval(interval);
      const final = randomSymbol();
      el.textContent = final;
      resolve(final);
    }, duration);
  });
}

function pullLever(leverEl) {
  leverEl.classList.add("lever-pulled");
  setTimeout(() => leverEl.classList.remove("lever-pulled"), 250);
}

async function doSpin() {
  if (state.spinning) return;
  const l = state.lobby;
  if (!l || l.status !== "running") { setMyStatus("Die Runde läuft noch nicht."); return; }

  const bet = parseFloat($("bet").value);
  if (isNaN(bet) || bet <= 0) { setMyStatus("Ungültiger Einsatz."); return; }

  const me = state.players[state.username];
  if (!me || me.money < bet) { setMyStatus("Nicht genug Geld!"); return; }

  state.spinning = true;
  pullLever($("btn-spin"));
  setMyStatus("🎰 Dreht…");

  const a = await animateReel($("my-r1"), 1200);
  const b = await animateReel($("my-r2"), 1800);
  const c = await animateReel($("my-r3"), 2200);

  let win = 0;
  if (a === b && b === c) win = bet * 10;
  else if (a === b || b === c || a === c) win = bet * 2;

  const newMoney = Math.max(0, me.money - bet + win);
  $("my-money").textContent = "Geld: " + newMoney.toFixed(2) + "$";

  const playerRef = doc(db, "lobbies", state.code, "players", state.username);
  await updateDoc(playerRef, {
    pinHash: state.pinHash,
    money: newMoney,
    lastSpinAt: serverTimestamp(),
    lastSymbols: [a, b, c],
    connected: true,
    lastSeenAt: serverTimestamp(),
  });

  if (win === bet * 10) { $("my-status").className = "status jackpot"; setMyStatus("🎰 JACKPOT +" + win.toFixed(2) + "$"); }
  else if (win > 0) { $("my-status").className = "status win"; setMyStatus("✅ Gewonnen +" + win.toFixed(2) + "$"); }
  else { $("my-status").className = "status lose"; setMyStatus("❌ Verloren"); }

  state.spinning = false;
}

function setMyStatus(text) { $("my-status").textContent = text; }

// ---------------------------------------------------------------
// Solo-Modus (kein Firebase, rein lokal, klassisches Design)
// ---------------------------------------------------------------
const solo = {
  money: parseFloat(localStorage.getItem("solo_money")) || 10,
  spinning: false,
};

function soloSaveMoney() { localStorage.setItem("solo_money", solo.money); }

function soloUpdateMoney() {
  $("solo-money").textContent = "Geld: " + solo.money.toFixed(2) + "$";
  soloSaveMoney();
}

async function soloSpin() {
  if (solo.spinning) return;

  const bet = parseFloat($("solo-bet").value);
  const spins = parseInt($("solo-spins").value);
  if (isNaN(bet) || isNaN(spins) || bet <= 0 || spins <= 0) {
    $("solo-status").textContent = "Ungültige Eingabe!";
    return;
  }
  if (solo.money < bet) {
    $("solo-status").textContent = "Kein Geld mehr!";
    return;
  }

  solo.spinning = true;
  pullLever($("solo-lever"));

  for (let i = 0; i < spins; i++) {
    if (solo.money < bet) {
      $("solo-status").className = "status lose";
      $("solo-status").textContent = "Nicht genug Geld für weitere Spins!";
      break;
    }

    solo.money -= bet;
    soloUpdateMoney();
    $("solo-status").textContent = "🎰 Dreht…";

    const a = await animateReel($("solo-r1"), 1200);
    const b = await animateReel($("solo-r2"), 1800);
    const c = await animateReel($("solo-r3"), 2200);

    let win = 0;
    if (a === b && b === c) {
      win = bet * 10;
      $("solo-status").className = "status jackpot";
      $("solo-status").textContent = "🎰 JACKPOT +" + win.toFixed(2) + "$";
    } else if (a === b || b === c || a === c) {
      win = bet * 2;
      $("solo-status").className = "status win";
      $("solo-status").textContent = "✅ Gewonnen +" + win.toFixed(2) + "$";
    } else {
      $("solo-status").className = "status lose";
      $("solo-status").textContent = "❌ Verloren";
    }

    solo.money += win;
    soloUpdateMoney();

    await new Promise(r => setTimeout(r, 400));
  }

  solo.spinning = false;
}

$("solo-lever").addEventListener("click", soloSpin);

$("solo-btn-allin").addEventListener("click", () => {
  $("solo-bet").value = Math.max(1, Math.floor(solo.money));
});

$("solo-btn-reset").addEventListener("click", () => {
  const c1 = confirm("Solo-Geld auf 10.00$ zurücksetzen?");
  if (!c1) return;
  solo.money = 10;
  soloUpdateMoney();
  $("solo-status").className = "status";
  $("solo-status").textContent = "💰 Zurückgesetzt!";
});

$("btn-goto-solo").addEventListener("click", () => {
  soloUpdateMoney();
  showScreen("solo");
});
$("btn-back-solo").addEventListener("click", () => showScreen("home"));

// ---------------------------------------------------------------
// Abbruch mit doppelter Bestätigung
// ---------------------------------------------------------------
$("btn-abort").addEventListener("click", () => {
  const c1 = confirm("⚠️ Willst du die Runde wirklich abbrechen? Dein aktueller Stand zählt dann final.");
  if (!c1) return;
  const c2 = confirm("Bist du WIRKLICH sicher? Das kann nicht rückgängig gemacht werden.");
  if (!c2) return;
  abortForMe();
});

// ---------------------------------------------------------------
// UI Events - Home / Create / Join
// ---------------------------------------------------------------
$("btn-goto-create").addEventListener("click", () => showScreen("create"));
$("btn-goto-join").addEventListener("click", () => showScreen("join"));
$("btn-goto-public").addEventListener("click", loadPublicLobbies);
$("btn-back-1").addEventListener("click", () => showScreen("home"));
$("btn-back-2").addEventListener("click", () => showScreen("home"));
$("btn-back-3").addEventListener("click", () => showScreen("home"));

$("create-public").addEventListener("change", (e) => {
  $("create-name-wrap").classList.toggle("hidden", !e.target.checked);
});

$("btn-create-submit").addEventListener("click", async () => {
  try {
    const username = $("create-username").value.trim();
    const pin = $("create-pin").value.trim();
    const isPublic = $("create-public").checked;
    const lobbyName = $("create-name").value.trim();
    const duration = parseInt($("create-duration").value);

    if (!username || pin.length < 4) { alert("Name + PIN (min. 4 Zeichen) angeben."); return; }
    if (!duration || duration <= 0) { alert("Gültige Zeitdauer angeben."); return; }

    const code = await createLobby({ username, pin, isPublic, lobbyName, durationMinutes: duration });
    attachListeners();
  } catch (e) {
    alert("Fehler: " + e.message);
  }
});

$("btn-join-submit").addEventListener("click", async () => {
  try {
    const code = $("join-code").value;
    const username = $("join-username").value.trim();
    const pin = $("join-pin").value.trim();
    if (!code || !username || !pin) { alert("Alle Felder ausfüllen."); return; }

    await joinLobby({ code, username, pin });
    attachListeners();
  } catch (e) {
    alert("Fehler: " + e.message);
  }
});

async function loadPublicLobbies() {
  showScreen("publicList");
  const list = $("public-list");
  list.innerHTML = "Lade…";

  const q = query(collection(db, "lobbies"), where("public", "==", true), where("status", "==", "waiting"));
  const { getDocs } = await import("https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js");
  const snap = await getDocs(q);

  list.innerHTML = "";
  if (snap.empty) { list.innerHTML = "<p>Keine offenen öffentlichen Lobbys gerade.</p>"; return; }

  snap.forEach(d => {
    const l = d.data();
    const row = document.createElement("div");
    row.className = "public-row";
    row.innerHTML = `<b>${escapeHtml(l.name)}</b> · ${l.playerCount}/10 Spieler · ${l.durationMinutes} min
      <button data-code="${d.id}">Beitreten</button>`;
    row.querySelector("button").addEventListener("click", () => {
      $("join-code").value = d.id;
      showScreen("join");
    });
    list.appendChild(row);
  });
}

$("btn-start-round").addEventListener("click", async () => {
  const duration = state.lobby.durationMinutes;
  await startRound(duration);
});

$("btn-spin").addEventListener("click", doSpin);

// ---------------------------------------------------------------
// Auto-Rejoin bei normalem Reload
// ---------------------------------------------------------------
(async function init() {
  const code = localStorage.getItem("sm_code");
  const username = localStorage.getItem("sm_username");
  const pinHash = localStorage.getItem("sm_pinhash");

  if (code && username && pinHash) {
    try {
      const lobbyRef = doc(db, "lobbies", code);
      const lobbySnap = await getDoc(lobbyRef);
      if (lobbySnap.exists()) {
        const playerRef = doc(db, "lobbies", code, "players", username);
        const playerSnap = await getDoc(playerRef);
        if (playerSnap.exists() && playerSnap.data().pinHash === pinHash && !playerSnap.data().aborted) {
          await updateDoc(playerRef, { pinHash, connected: true, lastSeenAt: serverTimestamp() });
          state.code = code;
          state.username = username;
          state.pinHash = pinHash;
          attachListeners();
          return;
        }
      }
    } catch (e) {
      console.warn("Auto-Rejoin fehlgeschlagen:", e);
    }
    // Konnte nicht automatisch zurück -> lokale Reste löschen, normal starten
    localStorage.removeItem("sm_code");
    localStorage.removeItem("sm_username");
    localStorage.removeItem("sm_pinhash");
  }

  showScreen("home");
})();

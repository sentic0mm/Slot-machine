// Spiellogik für serverseitige Spins - 1:1 wie in index.html (randomSymbol,
// makeWinTriple, makeMegaGrid, evalMega, ...), nur mit kryptografisch
// sicherem Zufall statt Math.random(). Wer hier etwas ändert, muss es auch
// in index.html ändern (dort wird das Ergebnis nur noch angezeigt und für
// Gäste/Offline-Konten lokal gewürfelt).

export const SYMBOLS = ["🍒", "🍋", "⭐", "🔔", "7️⃣", "💎", "🍀"];
export const MODE_CFG = {
  classic: { cols: 3, rows: 1 },
  mega: { cols: 5, rows: 3 },
  ultra: { cols: 7, rows: 3 }
};
export const START_MONEY = 10;

const MEGA_MULT = { 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };
const DIAG_MULT = 3;
const COL_MULT = 3;
const JACKPOT_MULT = 500;
const CLASSIC_JACKPOT_MULT = 10;
const CLASSIC_PAIR_MULT = 2;

// Gleichverteilte Zufallszahl in [0, 1) aus crypto
export function rand() {
  const a = crypto.getRandomValues(new Uint32Array(2));
  return (a[0] * 2 ** 21 + (a[1] >>> 11)) / 2 ** 53;
}
const randomSymbol = () => SYMBOLS[Math.floor(rand() * SYMBOLS.length)];
function otherSymbol(not) {
  let s = randomSymbol();
  while (s === not) s = randomSymbol();
  return s;
}

function makeWinTriple(jackpot) {
  const x = randomSymbol();
  if (jackpot) return [x, x, x];
  return [x, x, otherSymbol(x)];
}
function makeLoseTriple() {
  const x = randomSymbol();
  const y = otherSymbol(x);
  let z = randomSymbol();
  while (z === x || z === y) z = randomSymbol();
  return [x, y, z];
}

function makeMegaGrid(mode, easy) {
  const { rows, cols } = MODE_CFG[mode];
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push(randomSymbol());
    grid.push(row);
  }
  if (easy) {
    for (let r = 0; r < rows; r++) {
      if (rand() < 0.20) {
        const L = 3;
        const s = randomSymbol();
        for (let c = 0; c < L; c++) grid[r][c] = s;
        if (L < cols && grid[r][L] === s) grid[r][L] = otherSymbol(s);
      }
    }
  }
  return grid;
}

const megaMult = (run) => MEGA_MULT[Math.min(run, 7)] || 3;

export function evalMega(grid, bet) {
  const rows = grid.length, cols = grid[0].length;
  let win = 0;
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      let run = 1;
      while (c + run < cols && grid[r][c + run] === grid[r][c]) run++;
      if (run >= 3) win += bet * megaMult(run);
      c += run;
    }
  }
  for (let c = 0; c < cols; c++) {
    if (grid[0][c] === grid[1][c] && grid[1][c] === grid[2][c]) win += bet * COL_MULT;
  }
  for (let c = 0; c + 2 < cols; c++) {
    if (grid[0][c] === grid[1][c + 1] && grid[1][c + 1] === grid[2][c + 2]) win += bet * DIAG_MULT;
    if (grid[2][c] === grid[1][c + 1] && grid[1][c + 1] === grid[0][c + 2]) win += bet * DIAG_MULT;
  }
  const first = grid[0][0];
  const jackpot = grid.every(row => row.every(s => s === first));
  if (jackpot) win = bet * JACKPOT_MULT;
  return { win, jackpot };
}

export function evalClassic(t, bet) {
  const [a, b, c] = t;
  if (a === b && b === c) return { win: bet * CLASSIC_JACKPOT_MULT, jackpot: true };
  if (a === b || b === c || a === c) return { win: bet * CLASSIC_PAIR_MULT, jackpot: false };
  return { win: 0, jackpot: false };
}

// Ein kompletter Spin. Rückgabe: { symbols, win, jackpot }
//   classic: symbols = [a, b, c]
//   mega/ultra: symbols = grid[reihe][spalte]
export function spin(mode, bet, easy) {
  if (mode === "classic") {
    let t;
    if (easy) {
      const roll = rand();
      t = roll < 0.42 ? makeWinTriple(roll < 0.02) : makeLoseTriple();
    } else {
      t = [randomSymbol(), randomSymbol(), randomSymbol()];
    }
    return Object.assign({ symbols: t }, evalClassic(t, bet));
  }
  const grid = makeMegaGrid(mode, easy);
  return Object.assign({ symbols: grid }, evalMega(grid, bet));
}

export const cents = (v) => Math.round(v * 100) / 100;

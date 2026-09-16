# Leaderboard-Worker (Setup)

Vertrauenswürdiger Schreib-Endpunkt für die Weltweite Rangliste. Läuft auf
Cloudflare Workers (kostenlos, keine Kreditkarte nötig). Siehe `src/index.js`
für die Erklärung, warum das nötig ist.

## Einmalige Einrichtung

### 1. Firebase Service-Account-Schlüssel erstellen
Firebase-Konsole → Projekteinstellungen (Zahnrad) → Dienstkonten →
"Neuen privaten Schlüssel generieren". Das lädt eine JSON-Datei herunter.
**Diese Datei niemals ins Repo committen, niemals teilen.**

### 2. Cloudflare-Account
Falls noch nicht vorhanden: kostenlos auf cloudflare.com registrieren
(keine Kreditkarte nötig für den Free-Plan).

### 3. Einloggen
```bash
cd leaderboard-worker
npm install
npx wrangler login
```
Öffnet den Browser, dort mit dem Cloudflare-Account bestätigen.

### 4. Geheimnisse setzen
```bash
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_KEY
```
Den kompletten Inhalt der in Schritt 1 heruntergeladenen JSON-Datei einfügen
(einzeiler oder mehrzeilig, wrangler nimmt den ganzen Text), dann Enter.

```bash
npx wrangler secret put WORKER_SECRET
```
Ein zufälliges, langes Geheimnis eingeben (z.B. mit
`node -e "console.log(crypto.randomBytes(32).toString('hex'))"` erzeugen).
Dieses Geheimnis signiert die Login-Tokens - muss niemand außer dem Worker
kennen.

### 5. Deployen
```bash
npx wrangler deploy
```
Gibt am Ende eine URL aus, z.B.
`https://slotmachine-leaderboard.<dein-cloudflare-name>.workers.dev`.
Diese URL trägst du in `index.html` bei `LB_WORKER_URL` ein.

### 6. Datenbank-Regeln deployen
Erst NACHDEM der Worker läuft: die aktualisierte `database.rules.json`
(sperrt direktes Client-Schreiben aufs Leaderboard) mit
`firebase deploy --only database` einspielen.

## Lokal testen
```bash
npx wrangler dev
```
Startet den Worker lokal (z.B. auf http://localhost:8787). Für lokale Tests
`LB_WORKER_URL` in index.html vorübergehend auf diese Adresse zeigen lassen.

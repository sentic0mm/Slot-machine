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

## Sicherheits-Update (echter Login über Firebase Auth)

Der Worker macht jetzt auch Registrierung, Login, Passwort-Reset und
Wiederherstellungs-Codes (`src/auth.js`) und gibt ein Firebase-Custom-Token
aus. Damit wissen die DB-Regeln (`../database.rules.json`), wer schreibt.

**Reihenfolge beim Umstellen (wichtig!):**

1. **Backup:** Firebase-Konsole → Realtime Database → ⋮ → „JSON exportieren“.
2. **Authentication aktivieren:** Firebase-Konsole → Authentication →
   „Jetzt starten“. Für die Spieler muss kein Anbieter eingeschaltet werden
   (Custom Tokens gehen immer).
   **Admin-Zugang:** Die Regeln erlauben Vollzugriff nur noch deiner
   Admin-UID (Authentication → Nutzer → Nutzer-UID), nicht mehr jedem Konto
   mit deiner Mail-Adresse.
3. **Worker deployen:** `npx wrangler deploy` (alte Seite läuft damit weiter).
4. **Seite deployen:** PR mergen (GitHub Pages).
5. **Regeln einspielen:** Inhalt von `database.rules.json` in der Konsole
   unter Realtime Database → Regeln einfügen → „Veröffentlichen“.
6. **Alte Hashes umziehen:**
   `node migrate.mjs pfad/zur/service-account.json` (Vorschau), dann mit
   `--apply`. Verschiebt alle öffentlichen `users/*/passHash` nach
   `creds/` und löscht die alten Passwort-Kopien (`pwenc`).

**Was sich für Spieler ändert:** Alle müssen sich einmal neu einloggen.
Neue Passwörter brauchen mindestens 8 Zeichen (alte gehen weiter).
„Passwort vergessen?“ im Login setzt das Passwort per
Wiederherstellungs-Code selbst zurück.

**Support-Abläufe:**
- *Passwort zurücksetzen:* nicht mehr den passHash löschen (das hätte jeder
  ausnutzen können). Stattdessen: Codes von vor dem Update gelten erst nach
  Prüfung – wenn der Beweis in der Anfrage stimmt, in der Konsole
  `creds/<uid>/recoveryTrusted` auf `true` setzen. Dann kann der Spieler
  „Passwort vergessen?“ mit seinem Code benutzen.
- *Account entsperren* (nach 5 Fehlversuchen 15 Min. gesperrt):
  `creds/<uid>/lockUntil` löschen.

## Serverseitige Spins

Online-Konten und Multiplayer-Runden würfelt der Worker (`src/spin.js`,
Spiellogik in `src/game.js`, sicherer Zufall). Der Browser zeigt nur noch
das Ergebnis an. Kontostand (`walletSync/`), Rangliste-Rekord und
Lobby-Geld schreibt nur noch der Worker; Werte aus der Konsole werden beim
nächsten Spin einfach durch den echten Stand ersetzt. Gäste und
Offline-Konten zählen nirgends und würfeln weiter lokal.

**Mehrere Spins auf einmal:** Die Seite schickt `count` mit, der Worker
würfelt die ganze Serie in einer Anfrage (max. 100). Die Gewinne werden aber
erst nach und nach freigegeben, ein Spin alle 1,5 s. Wer mittendrin neu
lädt, hat nur das Geld der schon „gelaufenen“ Spins, und neue Spins gibt es
erst, wenn die Serie durch ist. Im Multiplayer werden nur so viele Spins
angenommen, wie bis Rundenende noch Zeit ist.

**Wichtig:** `src/game.js` und die Spiellogik in `index.html` müssen gleich
bleiben. Wer Gewinne oder Wahrscheinlichkeiten ändert, ändert beides.

**Deploy:** Worker + Seite + neue Regeln (Lobby-Geld ist jetzt für Clients
gesperrt) zusammen einspielen. Mit alter Seite und neuem Worker gehen
Online-Spins weiter lokal, werden aber nicht mehr gespeichert.

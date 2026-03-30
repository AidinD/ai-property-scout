# Automatiserat Test-Loop System för Chrome Extensions

## Hur vi satte upp det – guide för framtida projekt

---

## Översikt

Ett system där Claude Desktop (i chatten) testar Chrome-extensionen i webbläsaren automatiskt,
skriver strukturerad feedback till en fil, och Claude Code (i VS Code) plockar upp feedbacken
och fixar koden – utan manuella steg däremellan.

### Flödet

```
[Sessionsstart]
  node bridge.js        ← HTTP-brygga för skrivning från webbläsaren
  node dev-loop.js      ← Filwatcher som kör Claude Code CLI vid NEEDS_FIX

Claude Code fixar kod + bygger
    → skriver **Status:** FIXED_BUILD_READY i test-feedback.md

Claude Desktop ser FIXED_BUILD_READY
    → laddar om extensionen via chrome.runtime.sendMessage(EXT_ID, {action:'reload'})
    → navigerar till en testannons
    → testar sidebaren och konsolloggar
    → skriver feedback + **Status:** NEEDS_FIX till filen via fetch('http://localhost:7824')

dev-loop.js detekterar NEEDS_FIX
    → kör: claude --print "[specificerad prompt med absoluta sökvägar]"
    → Claude Code läser feedback, fixar kod, bygger
    → skriver FIXED_BUILD_READY

→ upprepa tills Claude Desktop rapporterar ALL_GOOD
```

---

## Komponenter

### 1. bridge.js (lokal HTTP-server)

Låter Claude Desktop (som kör i webbläsaren) skriva till lokala filer via `fetch`.
Nödvändigt eftersom File System Access API:et tappas vid sidnavigering.

**Kritisk lärdom:** Använd `path.join()` – hårdkodade backslashes i strängar kan tolkas
som escape-tecken (`\t` = tab, `\n` = newline).

**Kritisk lärdom:** Använd en specifik CORS-lista, aldrig `*`. En `*` tillåter vilken
webbsida som helst att skriva till din disk medan servern kör.

**Kritisk lärdom:** Port 7823 kan fastna i TIME_WAIT efter krasch. Byt till en annan port
(t.ex. 7824) om du får EADDRINUSE trots att inga processer syns i `netstat`.

```js
// bridge.js – kör med: node bridge.js
const http = require("http");
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "test-feedback.md");
const PORT = 7824;
const ALLOWED = ["https://www.hemnet.se", "https://hemnet.se", "https://www.booli.se"];

http.createServer((req, res) => {
    const origin = req.headers["origin"] || "";
    if (ALLOWED.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.end();
        return;
    }
    if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
    }

    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
        try {
            fs.writeFileSync(FILE, b, "utf8");
            res.end("ok");
            console.log("[bridge] updated", new Date().toISOString());
        } catch (e) {
            res.writeHead(500);
            res.end(e.message);
        }
    });
}).listen(PORT, () => console.log("[bridge] Running on port", PORT));
```

**Starta på Windows (bakgrund):**

```powershell
Start-Process node -ArgumentList 'bridge.js' -RedirectStandardOutput 'bridge.log' -RedirectStandardError 'bridge.err' -WindowStyle Hidden
```

**Kontrollera att den kör:**

```
cat bridge.log   # ska visa: [bridge] Running on port 7824
```

---

### 2. dev-loop.js (filwatcher + Claude Code-trigger)

Pollar test-feedback.md varannan sekund. När status är `NEEDS_FIX` körs
`claude --print` med en specificerad prompt som instruerar Claude Code att fixa och bygga.

**Kritisk lärdom:** Regex måste vara rad-anchrad (`^` + `m`-flagga). Annars matchar
den exempel-text i dokumentation som råkar innehålla `**Status:** NEEDS_FIX`.

**Kritisk lärdom:** `claude --print` startar en ny Claude-session utan kontext.
Prompten måste därför innehålla **absoluta sökvägar** och vara helt självbeskrivande.

```js
// dev-loop.js
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const FEEDBACK_FILE = path.join(__dirname, "test-feedback.md");
const POLL_MS = 2000;

let lastStatus = null;
let lastMtime = 0;

console.log("[dev-loop] Watching", FEEDBACK_FILE);
console.log("[dev-loop] Waiting for Status: NEEDS_FIX ...\n");

setInterval(() => {
    let stat;
    try {
        stat = fs.statSync(FEEDBACK_FILE);
    } catch (_) {
        return;
    }

    if (stat.mtimeMs === lastMtime) {
        return;
    }
    lastMtime = stat.mtimeMs;

    const content = fs.readFileSync(FEEDBACK_FILE, "utf8");

    // ^ + m-flagga: matchar bara i början av rad, inte i exempeltext i dokumentation
    const match = content.match(/^\*\*Status:\*\*\s*(\S+)/m) || content.match(/^##\s+Status\s*\n\s*(\S+)/m);
    const status = match?.[1];

    if (status === lastStatus) {
        return;
    }
    lastStatus = status;

    console.log(`[dev-loop] Status → ${status}`);
    if (status !== "NEEDS_FIX") {
        return;
    }

    console.log("[dev-loop] Invoking Claude Code...\n");

    // Prompt måste vara självbeskrivande med absoluta sökvägar
    const PROJECT = __dirname;
    const prompt = `
You are working on the Chrome extension project at ${PROJECT}.

Read the file ${path.join(PROJECT, "test-feedback.md")}.
It contains issues reported by the tester under sections like "## Observerat fel" or "## Issues Found".

Fix the issues by editing files in ${path.join(PROJECT, "src")}.
Main files: src/content.js, src/background.js, src/selectors.js, src/utils.js.

After fixing:
1. Run: cd "${PROJECT}" && npm run build
2. Increment the patch version in ${path.join(PROJECT, "manifest.json")}
3. Overwrite ${path.join(PROJECT, "test-feedback.md")} with exactly this format:

**Status:** FIXED_BUILD_READY
**Version:** [new version number]

## Fixes Applied
[bullet list of what was changed and why]

## Next Test
[what the tester should verify]

Do not ask for confirmation. Read, fix, build, update file.
`.trim();

    spawnSync("claude", ["--print", prompt], {
        cwd: PROJECT,
        stdio: "inherit",
        shell: true,
    });

    console.log("\n[dev-loop] Done. Waiting for next NEEDS_FIX...");
}, POLL_MS);
```

**Starta på Windows (bakgrund):**

```powershell
Start-Process node -ArgumentList 'dev-loop.js' -RedirectStandardOutput 'dev-loop.log' -RedirectStandardError 'dev-loop.err' -WindowStyle Hidden
```

---

### 3. test-feedback.md (kommunikationskanal)

**Format som Claude Desktop alltid använder (statusraden SIST, på egen rad):**

```markdown
# Test Feedback - [datum]

## Testad URL

[url]

## Observerat fel

[beskrivning av vad som inte fungerar]

## Console-loggar

[Scout v7] ...relevanta loggar...

## Rotorsak (valfritt)

[analys om känd]

**Status:** NEEDS_FIX
```

**Viktiga regler:**

- `**Status:** NEEDS_FIX` ska stå på **egen rad i början av raden** (inte indraget, inte i kodblock)
- Skriv aldrig `READY_TO_TEST` när det finns problem att rapportera
- Filen får innehålla dokumentation men statusraden ska alltid vara sist och rad-anchrad

**Statusvärden:**
| Värde | Sätts av | Betyder |
|---|---|---|
| `NEEDS_FIX` | Claude Desktop | Hittade problem, Claude Code ska fixa |
| `FIXED_BUILD_READY` | Claude Code | Fix klar + byggt, ladda om och testa |
| `ALL_GOOD` | Claude Desktop | Allt fungerar, loopen kan stoppas |

---

### 4. externally_connectable (extension reload)

Gör så att webbsidor på specificerade domäner kan skicka meddelanden till extensionen.
Möjliggör automatisk reload från webbläsaren utan att gå via chrome://extensions.

**I manifest.json:**

```json
"externally_connectable": {
    "matches": [
        "https://hemnet.se/*",
        "https://www.hemnet.se/*",
        "https://booli.se/*",
        "https://www.booli.se/*"
    ]
}
```

**I background.js:**

```js
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
    if (message.action === "reload") {
        sendResponse({ ok: true });
        chrome.runtime.reload();
    }
});
```

**Claude Desktop reloadar extensionen via DevTools-konsolen:**

```js
chrome.runtime.sendMessage("EXTENSION_ID_HÄR", { action: "reload" }, (r) => console.log(r));
```

Extension ID hittas på `chrome://extensions` under extensionens namn.

---

### 5. Prompt till Claude Code (engångsinstruktion vid sessionsstart)

Klistra in detta i Claude Code-chatten i VS Code när du startar en testsession:

```
Övervaka filen test-feedback.md i det här projektet.
När du ser **Status:** NEEDS_FIX (på egen rad), läs feedbacken och åtgärda alla problem.
När du är klar: kör npm run build, öka versionsnumret i manifest.json,
och uppdatera test-feedback.md med **Status:** FIXED_BUILD_READY följt av en
"## Fixes Applied"-sektion som sammanfattar vad som ändrades.
Upprepa tills Claude Desktop skriver ALL_GOOD.
```

OBS: dev-loop.js körs parallellt och triggar `claude --print` automatiskt. Den manuella
instruktionen ovan behövs om du vill att Claude Code i den aktiva sessionen ska reagera direkt.

---

### 6. Prompt till Claude Desktop (chatten)

Klistra in detta i Claude Desktop när du startar en testsession. Fyll i `[...]`:

```
Du är automatiserad testare för Chrome-extensionen AI Property Scout.
Extension ID: [hämta från chrome://extensions]
Bridge URL: http://localhost:7824
Projektmapp: D:\Repo\Claude\ai-property-scout

Ditt jobb:
1. Läs test-feedback.md och se efter om Status är FIXED_BUILD_READY
2. Om ja: ladda om extensionen i webbläsaren:
   chrome.runtime.sendMessage('[EXTENSION_ID]', { action: 'reload' }, r => console.log(r))
3. Navigera till en Hemnet-bostadssida (URL med /bostad/)
4. Inspektera sidebaren: visar den pris, adress, yta, fastighetstyp?
5. Öppna DevTools (F12) → Console → filtrera på [Scout]
6. Notera alla fel och vad som saknas
7. Skriv feedback till filen via:
   fetch('http://localhost:7824', {
     method: 'POST',
     headers: { 'Content-Type': 'text/plain' },
     body: `# Test Feedback - ${new Date().toISOString()}\n\n## Testad URL\n${location.href}\n\n## Observerat fel\n[beskriv]\n\n## Console-loggar\n[klistra in]\n\n**Status:** NEEDS_FIX`
   })
8. Vänta tills Status ändras till FIXED_BUILD_READY, upprepa sedan från steg 2
9. Skriv **Status:** ALL_GOOD när allt fungerar korrekt
```

---

## Kända begränsningar & lärdomar

| Problem                                         | Orsak                                  | Lösning                                              |
| ----------------------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| Porten fastnar i TIME_WAIT                      | OS håller porten en stund efter krasch | Byt port (t.ex. 7823→7824)                           |
| `\t` i sökvägar tolkas som tab                  | JS string escape                       | Använd `path.join()` alltid                          |
| `**Status:** NEEDS_FIX` matchar i dokumentation | Naiv regex                             | Använd `^`-anchor + `m`-flagga                       |
| `claude --print` frågar efter förtydliganden    | Ny session utan kontext                | Skriv absoluta sökvägar i prompten                   |
| pushState-patching fungerar ej                  | Andra extensions skriver över patchen  | Använd `setInterval`-polling (500ms) istället        |
| File System Access API tappas vid navigering    | Webbläsarsäkerhet                      | Använd bridge.js HTTP-server                         |
| Extension går inte att ladda om externt         | Chrome säkerhetsbegränsning            | `externally_connectable` + `chrome.runtime.reload()` |

---

## Snabbstart för nytt projekt

```bash
# 1. Kopiera dessa filer till projektmappen:
#    bridge.js, dev-loop.js, test-feedback.md, TESTING.md

# 2. Uppdatera PORT och ALLOWED i bridge.js

# 3. Lägg till i manifest.json:
#    "externally_connectable": { "matches": ["https://dinsite.se/*"] }

# 4. Lägg till i background.js:
#    chrome.runtime.onMessageExternal.addListener((msg, _, res) => {
#      if (msg.action === 'reload') { res({ok:true}); chrome.runtime.reload(); }
#    });

# 5. Starta servrarna (Windows PowerShell):
Start-Process node -ArgumentList 'bridge.js' -WindowStyle Hidden
Start-Process node -ArgumentList 'dev-loop.js' -WindowStyle Hidden

# 6. Kontrollera att de kör:
cat bridge.log      # → [bridge] Running on port 7824
cat dev-loop.log    # → [dev-loop] Watching ... / Waiting for NEEDS_FIX

# 7. Ge Claude Code engångsinstruktionen (avsnitt 5)
# 8. Ge Claude Desktop prompten (avsnitt 6) med rätt extension ID
# 9. Börja testa!
```

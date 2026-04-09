# AI Property Scout — CLAUDE.md

Kontext för Claude Code. Läs detta innan du gör ändringar i projektet.

---

## Vad projektet är

Chrome Extension (Manifest V3) för Hemnet.se och Booli.se. Injicerar en collapsible sidebar som:

- Skrapar fastighetsdata från sidan
- Beräknar kostnader (lagfart, pantbrev, månadskostnad med ränteavdrag)
- Kör AI-analys på mäklartext och PDF-dokument (årsredovisning, besiktningsprotokoll)

Två användarsegment: **Spekulanter (B2C)** och **Mäklare (B2B)**.

---

## Filstruktur

| Fil                               | Ansvar                                                          |
| --------------------------------- | --------------------------------------------------------------- |
| `src/content.js`                  | DOM-scraping, sidebar-injektion, kalkylator, UI-logik, portfolio-lagring |
| `src/background.js`               | AI-anrop, PDF-pipeline, request queue, licensvalidering         |
| `src/selectors.js`                | Remote selector config + lokal fallback, hälsopoäng             |
| `src/utils.js`                    | Formattering (SEK), kostnadsuträkningar, trafikljus-logik       |
| `src/options.js` / `options.html` | API-nyckel, provider-val, licensinmatning, white label (`options_page`) |
| `src/popup.js` / `popup.html`     | Extension-popup: portfolio-vy (alla analyserade objekt)         |
| `src/analytics.js`                | Event tracking, lokal kö, batch-flush till Supabase             |
| `src/pdfExtractor.js`             | Injiceras i öppna PDF-flikar för textextraktion                 |
| `src/reportExporter.js`           | Branded PDF-export + HTML-nedladdning (mäklarläge)              |
| `selectors.json`                  | Remote selector config (hämtas från GitHub raw, cachas 24h)     |
| `esbuild.config.js`               | Bundler — injicerar `.env`-variabler som compile-time constants |
| `.env`                            | Hemliga värden — gitignorerad, aldrig committa                  |

**Bygg alltid efter ändringar i `src/`:**

```
npm run build
```

Chrome laddar från `dist/`, inte `src/`.

---

## Portfolio-lagring och broker-funktioner

### Storage-schema

```
listing_{listingId}   — fullständigt objekt per annons:
  { listingId, url, address, price, propertyType, analyzedAt,
    analyses: [{ label, data, docType, savedAt }], notes }

portfolioIndex         — lättviktig lista för popup-vyn:
  [{ listingId, url, address, price, analyzedAt, riskSummary: { red, yellow, green } }]

pdfCache_{id}_{label}  — per-PDF-knapp cache (befintlig, behålls)
agentCache_{id}        — mäklarsidans agentData (befintlig, behålls)
analysisCache_{id}     — mäklartext-analys (befintlig, behålls)
```

Alla analyser sparas DUBBELT: i befintliga `pdfCache_*`-nycklar OCH i `listing_*` (unified schema). Unified schema driver portfolio-vyn och notes.

### Extension-popup (popup.html/popup.js)

- Klicka på extension-ikonen → öppnar `popup.html` (portfolio-vy)
- Visar alla analyserade objekt med adress, riskbadges (🔴🟡🟢), datum
- Klick på kort → öppnar Hemnet/Booli-sidan i ny flik
- "Inställningar"-knapp → `chrome.runtime.openOptionsPage()` → `options.html`

### Broker-exklusiva funktioner (visas ej för consumer tier)

- **Noteringar** — textruta i sidebaren, sparas till `listing_{id}.notes`
- **Kopiera för klientmail** — formaterar alla analyser som plaintext till clipboard
- **Upplysningslista** — extraherar `compliance_flagga:true` + röda items → nytt fönster
- **Exportera rapport** — PDF-preview i popup + "Ladda ner HTML"-knapp

---

## API-routing — kritisk arkitektur

```
Consumer (egen nyckel):  background.js → direkt → Anthropic / OpenAI
Broker (licens):         background.js → CF Worker → Anthropic / OpenAI
```

- `isBroker = license?.tier && license.tier !== 'consumer'`
- **Consumer** kräver att användaren anger sin `sk-ant-...` eller `sk-...` i options.html
- **Broker** använder `CF_WORKER_URL` + `SCOUT_TOKEN` — ingen nyckel behövs av användaren
- `CENTRAL_API_KEY` är **Worker Secret i Cloudflare** — aldrig i extension-koden
- Consumer som ser "Ange din API-nyckel" är korrekt beteende, inte ett bugg
- Ta aldrig bort `isBroker`-checken. Gör aldrig CF-proxyn tillgänglig för consumers utan licens
- Consumer-anrop till Anthropic **måste** ha headern `anthropic-dangerous-direct-browser-access: true` — annars 401. OpenAI kräver inte motsvarande.

### Compile-time constants (injiceras av esbuild från `.env`)

```
SCOUT_TOKEN       — delas mellan extension och CF Worker, verifierar anropsursprung
SUPABASE_ANON_KEY — publik anon-nyckel för analytics
CF_WORKER_URL     — https://ai-property-scout-proxy.aipropertyscout-dev.workers.dev
```

---

## Cloudflare Worker

Worker finns deployad på `https://ai-property-scout-proxy.aipropertyscout-dev.workers.dev`.

**Worker Secrets i Cloudflare Dashboard:**

- `SCOUT_TOKEN` — samma värde som i `.env`
- `CENTRAL_API_KEY` — Anthropic API-nyckel (`sk-ant-...`)

Workern måste returnera CORS-headers (`Access-Control-Allow-Origin: *`) och hantera OPTIONS preflight. Utan detta får extension-serviceworkern "failed to fetch".

**Testa att workern lever** (kör från hemnet.se devtools):

```js
fetch("https://ai-property-scout-proxy.aipropertyscout-dev.workers.dev", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "X-Scout-Token": "<SCOUT_TOKEN från .env>",
        "X-License-Id": "dev",
        "X-Provider": "anthropic",
    },
    body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: "Hej" }],
        max_tokens: 10,
    }),
})
    .then((r) => r.text())
    .then(console.log);
```

**Sätt dev-licens för att testa broker-routen** (i service worker-konsolen):

```js
chrome.storage.local.set({ license: { key: "dev", tier: "broker_pro", expiry: Date.now() + 86400000 * 365 } });
```

**Rensa storage:**

```js
chrome.storage.local.clear();
```

---

## Tiers

### Teknisk routing

| Tier          | Routing                     | Nyckel                      |
| ------------- | --------------------------- | --------------------------- |
| `consumer`    | Direkt → Anthropic / OpenAI | Användaren anger sin egen   |
| `broker_solo` | Via CF Worker               | Central (`CENTRAL_API_KEY`) |
| `broker_pro`  | Via CF Worker               | Central                     |
| `whitelabel`  | Via CF Worker               | Central                     |

Tier mappas via Lemon Squeezy `variant_id` (hårdkodat i `LS_VARIANT_TIERS` i background.js). Licens cachas 24h i `chrome.storage.local`.

### Produktdifferentiering

**Consumer** — riktar sig till privatpersoner som letar bostad.
- Måste ange egen API-nyckel (Anthropic eller OpenAI) i inställningar
- Betalar ingenting till oss — kostnaden är deras egna API-användning
- Ingen licens krävs, extensionen fungerar direkt
- Saknar alla broker-exklusiva funktioner nedan

**broker_solo** — riktar sig till enskild mäklare eller fastighetskonsult.
- Ingen egen API-nyckel behövs — central nyckel via CF Worker
- Tillgång till: Noteringar per objekt, Exportera rapport (PDF/HTML), Kopiera för klientmail, Upplysningslista
- En licens = en användare

**broker_pro** — riktar sig till mäklarteam eller byrå.
- Samma som broker_solo funktionsmässigt i nuläget
- Avsett för högre volym / fler analyser per månad
- Kan i framtiden få teamfunktioner (delad portfolio, gemensam licens)

**whitelabel** — riktar sig till mäklarkedjor eller partners som vill sätta eget varumärke.
- Samma funktioner som broker_pro
- Logotyp och färger kan anpassas via options.html (white label-fält)
- Prissätts separat, förhandlas direkt

### Vad som är broker-exklusivt i koden
Funktioner som skyddas av `isBroker`-checken i content.js:
- Noteringar (`scout-notes-card`)
- Exportera rapport (`scout-export-section`)
- Kopiera för klientmail
- Upplysningslista

---

## DOM-scraping

### Hemnet

- Använder CSS Modules (hashade klassnamn) — använd `[data-testid="..."]` och `[class*="..."]`-prefix
- Attributtabell scraping sker i tre lager (i fallback-ordning):
    1. `<strong>`-par (label + nextSibling-text)
    2. `<dt>/<dd>`-par
    3. **Leaf-element walk**: iterera alla `span/div` utan barn — om textinnehållet matchar exakt en känd label (t.ex. `"Driftkostnad"`) tas `nextElementSibling` som värde. Hemnet använder `NestList_nestListItemText`-klassen för detta. Täcker: driftkostnad, upplåtelseform, tomtarea, uppvärmning, energiklass, byggår, pantbrev, avgift, förening.
- Fallback: extrahera ur URL-slug (`/lagenhet-2rum-...`)
- JSON-LD: `scrapeHemnetJsonLd()` försöker hämta strukturdata

### Booli

- SPA-routing — sidan laddas inte om vid navigation
- `MutationObserver` + URL-change detection krävs
- Selektorer behöver verifieras i DevTools på live-sidan

### DOM-resiliens

- Remote selector config: `selectors.json` på GitHub (cachas 24h). Uppdatera den vid DOM-ändringar — användare helar sig utan ny Store-release.
- `scoreScrapeHealth()` returnerar `healthy / degraded / critical`
- Vid `degraded/critical`: badge visas i sidebar — "⚠️ Scraping degraderad – fyll i manuellt"
- Åtgärdsflöde: analytics visar `critical` → DevTools → ny selektor → uppdatera `selectors.json` på GitHub

---

## Kostnadsberäkningar

### Villa

- Lagfart: `pris × 0,015 + 825 kr`
- Pantbrev: `(pris × 0,85 − befintliga pantbrev) × 0,02 + 375 kr`
- Amorteringskrav: 2% om belåning > 70%, annars 1%
- Ränteavdrag: 30% av räntekostnaden

### BRF

- Lagfart betalas inte (ej lagfart på bostadsrätt)
- Pantbrev betalas inte
- Ränteavdrag: 30%

### Tomt

- Lagfart: `pris × 0,015 + 825 kr` (betalas även på tomt)
- Inga pantbrev (ingen byggnad)
- Ingen fastighetsavgift, ingen driftkostnad i kalkylen
- Amorteringskrav: 2% om belåning > 70%, annars 1%
- Ränteavdrag: 30%

### Fritidshus

- Samma som Villa men fastighetsavgift: 376 kr/mån (tak 4 512 kr/år, 2024)
- `classifyPropertyType` returnerar `"fritidshus"` — separat klass
- AI-prompt inkluderar extra kontroller: vatten/avlopp, vinterbonat, strandskydd, vägavgift

### Gård/Lantbruk

- Samma lagfart och pantbrev som Villa
- Fastighetsavgift varierar kraftigt (lantbruksenhet vs småhusenhet) — visas som uppskattning med varningstext
- `classifyPropertyType` returnerar `"gard"`
- AI-prompt inkluderar extra kontroller: arealfördelning, arrenden, miljötillstånd, lantbruksenhet-klassning

### Par/Kedjehus/Radhus

- Klassificeras som `"villa"` — identisk kostnadsstruktur
- URL-slugar som detekteras: `villa`, `radhus`, `parhus`, `kedjehus`

---

## AI-analyser

### PDF-analys (`ANALYZE`)

- **Besiktningsprotokoll**: returnerar JSON-array med kategori + risk (röd/gul/grön) + sammanfattning
- **Årsredovisning**: returnerar JSON-objekt med skuld/kvm, äkta/oäkta BRF, renoveringar, avgiftshöjning, parkering, IMD

### Mäklartext-analys (`INITIAL_ANALYSIS`)

- Triggas manuellt via "Analysera mäklartext"-knapp
- Skickar beskrivning + fastighetsfakta (byggår, typ, yta, energiklass etc.)
- Returnerar: sammanfattning, renoveringshistorik med år, planerade åtgärder, röda/gula/gröna flaggor, positiva detaljer (balkong, hiss etc.), juridiska villkor (juridisk person, delat ägarskap, andrahand), mäklarkritik

### Mäklarsida-extraktion (`FETCH_AGENT_PAGE`)

- Triggas via "🔍 Hämta mer info från mäklarsidan"-knapp i fakta-sektionen
- Knappen visas bara om `data.agentUrl` finns. Två kända Hemnet UTM-format:
    - `utm_content=listing` (t.ex. Länsfast)
    - `utm_medium=referral` (t.ex. Skandiamaklarna)
    - Banker (SBAB, Ikano, ICA) filtreras bort — de använder `medium=integration/display/banner`
- Flöde: content.js begär `chrome.permissions.request({ origins: [origin/*] })` → background öppnar bakgrundsflik → väntar `status:complete` → **sleep 3,5s** (SPA routing) → `executeScript` med polling + retry → stänger fliken → AI extraherar strukturerat JSON → returnerar `{ data, pdfLinks }`
- `optional_host_permissions: ["*://*/*"]` i manifest — begärs per domän vid första användning, Chrome kommer ihåg
- Extraherade fält: antal_sovrum, fasad, tak, stomme, grundläggning, fönster, ventilation, uppvärmning, fastighetsbeteckning, energiprestanda_kwh, renoveringar, taxeringsvärde, fastighetsskatt, vatten_avlopp, servitut, biarea, parkering
- PDF-länkar renderas som klickbara `<a>`-taggar ovanför drop-zonen — öppna i ny flik → auto-detect hittar dem

**SPA-robusthet i executeScript:**

- Sleep 3,5s efter `status:complete` för att låta React/Next.js slutföra client-side routing
- Retry-loop (max 3 försök, 2,5s väntan) fångar "Frame with ID 0 was removed"-fel (ramen förstörs vid SPA-navigation)
- Accordion-expansion: klickar `[aria-expanded="false"]`, `details:not([open]) > summary` etc. vid 1,5s och 3,5s för att avslöja dolt innehåll
- Content-stabilisering: väntar tills `document.body.textContent.length` är oförändrat 2 omgångar i rad (800ms-intervall), minst 3 000 tecken — mer robust än keyword-check
- DOM-walk skippar containers med `>2` barn-element för att undvika falska träffar
- Råtext (20 000 tecken) skickas till AI som fallback om DOM-walk missar fält

### Fri fråga (`CUSTOM_PROMPT`)

- Textfält under annonsanalysen — användaren skriver en valfri fråga
- Skickar fråga + fastighetsfakta + beskrivning (max 4 000 tecken) till AI
- Svar renderas som fritext inline i sidebar
- max_tokens: 600

### Keyword-scan (ingen AI, direkt i sidebar)

- `buildDescriptionHighlights()` i content.js
- Skannar beskrivningstexten efter nyckelord och extraherar år
- Röda flaggor: radon, asbest, eternit, mögel, fukt, tomträtt, oäkta
- Gula flaggor: originalskick, äldre standard, potential, upprustning
- Info: juridisk person, delat ägarskap, andrahandsuthyrning

---

## PDF-pipeline

1. **Strategi 1** — Sök öppen PDF-flik med rätt nyckelord (`besiktning`, `årsredovisning`)
2. **Strategi 2** — Direkt fetch av PDF-länk (tyst fail vid CORS)
3. **Strategi 3** — Drag & drop / filuppladdning / paste (primär UX)

Ingen pdf.js. PDF skickas som base64 direkt till Claude, eller text extraheras via `pdfExtractor.js`.

Pre-filtrering: `extractRelevantPages()` filtrerar ut sidor med relevanta nyckelord, max 30 000 tecken till AI.

---

## Sidebar-struktur

Ordning uppifrån och ned:

1. Fastighet (adress, pris, snabb-badges)
2. Fakta (boarea, rum, byggår, energiklass-badge, lagfart-estimat)
3. Mäklartext — nyckelinfo (automatisk keyword-scan)
4. Annonsanalys AI (knapp → `INITIAL_ANALYSIS`) + fri fråga (textfält → `CUSTOM_PROMPT`)
5. Kostnadskalkyl (kontantinsats, ränta-slider, ränteavdrag) — stöder villa, bostadsrätt, tomt
6. Dokumentanalys / PDF-drop
7. Analysresultat

Sidebaren är injekcerad i en Shadow DOM (`mode: 'open'`) för att undvika CSS-konflikter med sidan.

---

## Versionshantering

Versionsnumret i `manifest.json` ska bumpa vid varje session med kodändringar, så att det syns i Chrome när en ny version laddats in.

Schema: `MAJOR.MINOR.PATCH`

- **PATCH** (+0.0.1) — buggfix, stiländring, promptjustering
- **MINOR** (+0.1.0) — ny funktion eller sektion i sidebaren
- **MAJOR** (+1.0.0) — arkitekturförändring, ny tier-logik, breaking change

Nuvarande version: `1.8.0`

**Bumpa versionen INNAN `npm run build` körs — inte i efterhand.** Varje `npm run build` ska föregås av en versionsbump om koden ändrades.

---

## Dokumentationsregel

**Vid varje betydande ändring ska följande uppdateras vid behov:**

- `CLAUDE.md` — arkitektur, nya message types, nya beräkningar, nya flöden
- AI-promptar i `background.js` — om analyskrav, schema eller kontext förändras

Vad räknas som "betydande": ny message type, ny sidebar-sektion, nytt API-flöde, ändrad kostnadsformel, ny permission, ny propertyClass.

---

## Viktiga regler

- Rör aldrig `isBroker`-logiken i `callAI()` utan att förstå konsekvenserna
- `CENTRAL_API_KEY` ska aldrig finnas i extension-koden — alltid Worker Secret
- `SCOUT_TOKEN` är compile-time, bundlas in via esbuild — rotera vid misstänkt läcka via ny Store-release
- Booli-selektorer är TODO — verifiera alltid i DevTools på live-sidan innan du skriver selektorer
- `selectors.json` på GitHub och `DEFAULT_SELECTORS` i `selectors.js` ska hållas synkade

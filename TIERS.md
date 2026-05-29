# Tier-referens — AI Property Scout

## Priser & kvoter

| Tier         | Pris      | AI-analyser/mån | Portfolio  |
|--------------|-----------|-----------------|------------|
| Gratis       | 0 kr      | 3 totalt        | 30 obj     |
| Spekulant    | 89 kr/mån | 30              | 30 obj     |
| Broker Solo  | 349 kr/mån| 100             | 200 obj    |
| Broker Pro   | 699 kr/mån| 300             | Obegränsat |
| White Label  | Avtal     | 2 000 (tak)     | Obegränsat |

White Label säljs inte direkt — kontakt och prisförhandling krävs.

---

## Vad räknas mot kvoten

Räknas: `INITIAL_ANALYSIS`, `ANALYZE` (PDF), `FETCH_AGENT_PAGE`, `CUSTOM_PROMPT`  
Räknas inte: Keyword-scan (ren DOM-sökning, ingen AI)

---

## Funktioner per tier

| Funktion                        | Gratis | Spekulant | Solo | Pro | WL |
|---------------------------------|--------|-----------|------|-----|----|
| Nyckelordsscan                  | ✓      | ✓         | ✓    | ✓   | ✓  |
| Kostnadskalkyl                  | ✓      | ✓         | ✓    | ✓   | ✓  |
| AI mäklartext-analys            | ✓      | ✓         | ✓    | ✓   | ✓  |
| PDF-analys                      | ✓      | ✓         | ✓    | ✓   | ✓  |
| Mäklarsida-extraktion           | ✓      | ✓         | ✓    | ✓   | ✓  |
| Fri fråga                       | ✓      | ✓         | ✓    | ✓   | ✓  |
| Portfolio (max objekt)          | 30     | 30        | 200  | ∞   | ∞  |
| Noteringar per objekt           | –      | –         | ✓    | ✓   | ✓  |
| FML-checklista                  | –      | –         | ✓    | ✓   | ✓  |
| BRF-sammanfattning för klient   | –      | –         | ✓    | ✓   | ✓  |
| Besiktning — köparfrågor & svar | –      | –         | ✓    | ✓   | ✓  |
| Exportera rapport (PDF/HTML)    | –      | –         | ✓    | ✓   | ✓  |
| Kopiera för klientmail          | –      | –         | ✓    | ✓   | ✓  |
| Upplysningslista                | –      | –         | ✓    | ✓   | ✓  |
| Branded PDF-export              | –      | –         | Solo | Pro | WL |
| Eget varumärke                  | –      | –         | –    | –   | ✓  |

---

## Teknisk routing

| Tier         | API-routing          | Licens              |
|--------------|----------------------|---------------------|
| Gratis       | Via CF Worker        | Ingen (device-ID)   |
| Spekulant    | Via CF Worker        | LemonSqueezy        |
| Broker Solo  | Via CF Worker        | LemonSqueezy        |
| Broker Pro   | Via CF Worker        | LemonSqueezy        |
| White Label  | Via CF Worker        | LemonSqueezy/manuell|

---

## LemonSqueezy variant-IDs

> OBS: Nedanstående är test-mode IDs. Uppdatera när live-mode produkter skapas.

| Tier         | Variant-ID (test) | Variant-ID (live) |
|--------------|-------------------|-------------------|
| Spekulant    | 936197            | –                 |
| Broker Solo  | 936220            | –                 |
| Broker Pro   | 936227            | –                 |
| White Label  | 936245            | –                 |

---

## Beta-nycklar

Nycklar med prefix `SCOUT-BETA-` valideras mot CF Worker (`BETA_KEYS` secret).  
Aktiverar `broker_pro` i 30 dagar per aktivering.  
Avaktivera: ta bort `BETA_KEYS`-secreten i Cloudflare Dashboard.

---

## Platser att uppdatera vid kvot/prisändring

1. `TIERS.md` (denna fil)
2. CF Worker — `TIER_QUOTAS` och `FREE_TIER_LIMIT`
3. `docs/index.html` — pristabell och kvotrad

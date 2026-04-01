import { trackEvent, flushEvents } from "./analytics.js";
import { parseAIJson, sleep } from "./utils.js";

const SCOUT_TOKEN = process.env.SCOUT_TOKEN;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const CF_WORKER_URL = process.env.CF_WORKER_URL;

if (!SCOUT_TOKEN) {
  throw new Error("[Scout] SCOUT_TOKEN not injected by bundler");
}
if (!SUPABASE_ANON_KEY) {
  throw new Error("[Scout] SUPABASE_ANON_KEY not injected by bundler");
}
if (!CF_WORKER_URL) {
  throw new Error("[Scout] CF_WORKER_URL not injected by bundler");
}

const BROKER_MODEL_ANTHROPIC = "claude-sonnet-4-6";
const BROKER_MODEL_OPENAI = "gpt-4o";
const CONSUMER_DEFAULT_MODEL_ANTHROPIC = "claude-sonnet-4-6";
const CONSUMER_DEFAULT_MODEL_OPENAI = "gpt-4o";
// Cheaper models for PDF extraction and free/consumer_pro tier
const ANALYZE_MODEL_ANTHROPIC = "claude-haiku-4-5-20251001";
const ANALYZE_MODEL_OPENAI = "gpt-4o-mini";

const LS_VARIANT_TIERS = {
  936197: "consumer_pro",
  936220: "broker_solo",
  936227: "broker_pro",
  936245: "whitelabel"
};

let currentAbortController = null;

async function validateLicense(licenseKey) {
  const stored = await chrome.storage.local.get("license");
  const cached = stored.license;
  if (cached?.key === licenseKey && cached?.expiry > Date.now()) {
    return cached.tier;
  }
  const isExpired = cached?.expiry && cached.expiry <= Date.now();
  let data;
  try {
    const res = await fetch("https://api.lemonsqueezy.com/v1/licenses/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: licenseKey })
    });
    data = await res.json();
  } catch (_) {
    console.debug("[Scout] License validation failed – falling back");
    return !isExpired && cached?.tier ? cached.tier : "consumer";
  }
  if (!data.valid) {
    throw new Error("invalid_license");
  }
  const variantId = data.meta?.variant_id;
  const tier = LS_VARIANT_TIERS[variantId] || "consumer";
  await chrome.storage.local.set({
    license: { key: licenseKey, tier, expiry: Date.now() + 864e5 }
  });
  return tier;
}

async function callAI(payload, analysisType = "listing") {
  const { license, apiKey, aiProvider, analyticsUserId } = await chrome.storage.local.get([
    "license",
    "apiKey",
    "aiProvider",
    "analyticsUserId"
  ]);
  async function doFetch(url, options) {
    currentAbortController = new AbortController();
    const res = await fetch(url, { ...options, signal: currentAbortController.signal });
    if (!res.ok) {
      const err = new Error(`API error ${res.status}`);
      err.status = res.status;
      try {
        const errBody = await res.clone().text();
        console.log("[Scout] API error body:", errBody.slice(0, 400));
        if (res.status === 429) {
          const parsed = JSON.parse(errBody);
          err.isQuotaError = parsed?.error === "quota_exceeded";
        }
      } catch (_) {
        err.isQuotaError = false;
      }
      throw err;
    }
    return res.json();
  }
  const VALID_PROVIDERS = ["anthropic", "openai"];
  const safeProvider = VALID_PROVIDERS.includes(aiProvider) ? aiProvider : "anthropic";
  const tier = license?.tier;
  const isBroker = tier && tier !== "consumer" && tier !== "consumer_pro";
  const isConsumerPro = tier === "consumer_pro";
  // Route via CF Worker if: broker, consumer_pro, or no own API key (free tier)
  const useProxy = isBroker || isConsumerPro || !apiKey;
  // Native PDF API (type: "document" content blocks) requires this beta header
  const hasPdfDocs = payload.body?.messages?.some(m =>
    Array.isArray(m.content) && m.content.some(c => c.type === "document")
  );
  if (useProxy) {
    const defaultModel = isBroker
      ? (safeProvider === "openai" ? BROKER_MODEL_OPENAI : BROKER_MODEL_ANTHROPIC)
      : (safeProvider === "openai" ? ANALYZE_MODEL_OPENAI : ANALYZE_MODEL_ANTHROPIC);
    const model = payload.body.model || defaultModel;
    const proxyHeaders = {
      "Content-Type": "application/json",
      "X-Scout-Token": SCOUT_TOKEN,
      "X-Provider": safeProvider,
      "X-Analysis-Type": analysisType
    };
    if (license?.key) {
      proxyHeaders["X-License-Id"] = license.key;
    } else {
      // Free tier — use analyticsUserId as stable device identifier
      const deviceId = analyticsUserId || crypto.randomUUID();
      proxyHeaders["X-Device-Id"] = deviceId;
      if (!analyticsUserId) {
        await chrome.storage.local.set({ analyticsUserId: deviceId });
      }
    }
    if (hasPdfDocs && safeProvider === "anthropic") {
      proxyHeaders["anthropic-beta"] = "pdfs-2024-09-25";
    }
    return doFetch(CF_WORKER_URL, {
      method: "POST",
      headers: proxyHeaders,
      body: JSON.stringify({ ...payload.body, model })
    });
  } else {
    // Legacy: own API key, route directly to provider
    const model = safeProvider === "openai"
      ? payload.model || payload.body?.model || CONSUMER_DEFAULT_MODEL_OPENAI
      : payload.model || payload.body?.model || CONSUMER_DEFAULT_MODEL_ANTHROPIC;
    const providerUrl = safeProvider === "openai" ? "https://api.openai.com/v1/chat/completions" : "https://api.anthropic.com/v1/messages";
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    };
    if (safeProvider === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      headers["anthropic-dangerous-direct-browser-access"] = "true";
      if (hasPdfDocs) {
        headers["anthropic-beta"] = "pdfs-2024-09-25";
      }
      delete headers["Authorization"];
    }
    return doFetch(providerUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...payload.body, model })
    });
  }
}

let queue = [];
let isProcessing = false;
const MAX_RATE_LIMIT_RETRIES = 3;

async function enqueueRequest(payload, analysisType = "listing") {
  return new Promise((resolve, reject) => {
    queue.push({ payload, analysisType, resolve, reject, retries: 0 });
    if (!isProcessing) {
      processQueue();
    }
  });
}

async function processQueue() {
  isProcessing = true;
  while (queue.length > 0) {
    const { payload, analysisType, resolve, reject, retries } = queue.shift();
    try {
      const result = await callAI(payload, analysisType);
      resolve(result);
    } catch (e) {
      if (e.name === "AbortError") {
        reject(e);
      } else if (e.status === 429) {
        if (e.isQuotaError) {
          chrome.runtime.sendMessage({ type: "SIDEBAR_STATUS", status: "quota_exceeded" }).catch(() => {});
          reject(new Error("quota_exceeded"));
        } else if (retries < MAX_RATE_LIMIT_RETRIES) {
          queue.unshift({ payload, resolve, reject, retries: retries + 1 });
          chrome.runtime.sendMessage({
            type: "SIDEBAR_STATUS",
            status: "rate_limit",
            msg: `Rate limit – väntar 60s... (försök ${retries + 1}/${MAX_RATE_LIMIT_RETRIES}, ${queue.length + 1} i kö)`
          });
          await sleep(6e4);
        } else {
          reject(e);
        }
      } else {
        reject(e);
      }
    }
    await sleep(500);
  }
  isProcessing = false;
}

async function handleInitialAnalysis(msg) {
  const { beskrivning, propertyData } = msg;
  const { license, aiProvider } = await chrome.storage.local.get(["license", "aiProvider"]);
  const safeProvider = ["anthropic", "openai"].includes(aiProvider) ? aiProvider : "anthropic";
  const contextLines = [
    propertyData?.address ? `Adress: ${propertyData.address}` : null,
    propertyData?.price ? `Utgångspris: ${propertyData.price}` : null,
    propertyData?.byggnadsår ? `Byggår: ${propertyData.byggnadsår}` : null,
    propertyData?.propertyType ? `Typ: ${propertyData.propertyType}` : null,
    propertyData?.livingArea ? `Boarea: ${propertyData.livingArea}` : null,
    propertyData?.antalRum ? `Antal rum: ${propertyData.antalRum}` : null,
    propertyData?.tomtstorlek ? `Tomtstorlek: ${propertyData.tomtstorlek}` : null,
    propertyData?.energiklass ? `Energiklass: ${propertyData.energiklass}` : null,
    propertyData?.uppvarmning ? `Uppvärmning: ${propertyData.uppvarmning}` : null,
    propertyData?.upplatelseform ? `Upplåtelseform: ${propertyData.upplatelseform}` : null,
    propertyData?.driftkostnad ? `Driftkostnad: ${propertyData.driftkostnad}` : null,
    propertyData?.avgift ? `BRF-avgift: ${propertyData.avgift}` : null,
    propertyData?.pantbrev ? `Befintliga pantbrev: ${propertyData.pantbrev}` : null,
    propertyData?.brfName ? `Förening: ${propertyData.brfName}` : null
  ].filter(Boolean).join("\n");
  const systemPrompt = `Du är en erfaren svensk fastighetsmäklare och byggnadsinspektör. Analysera mäklartexten och fastighetsfakta nedan. Extrahera all teknisk, ekonomisk och juridisk nyckelinformation med precision.

Svara ENBART med ett JSON-objekt utan markdown:
{
  "sammanfattning": "2-3 meningar om fastighetens skick, ålder och viktigaste faktorer",
  "renoveringar": [{ "typ": "string", "år": "string|null", "notering": "string" }],
  "planerade_atgarder": [{ "rubrik": "string", "detalj": "string" }],
  "rod_flaggor": [{ "rubrik": "string", "detalj": "string" }],
  "gul_flaggor": [{ "rubrik": "string", "detalj": "string" }],
  "gron_flaggor": [{ "rubrik": "string", "detalj": "string" }],
  "positiva_detaljer": ["string"],
  "villkor": {
    "juridisk_person": true | false | null,
    "delat_agarskap": true | false | null,
    "andrahandsuthyrning": true | false | null,
    "ombildning_pagaende": true | false | null
  },
  "maklar_kritik": "string | null"
}

INSTRUKTIONER — titta SPECIFIKT efter:

Renoveringar (lista med år om möjligt):
  kök, badrum, tak, stambyte, fönster, fasad, el/elsystem, ventilation, dränering, värmepump, bergvärme, fjärrvärme, garage, carport

RÖDA flaggor (allvarliga risker):
  - Radon omnämnt utan bekräftad mätning eller utan "låga värden"
  - Fukt, mögel, röta, vattenläckage
  - Asbest eller eternit (fasadplattor innehåller ofta asbest)
  - Blyröd / äldre vattenledningar (byggnader före ca 1970)
  - Rötrisk i konstruktionen
  - Tomträtt (kommunen äger marken — avgift omförhandlas)
  - Oäkta BRF (>40% intäkter från lokaler — sämre skattevillkor)
  - Avgiftshöjning planerad eller aviserad
  - "Originalskick", "äldre standard", "behöver renoveras", "stor potential" (köparen renoverar)
  - Oklar eller gammal dränering (villa byggd före 1980)
  - Servitut eller inskränkning som begränsar nyttjandet

GULA flaggor (notera och undersök vidare):
  - Oklar energistatus eller saknad energideklaration
  - Äldre fönster (single/tvåglas, tätningslister)
  - Ospecificerad renovering utan år
  - "Varsamt renoverat" utan detaljer
  - Osäker upplåtelseform
  - Närheten till trafikbuller, kraftledning eller industri om nämnt
  - Äldre stammar utan bekräftat stambyte (villa/hus > 40 år)

GRÖNA flaggor (positiva faktorer):
  - Genomförda renoveringar med år (ju nyare desto bättre)
  - Nytt värmesystem (bergvärme, värmepump, fjärrvärme)
  - Bra energiklass (A eller B)
  - Radon mätt — bekräftat låga värden
  - Nyinstallation av el, ventilation eller dränering
  - Solceller eller laddbox för elbil

Positiva detaljer (lista om de nämns):
  balkong, terrass, uteplats, hiss, förråd, garage, parkering, carport,
  solceller, laddbox, fiber/bredband, eldstad/kamin, bastu, pool

Juridiska villkor (sätt true/false/null):
  - juridisk_person: "Juridisk person accepteras"
  - delat_agarskap: "Delat ägarskap" eller "samägande"
  - andrahandsuthyrning: "Andrahandsuthyrning möjlig/tillåten"
  - ombildning_pagaende: "Ombildning" till bostadsrätt pågår

Planerade åtgärder:
  Allt som nämns om framtida renoveringar, planerade investeringar eller kommande förändringar.

Mäklarkritik (maklar_kritik):
  Jämför marknadsföringsspråk mot faktiska uppgifter. Om mäklaren skriver "välskött" men beskrivningen antyder eftersatt underhåll, eller "låg avgift" men fakta visar hög belåning — påpeka detta kortfattat (max 1 mening). Annars null.

FASTIGHETSTYPSPECIFIKA TILLÄGG:

Om fastighetstypen är Fritidshus — titta EXTRA efter:
  - Vatten och avlopp: kommunalt, enskilt eller inget? Brunt vatten, sämre tryck?
  - Vinterbonat: kan stugan användas året runt, eller bara sommartid?
  - Vägavgifter och vinterväghållning: enskild väg, delar kostnad med grannar?
  - Strandskydd: eventuella inskränkningar i nyttjande nära vatten
  - Tillgänglighet: hur långt från närmaste samhälle/service?
  - Elförsörjning: elnätsanslutet eller solceller/batteri?

Om fastighetstypen är Gård/Lantbruk — titta EXTRA efter:
  - Areal och markanvändning: åkermark, skogsmark, betesmark — hur fördelas det?
  - Lantbruksenhet vs småhusenhet: påverkar taxering och bolånevillkor kraftigt
  - Befintliga arrenden: jordbruksarrende, jakträtt, nyttjanderätt
  - Miljötillstånd och föroreningsrisker: gamla bensinstationer, industri, bekämpningsmedel
  - Driftskostnader: maskinpark, byggnadsunderhåll, djurhållning?
  - Eventuell "skogsbruksplan" eller befintlig brukare av marken`;
  const userContent = contextLines ? `Fastighetsfakta:\n${contextLines}\n\nMäklartext:\n${beskrivning}` : beskrivning;
  const LIMIT = 8e3;
  const truncated = userContent.length > LIMIT;
  const safeContent = truncated ? userContent.slice(0, LIMIT) + "\n[text trunkerad]" : userContent;
  let body;
  if (safeProvider === "anthropic") {
    body = {
      system: systemPrompt,
      messages: [{ role: "user", content: safeContent }],
      max_tokens: 2500
    };
  } else {
    body = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: safeContent }
      ],
      max_tokens: 2500
    };
  }
  const result = await enqueueRequest({ body }, "listing");
  const rawText = safeProvider === "anthropic" ? result?.content?.[0]?.text : result?.choices?.[0]?.message?.content;
  const parsed = parseAIJson(rawText);
  return { ok: true, data: parsed || rawText, truncated };
}

const KEY_INFO_FOCUS = {
  "badrum": "Badrum: renoverat år, dusch/badkar, golvvärme, kakel/klinker.",
  "kök": "Kök: renoverat år, vitvaror, bänkyta, köksluckor/fronter.",
  "fönster": "Fönster: antal glas (2-glas/3-glas), bytta år, orientering/väderstreck.",
  "el": "El: elcentral/säkringsskåp bytt, jordat, år.",
  "tak": "Tak: taktäckningsmaterial, bytt år, kondition.",
  "stambyte": "Stambyte: år, typ (relining vs komplett byte).",
  "fasad": "Fasad: material, bytt år.",
  "ventilation": "Ventilation: typ (FTX/mekanisk/självdrag), bytt år.",
  "värmepump": "Värmepump: installationsår, effekt om nämnt.",
  "bergvärme": "Bergvärme: installationsår, leverantör om nämnt.",
  "fjärrvärme": "Fjärrvärme: leverantör, kostnad om nämnt.",
  "dränering": "Dränering: år, kondition.",
  "avlopp": "Avlopp/VA: typ (kommunalt/enskilt), kondition, år.",
  "grund": "Grund: typ (platta/krypgrund/källare), kondition.",
  "isolering": "Isolering: var (vind/vägg/golv), år, material."
};

async function handleKeyInfoDetails(msg) {
  const { items, beskrivning } = msg;
  const { aiProvider } = await chrome.storage.local.get(["aiProvider"]);
  const safeProvider = ["anthropic", "openai"].includes(aiProvider) ? aiProvider : "anthropic";
  const itemLines = items.map((i) => `- ${KEY_INFO_FOCUS[i.key] || i.label} (JSON-nyckel: "${i.key}")`).join("\n");
  const systemPrompt = `Du är en byggnadsinspektör. Analysera mäklartexten och skriv för varje nyckelord en faktabaserad sammanfattning på max 2 meningar. Var specifik om vad texten faktiskt säger — hitta inte på info som inte finns. Om info saknas, ange det kortfattat.

Svara ENBART med ett JSON-objekt utan markdown-block:
{ "results": { "<nyckel>": "<sammanfattning>", ... } }

Nyckelord och fokus:
${itemLines}`;
  const safeText = beskrivning.slice(0, 6e3);
  let body;
  if (safeProvider === "anthropic") {
    body = {
      system: systemPrompt,
      messages: [{ role: "user", content: `Mäklartext:\n${safeText}` }],
      max_tokens: 700
    };
  } else {
    body = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Mäklartext:\n${safeText}` }
      ],
      max_tokens: 700
    };
  }
  const result = await enqueueRequest({ body }, "custom_prompt");
  const rawText = safeProvider === "anthropic" ? result?.content?.[0]?.text : result?.choices?.[0]?.message?.content;
  const parsed = parseAIJson(rawText);
  return { ok: true, data: parsed || {} };
}

async function handleCustomPrompt(msg) {
  const { question, beskrivning, propertyData, agentData, analysisContext } = msg;
  const { aiProvider } = await chrome.storage.local.get(["aiProvider"]);
  const safeProvider = ["anthropic", "openai"].includes(aiProvider) ? aiProvider : "anthropic";
  const contextLines = [
    propertyData?.address ? `Adress: ${propertyData.address}` : null,
    propertyData?.price ? `Pris: ${propertyData.price}` : null,
    propertyData?.propertyType ? `Typ: ${propertyData.propertyType}` : null,
    propertyData?.livingArea ? `Boarea: ${propertyData.livingArea}` : null,
    propertyData?.byggnadsår ? `Byggår: ${propertyData.byggnadsår}` : null
  ].filter(Boolean).join("\n");
  const agentLines = agentData ? [
    agentData.fasad ? `Fasad: ${agentData.fasad}` : null,
    agentData.tak ? `Tak: ${agentData.tak}` : null,
    agentData.stomme ? `Stomme: ${agentData.stomme}` : null,
    agentData.grundlaggning ? `Grundläggning: ${agentData.grundlaggning}` : null,
    agentData.fonster ? `Fönster: ${agentData.fonster}` : null,
    agentData.ventilation ? `Ventilation: ${agentData.ventilation}` : null,
    agentData.uppvarmning ? `Uppvärmning: ${agentData.uppvarmning}` : null,
    agentData.vatten_avlopp ? `Vatten & avlopp: ${agentData.vatten_avlopp}` : null,
    agentData.taxeringsvarde ? `Taxeringsvärde: ${agentData.taxeringsvarde} kr` : null,
    agentData.fastighetsskatt ? `Fastighetsskatt: ${agentData.fastighetsskatt} kr` : null,
    agentData.energiprestanda_kwh ? `Energiprestanda: ${agentData.energiprestanda_kwh} kWh/m²/år` : null,
    agentData.parkering ? `Parkering: ${agentData.parkering}` : null,
    agentData.servitut ? `Servitut: ${agentData.servitut}` : null,
    Array.isArray(agentData.renoveringar) && agentData.renoveringar.length > 0 ? `Renoveringar: ${agentData.renoveringar.join(", ")}` : null
  ].filter(Boolean).join("\n") : null;
  const systemPrompt = `Du är en kunnig svensk fastighetsmäklare och ekonomisk rådgivare. Svara kortfattat och faktabaserat på frågan om fastigheten nedan. Använd bara information som ges — hitta inte på uppgifter som saknas.`;
  const userContent = [
    contextLines ? `Fastighetsfakta:\n${contextLines}` : null,
    agentLines ? `Teknisk info från mäklarsidan:\n${agentLines}` : null,
    analysisContext ? `Tidigare AI-analyser:\n${analysisContext}` : null,
    beskrivning ? `Mäklartext:\n${beskrivning.slice(0, 4e3)}` : null,
    `Fråga: ${question}`
  ].filter(Boolean).join("\n\n");
  let body;
  if (safeProvider === "anthropic") {
    body = {
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
      max_tokens: 600
    };
  } else {
    body = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ],
      max_tokens: 600
    };
  }
  const result = await enqueueRequest({ body }, "custom_prompt");
  const rawText = safeProvider === "anthropic" ? result?.content?.[0]?.text : result?.choices?.[0]?.message?.content;
  return { ok: true, answer: rawText || "" };
}

async function handleBuyerInfo(msg) {
  const { propertyData, analysisSummary } = msg;
  const { aiProvider } = await chrome.storage.local.get(["aiProvider"]);
  const safeProvider = ["anthropic", "openai"].includes(aiProvider) ? aiProvider : "anthropic";
  const factsLines = [
    propertyData?.address ? `Adress: ${propertyData.address}` : null,
    propertyData?.price ? `Pris: ${propertyData.price}` : null,
    propertyData?.livingArea ? `Boarea: ${propertyData.livingArea}` : null,
    propertyData?.antalRum ? `Antal rum: ${propertyData.antalRum}` : null,
    propertyData?.byggnadsår ? `Byggår: ${propertyData.byggnadsår}` : null,
    propertyData?.propertyType ? `Typ: ${propertyData.propertyType}` : null,
    propertyData?.avgift ? `BRF-avgift: ${propertyData.avgift}` : null
  ].filter(Boolean).join("\n");
  const systemPrompt = `Du är en kunnig och omtänksam fastighetsmäklare. Din uppgift är att skriva ett köparinformationsdokument på svenska — riktat till potentiella köpare, inte mäklare. Dokumentet ska vara lättläst, konkret och hjälpa köparen att förstå vad de köper och vilka risker/fördelar som finns. Lyft fram viktiga fynd från analyserna på ett tydligt men icke-alarmistiskt sätt. Strukturera med rubriker. Max 600 ord.`;
  const userContent = [
    factsLines ? `Fastighetsfakta:\n${factsLines}` : null,
    propertyData?.description ? `Mäklartext:\n${propertyData.description}` : null,
    analysisSummary ? `AI-analyser:\n${analysisSummary}` : null
  ].filter(Boolean).join("\n\n");
  let body;
  if (safeProvider === "anthropic") {
    body = { system: systemPrompt, messages: [{ role: "user", content: userContent }], max_tokens: 900 };
  } else {
    body = { messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }], max_tokens: 900 };
  }
  const result = await enqueueRequest({ body }, "custom_prompt");
  const text = safeProvider === "anthropic" ? result?.content?.[0]?.text : result?.choices?.[0]?.message?.content;
  return { ok: true, text: text || "" };
}

async function handleTextReview(msg) {
  const { description, analysisSummary, propertyData } = msg;
  const { aiProvider } = await chrome.storage.local.get(["aiProvider"]);
  const safeProvider = ["anthropic", "openai"].includes(aiProvider) ? aiProvider : "anthropic";
  const factsLines = [
    propertyData?.address ? `Adress: ${propertyData.address}` : null,
    propertyData?.price ? `Pris: ${propertyData.price}` : null,
    propertyData?.byggnadsår ? `Byggår: ${propertyData.byggnadsår}` : null,
    propertyData?.propertyType ? `Typ: ${propertyData.propertyType}` : null
  ].filter(Boolean).join("\n");
  const systemPrompt = `Du är en erfaren mäklargranskare. Jämför mäklartexten mot AI-analysresultaten och identifiera: (1) vad som stämmer överens, (2) vad som saknas eller tonas ned i mäklartexten jämfört med analyserna, (3) eventuella överdrifter eller vilseledande formuleringar. Ge konkreta, faktabaserade synpunkter strukturerade med tydliga rubriker. Var professionell — syftet är att hjälpa mäklaren förbättra texten, inte att kritisera. Max 500 ord.`;
  const userContent = [
    factsLines ? `Fastighetsfakta:\n${factsLines}` : null,
    `Mäklartext:\n${description}`,
    `AI-analyser:\n${analysisSummary}`
  ].filter(Boolean).join("\n\n");
  let body;
  if (safeProvider === "anthropic") {
    body = { system: systemPrompt, messages: [{ role: "user", content: userContent }], max_tokens: 800 };
  } else {
    body = { messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }], max_tokens: 800 };
  }
  const result = await enqueueRequest({ body }, "custom_prompt");
  const text = safeProvider === "anthropic" ? result?.content?.[0]?.text : result?.choices?.[0]?.message?.content;
  return { ok: true, text: text || "" };
}

async function handleFetchAgentPage(msg) {
  const { url } = msg;
  const tab = await chrome.tabs.create({ url, active: false });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("timeout"));
    }, 3e4);
    function listener(tabId, info) {
      if (tabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
  await sleep(2000);
  // Briefly make tab active so visibility-dependent SPAs (Next.js, React lazy loaders)
  // trigger IntersectionObserver / visibilitychange rendering, then return focus
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null]);
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  await sleep(1500);
  if (activeTab?.id) {
    await chrome.tabs.update(activeTab.id, { active: true }).catch(() => {});
  }
  await sleep(1000);
  let extractionResult;
  try {
    let results;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => new Promise((resolve) => {
            const LABEL_MAP = {
              "fasad": "fasad",
              "fasadmaterial": "fasad",
              "tak": "tak",
              "takkonstruktion": "tak",
              "takmaterial": "tak",
              "stomme": "stomme",
              "stommaterial": "stomme",
              "hustyp": "stomme",
              "grundläggning": "grundlaggning",
              "grund": "grundlaggning",
              "grundkonstruktion": "grundlaggning",
              "fönster": "fonster",
              "fönstertyp": "fonster",
              "ventilation": "ventilation",
              "ventilationssystem": "ventilation",
              "uppvärmning": "uppvarmning",
              "uppvärmningssystem": "uppvarmning",
              "värmekälla": "uppvarmning",
              "värme": "uppvarmning",
              "energikälla": "uppvarmning",
              "fastighetsbeteckning": "fastighetsbeteckning",
              "energiklass": "energiklass_raw",
              "energiprestanda": "energiprestanda_raw",
              "energiprestanda primärenergital": "energiprestanda_raw",
              "taxeringsvärde": "taxeringsvarde_raw",
              "taxeringsvärde 2024": "taxeringsvarde_raw",
              "fastighetsskatt": "fastighetsskatt_raw",
              "kommunal fastighetsavgift": "fastighetsskatt_raw",
              "vatten & avlopp": "vatten_avlopp",
              "vatten och avlopp": "vatten_avlopp",
              "va": "vatten_avlopp",
              "vatten/avlopp": "vatten_avlopp",
              "parkering": "parkering",
              "parkeringsplats": "parkering",
              "garage": "parkering",
              "antal rum": "antal_rum_raw",
              "rum": "antal_rum_raw",
              "bo-/biarea": "biarea_combined_raw",
              "biarea": "biarea_raw",
              "renoveringar": "renoveringar_raw",
              "renoverat": "renoveringar_raw",
              "byggnadstyp": "byggnadstyp",
              "byggnadsform": "byggnadstyp",
              "servitut och andra rättigheter": "servitut",
              "servitut": "servitut",
              "rättigheter": "servitut"
            };
            function normalise(s) {
              return s.replace(/[\u00a0\s]+/g, " ").trim().toLowerCase();
            }
            function tryExpandAccordions() {
              [
                ...document.querySelectorAll('[aria-expanded="false"]'),
                ...document.querySelectorAll("details:not([open]) > summary"),
                ...document.querySelectorAll('button[class*="accordion"], button[class*="toggle"], button[class*="expand"]'),
                ...document.querySelectorAll('[class*="accordion"][class*="toggle"]')
              ].forEach((el) => {
                try {
                  el.click();
                } catch (_) {
                }
              });
            }
            function extract() {
              const direct = {};
              document.querySelectorAll("span, div, dt, td, p, li, th, strong, b").forEach((el) => {
                if (el.children.length > 3) {
                  return;
                }
                const label = normalise(el.textContent);
                const field = LABEL_MAP[label];
                if (!field || direct[field]) {
                  return;
                }
                const valueEl = el.nextElementSibling || el.parentElement?.nextElementSibling;
                const val = valueEl?.textContent?.replace(/[\u00a0\s]+/g, " ").trim().slice(0, 300);
                if (val && normalise(val) !== label) {
                  direct[field] = val;
                }
              });
              const clone = document.body.cloneNode(true);
              clone.querySelectorAll("script, style, noscript, svg").forEach((e) => e.remove());
              const text = clone.textContent.replace(/[\u00a0\s]+/g, " ").trim().slice(0, 2e4);
              const DOC_TEXT_KW = ["besiktning", "protokoll", "energideklaration", "årsredovisning", "arsredovisning", "tillstånd", "bygglov"];
              const GENERIC_LINK_TEXT = /^(öppna|ladda ner|download|open|visa|hämta|se dokument|pdf|fil)$/i;
              const linkDocs = [...document.querySelectorAll("a[href]")].filter((a) => {
                const href = a.href.toLowerCase();
                return href.includes(".pdf") || a.href.startsWith("blob:");
              }).map((a) => {
                const rawText = a.textContent.replace(/\s+/g, " ").trim().slice(0, 120);
                let label = rawText;
                if (!label || GENERIC_LINK_TEXT.test(label)) {
                  // Walk up up to 4 levels to find a sibling <p> with a descriptive label
                  let ancestor = a.parentElement;
                  for (let i = 0; i < 4 && ancestor; i++) {
                    const pEl = ancestor.querySelector("p");
                    if (pEl && pEl.textContent.trim() && !GENERIC_LINK_TEXT.test(pEl.textContent.trim())) {
                      label = pEl.textContent.trim().slice(0, 120);
                      break;
                    }
                    ancestor = ancestor.parentElement;
                  }
                }
                return { label: label || rawText || "Dokument", url: a.href };
              }).filter((l) => l.label.length >= 2);
              const buttonDocs = [...document.querySelectorAll("button")].filter((btn) => {
                const text = btn.textContent.trim().toLowerCase();
                return text.length >= 4 && text.length <= 200 && DOC_TEXT_KW.some((kw) => text.includes(kw));
              }).map((btn) => ({
                label: btn.querySelector("p")?.textContent.trim().slice(0, 120) || btn.textContent.trim().replace(/\s+/g, " ").slice(0, 120),
                url: null
              }));
              const seen = new Set();
              const pdfLinks = [...linkDocs, ...buttonDocs].filter((l) => {
                const key = l.label.toLowerCase().replace(/\s+/g, "").slice(0, 30);
                if (seen.has(key)) {
                  return false;
                }
                seen.add(key);
                return true;
              });
              return { text, direct, pdfLinks };
            }
            async function extractWithBlobs() {
              const result = extract();
              for (const link of result.pdfLinks) {
                if (link.url?.startsWith("blob:")) {
                  try {
                    const resp = await fetch(link.url);
                    const blob = await resp.blob();
                    link.pdfBase64 = await new Promise((res, rej) => {
                      const reader = new FileReader();
                      reader.onload = () => res(reader.result.split(",")[1]);
                      reader.onerror = rej;
                      reader.readAsDataURL(blob);
                    });
                    link.url = null;
                  } catch (_) {
                    link.url = null;
                  }
                }
              }
              return result;
            }
            setTimeout(tryExpandAccordions, 1500);
            setTimeout(tryExpandAccordions, 3500);
            let lastLen = 0;
            let stableCount = 0;
            const deadline = Date.now() + 25e3;
            function check() {
              const currentLen = document.body.textContent.length;
              if (currentLen > 3e3 && currentLen === lastLen) {
                stableCount++;
                if (stableCount >= 2) {
                  resolve(extractWithBlobs());
                  return;
                }
              } else {
                stableCount = 0;
              }
              lastLen = currentLen;
              if (Date.now() > deadline) {
                resolve(extractWithBlobs());
                return;
              }
              setTimeout(check, 800);
            }
            setTimeout(check, 2e3);
          })
        });
        break;
      } catch (e) {
        const isFrameError = e.message?.includes("Frame with ID 0") || e.message?.includes("Cannot access") || e.message?.includes("No frame with id");
        if (isFrameError && attempt < 2) {
          await sleep(2500);
          continue;
        }
        throw e;
      }
    }
    extractionResult = results?.[0]?.result;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
  if (!extractionResult?.text) {
    throw new Error("Ingen text kunde extraheras från sidan");
  }
  const { direct } = extractionResult;
  const { aiProvider } = await chrome.storage.local.get(["aiProvider"]);
  const safeProvider = ["anthropic", "openai"].includes(aiProvider) ? aiProvider : "anthropic";
  const directHint = Object.keys(direct).length > 0 ? `\nDirekttext hittad i DOM (använd dessa som grund, tolka nummer från texten):\n${JSON.stringify(direct, null, 2)}\n` : "";
  const systemPrompt = `Du är en dataextraktor för svenska fastighetsannonser. Extrahera strukturerad teknisk och ekonomisk information. DOM-walken har redan hittat en del fält — använd dem och komplettera från rårexten.

Svara ENBART med ett JSON-objekt utan markdown:
{
  "antal_sovrum": number | null,
  "fasad": "string | null",
  "tak": "string | null",
  "stomme": "string | null",
  "grundlaggning": "string | null",
  "fonster": "string | null",
  "ventilation": "string | null",
  "uppvarmning": "string | null",
  "fastighetsbeteckning": "string | null",
  "energiprestanda_kwh": number | null,
  "renoveringar": ["string"] | null,
  "taxeringsvarde": number | null,
  "fastighetsskatt": number | null,
  "vatten_avlopp": "string | null",
  "servitut": "string | null",
  "biarea": number | null,
  "parkering": "string | null"
}

Returnera null för fält du inte hittar. Inga kommentarer, inga extra fält.`;
  const userContent = `${directHint}\nRåtext från mäklarsidan:\n${extractionResult.text}`;
  let body;
  const agentModel = safeProvider === "openai" ? ANALYZE_MODEL_OPENAI : ANALYZE_MODEL_ANTHROPIC;
  if (safeProvider === "anthropic") {
    body = {
      model: agentModel,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
      max_tokens: 800
    };
  } else {
    body = {
      model: agentModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ],
      max_tokens: 800
    };
  }
  const result = await enqueueRequest({ body }, "agent_page");
  const rawText = safeProvider === "anthropic" ? result?.content?.[0]?.text : result?.choices?.[0]?.message?.content;
  const parsed = parseAIJson(rawText);
  return {
    ok: true,
    data: parsed || {},
    pdfLinks: extractionResult.pdfLinks
  };
}

function extractRelevantPages(fullText) {
  const KEYWORDS = [
    "förvaltningsberättelse",
    "balansräkning",
    "resultaträkning",
    "långfristiga skulder",
    "lån",
    "avsättningar",
    "avgift",
    "stambyte",
    "renovering",
    "underhållsplan",
    "parkering",
    "garage",
    "IMD",
    "individuell mätning",
    "elabonnemang"
  ];
  const pages = fullText.split(/\f|\[sida \d+\]/i);
  const relevant = pages.filter((page) => KEYWORDS.some((kw) => page.toLowerCase().includes(kw)));
  const source = relevant.length > 0 ? relevant : pages;
  const joined = source.join("\n---\n");
  const LIMIT = 3e4;
  if (joined.length > LIMIT) {
    return { text: joined.slice(0, LIMIT), truncated: true, originalLength: joined.length };
  }
  return { text: joined, truncated: false };
}

async function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const binStr = bytes.reduce((acc, b) => acc + String.fromCharCode(b), "");
  return btoa(binStr);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ANALYZE") {
    handleAnalyze(msg).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "INITIAL_ANALYSIS") {
    handleInitialAnalysis(msg).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "KEY_INFO_DETAILS") {
    handleKeyInfoDetails(msg).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "CUSTOM_PROMPT") {
    handleCustomPrompt(msg).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "BUYER_INFO") {
    handleBuyerInfo(msg).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "TEXT_REVIEW") {
    handleTextReview(msg).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === "FETCH_AGENT_PAGE") {
    handleFetchAgentPage(msg).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "VALIDATE_LICENSE") {
    validateLicense(msg.licenseKey).then((tier) => sendResponse({ tier })).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "ABORT_REQUEST") {
    currentAbortController?.abort();
    currentAbortController = null;
    sendResponse({ ok: true });
  }
  if (msg.type === "FLUSH_ANALYTICS") {
    flushEvents(true).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "AUTO_DETECT_PDF") {
    const PDF_KEYWORDS = ["besiktning", "arsredovisning", "årsredovisning"];
    chrome.tabs.query({}, (tabs) => {
      const pdfTab = tabs.find(
        (t) => t.url?.includes(".pdf") && PDF_KEYWORDS.some((kw) => t.url.includes(kw))
      );
      if (pdfTab) {
        chrome.scripting.executeScript(
          { target: { tabId: pdfTab.id }, files: ["pdfExtractor.js"] },
          () => sendResponse({})
        );
      } else {
        sendResponse({});
      }
    });
    return true;
  }
  if (msg.type === "FETCH_PDF") {
    fetchPDFFromBackground(msg.url).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "PDF_TEXT") {
    handlePdfText(msg.text, msg.tabId ?? sender.tab?.id).then(sendResponse);
    return true;
  }
});

async function fetchPDFFromBackground(url) {
  // Strategy 1: direct fetch
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const buffer = await res.arrayBuffer();
    const base64 = await bufferToBase64(buffer);
    return { base64 };
  } catch (_) {
    // fall through to Strategy 2
  }
  // Strategy 2: open PDF URL in background tab, fetch it from the page's own origin (bypasses CORS)
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onTabComplete);
        reject(new Error("tab_load_timeout"));
      }, 15000);
      function onTabComplete(tabId, info) {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onTabComplete);
          clearTimeout(timeout);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(onTabComplete);
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: async () => {
        try {
          const res = await fetch(location.href);
          if (!res.ok) {
            return null;
          }
          const buffer = await res.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          const chunks = [];
          for (let i = 0; i < bytes.length; i += 8192) {
            chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
          }
          return btoa(chunks.join(""));
        } catch (_) {
          return null;
        }
      }
    });
    chrome.tabs.remove(tab.id).catch(() => {});
    const base64 = results?.[0]?.result;
    console.log("[Scout] Strategy 2 result:", base64 ? `base64 ${base64.length} chars` : "null");
    if (base64) {
      return { base64 };
    }
    return { error: "cors_no_data" };
  } catch (e) {
    console.log("[Scout] Strategy 2 error:", e.message);
    if (tab) {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
    return { error: e.message };
  }
}

const pdfTextResolvers = new Map();

async function handlePdfText(text, tabId) {
  const resolver = pdfTextResolvers.get(tabId);
  if (resolver) {
    pdfTextResolvers.delete(tabId);
    resolver(text);
  }
  return { ok: true };
}

async function handleAnalyze(msg) {
  const { docType, pdfText, pdfBase64, propertyData, tabId } = msg;
  const startTime = Date.now();
  const { license, aiProvider } = await chrome.storage.local.get(["license", "aiProvider"]);
  const tier = license?.tier || "consumer";
  let systemPrompt;
  let userContent;
  if (docType === "stadgar") {
    systemPrompt = `Du är en juridisk rådgivare för bostadsköpare. Analysera bifogade föreningsstadgar.
Svara ENDAST med JSON-array, inga markdown-fences:
[
  { "kategori": "Andrahandsuthyrning", "risk": "röd|gul|grön", "sammanfattning": "..." },
  { "kategori": "Husdjur", "risk": "röd|gul|grön", "sammanfattning": "..." },
  { "kategori": "Renoveringsregler", "risk": "röd|gul|grön", "sammanfattning": "..." },
  { "kategori": "Ansvarsgränser (förening vs. brf-havare)", "risk": "röd|gul|grön", "sammanfattning": "..." },
  { "kategori": "Övrigt viktigt för köpare", "risk": "röd|gul|grön", "sammanfattning": "..." }
]
Röd = restriktivt/ogynnsamt för köpare, Gul = obs/begränsat, Grön = OK/köparvänligt.`;
  } else if (docType === "besiktning") {
    systemPrompt = `Du är en svensk byggnadsinspektör. Analysera bifogat besiktningsprotokoll.
Svara ENDAST med JSON-array, inga markdown-fences:
[
  { "kategori": "Fukt & Mögel", "risk": "röd|gul|grön", "sammanfattning": "...", "compliance_flagga": true|false },
  { "kategori": "Tak & Yttertak", "risk": "röd|gul|grön", "sammanfattning": "...", "compliance_flagga": true|false },
  { "kategori": "Dränering & Grund", "risk": "röd|gul|grön", "sammanfattning": "...", "compliance_flagga": true|false },
  { "kategori": "El & Säkerhet", "risk": "röd|gul|grön", "sammanfattning": "...", "compliance_flagga": true|false },
  { "kategori": "Övrigt kritiskt", "risk": "röd|gul|grön", "sammanfattning": "...", "compliance_flagga": true|false }
]`;
  } else {
    systemPrompt = `Du är en svensk ekonomianalytiker specialiserad på bostadsrättsföreningar.
Analysera bifogad årsredovisning och svara ENDAST med ett JSON-objekt, inga markdown-fences:
{
  "skuld_kr": number | null,
  "total_yta_kvm": number | null,
  "lan_per_kvm": number | null,
  "akta": "äkta" | "oäkta" | "okänd",
  "akta_forklaring": "max 2 meningar",
  "renoveringar": [{ "typ": "string", "år": "string" }],
  "avgiftshojning_planerad": true | false | null,
  "avgiftshojning_notering": "string | null",
  "parkering": "ingår" | "kö" | "saknas" | "okänd",
  "imd": true | false | null,
  "gemensamt_elavtal": true | false | null,
  "notering": "övriga kritiska fynd, max 3 meningar"
}
Regler:
- äkta = >60% av föreningens intäkter från bostadsrättsmedlemmar
- oäkta = >40% av intäkterna från lokaler/kommersiella hyresgäster
- Stambyte räknas som renovering med typ "stambyte"
- Returnera null för fält du inte hittar i dokumentet`;
  }
  const safeProvider = ["anthropic", "openai"].includes(aiProvider) ? aiProvider : "anthropic";
  const analyzeModel = safeProvider === "openai" ? ANALYZE_MODEL_OPENAI : ANALYZE_MODEL_ANTHROPIC;
  let body;
  let truncated = false;
  if (pdfBase64 && safeProvider === "anthropic") {
    body = {
      model: analyzeModel,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: pdfBase64 }
          },
          { type: "text", text: "Analysera dokumentet." }
        ]
      }],
      max_tokens: 1200
    };
  } else {
    const filtered = extractRelevantPages(pdfText || "");
    truncated = filtered.truncated;
    if (safeProvider === "anthropic") {
      body = {
        model: analyzeModel,
        system: systemPrompt,
        messages: [{ role: "user", content: filtered.text }],
        max_tokens: 1000
      };
    } else {
      body = {
        model: textAnalyzeModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: filtered.text }
        ],
        max_tokens: 1000
      };
    }
  }
  console.log("[Scout] ANALYZE path:", pdfBase64 ? `pdfBase64 (${pdfBase64.length} chars)` : `pdfText (${(pdfText||"").length} chars)`, "model:", body.model || "(callAI default)", "docType:", docType, "max_tokens:", body.max_tokens);
  try {
    const result = await enqueueRequest({ body }, "pdf");
    const rawText = safeProvider === "anthropic" ? result?.content?.[0]?.text : result?.choices?.[0]?.message?.content;
    const parsed = parseAIJson(rawText);
    const isEmpty = !parsed || (Array.isArray(parsed) && parsed.length === 0) || (typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0);
    if (isEmpty) {
      console.log("[Scout] ANALYZE empty result — rawText:", rawText?.slice(0, 600));
    }
    await trackEvent("analysis_completed", {
      doc_type: docType,
      latency_ms: Date.now() - startTime,
      tier
    });
    return {
      ok: true,
      data: parsed || rawText,
      truncated,
      docType
    };
  } catch (e) {
    console.log("[Scout] ANALYZE error:", e.message);
    if (e.name !== "AbortError") {
      await trackEvent("analysis_failed", {
        error_type: e.message,
        doc_type: docType,
        tier
      });
    }
    throw e;
  }
}

chrome.alarms.create("analytics_flush", { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "analytics_flush") {
    flushEvents();
  }
});

chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message.action === "reload") {
    sendResponse({ ok: true });
    chrome.runtime.reload();
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    const { license } = await chrome.storage.local.get("license");
    const tier = license?.tier || "consumer";
    await trackEvent("extension_installed", { tier });
  }
});

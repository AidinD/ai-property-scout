import { loadSelectors, scrapeField, scoreScrapeHealth } from "./selectors.js";
import { formatSEK, formatSEKMonth, parseSEK, trafficLight, classifyPropertyType, calculateVillaCosts, calculateBrfCosts, calculateTomtCosts } from "./utils.js";
import { trackEvent } from "./analytics.js";
import { exportReport } from "./reportExporter.js";

const hostname = location.hostname;
const site = hostname === "hemnet.se" || hostname === "www.hemnet.se" ? "hemnet" : "booli";
let lastScrapedURL = null;
let sidebarRoot = null;
let shadowRoot = null;
let keyInfoFindings = [];
let keyInfoAIData = {};
let currentPropertyData = null;
const allAnalysisExports = new Map(); // label → { data, docType, label }
let analyzeQueue = Promise.resolve(); // serializes concurrent ANALYZE calls
let activeAnalyzeCount = 0;
const blobDocMap = new Map();

function scrapeHemnetJsonLd() {
  for (const script of document.querySelectorAll("script")) {
    try {
      const obj = JSON.parse(script.textContent);
      if (obj?.["@context"]?.includes("schema.org")) {
        return obj;
      }
    } catch (_) {
    }
  }
  return null;
}

async function scrapeProperty() {
  const selectors = await loadSelectors();
  const s = selectors[site];
  const data = {};
  data.price = scrapeField(s.price);
  data.address = scrapeField(s.address);
  data.livingArea = scrapeField(s.livingArea);
  data.propertyType = scrapeField(s.propertyType);
  if (site === "hemnet") {
    if (!data.price) {
      for (const el of document.querySelectorAll("h1,h2")) {
        if (/\d[\d\s\u00a0]+\s*kr/.test(el.textContent)) {
          data.price = el.textContent.trim();
          break;
        }
      }
    }
    if (!data.livingArea) {
      for (const el of document.querySelectorAll("strong,b")) {
        if (/^\d+([,.]\d+)?\s*m²$/.test(el.textContent.trim())) {
          data.livingArea = el.textContent.trim();
          break;
        }
      }
    }
    if (!data.propertyType) {
      const segments = location.pathname.split("/").filter((p) => p.length > 0);
      const typeSlug = segments.find(
        (p) => p.startsWith("villa") || p.startsWith("radhus") || p.startsWith("lagenhet") || p.startsWith("bostadsratt") || p.startsWith("tomt") || p.startsWith("fritidshus")
      ) || "";
      if (typeSlug.startsWith("villa") || typeSlug.startsWith("radhus") || typeSlug.startsWith("fritidshus")) {
        data.propertyType = "Villa";
      } else if (typeSlug.startsWith("lagenhet") || typeSlug.startsWith("bostadsratt")) {
        data.propertyType = "Bostadsrätt";
      } else if (typeSlug.startsWith("tomt")) {
        data.propertyType = "Tomt";
      }
      const rumMatch = typeSlug.match(/(\d+)rum/);
      if (rumMatch && !data.antalRum) {
        data.antalRum = rumMatch[1] + " rum";
      }
    }
    document.querySelectorAll("strong").forEach((el) => {
      const label = el.textContent.trim().toLowerCase();
      const val = el.nextSibling?.textContent?.trim() || el.parentElement?.nextElementSibling?.textContent?.trim();
      if (!val) {
        return;
      }
      if (label.includes("avgift")) {
        data.avgift = val;
      }
      if (label.includes("driftkostnad")) {
        data.driftkostnad = val;
      }
      if (label.includes("pantbrev")) {
        data.pantbrev = val;
      }
      if (label.includes("upplåtelseform")) {
        data.upplatelseform = val;
      }
      if (label.includes("uppvärmning")) {
        data.uppvarmning = val;
      }
      if (label.includes("rum") || label.includes("antal rum")) {
        data.antalRum = val;
      }
      if (label.includes("energiklass") || label.includes("energiprestanda")) {
        data.energiklass = val;
      }
      if (label.includes("byggår") || label.includes("byggnadsår") || label.includes("byggd")) {
        data.byggnadsår = val;
      }
      if (label.includes("tomtstorlek") || label.includes("tomtarea") || label === "tomt") {
        data.tomtstorlek = val;
      }
    });
    document.querySelectorAll("dt").forEach((dt) => {
      const label = dt.textContent.trim().toLowerCase();
      const dd = dt.nextElementSibling;
      if (!dd) {
        return;
      }
      const val = dd.textContent.trim();
      if (label.includes("avgift")) {
        data.avgift = val;
      }
      if (label.includes("driftkostnad")) {
        data.driftkostnad = val;
      }
      if (label.includes("pantbrev")) {
        data.pantbrev = val;
      }
      if (label.includes("upplåtelseform")) {
        data.upplatelseform = val;
      }
      if (label.includes("uppvärmning")) {
        data.uppvarmning = val;
      }
      if (label.includes("förening") || label.includes("brf")) {
        data.brfName = val;
      }
      if (label.includes("rum") || label.includes("antal rum")) {
        data.antalRum = val;
      }
      if (label.includes("energiklass") || label.includes("energiprestanda")) {
        data.energiklass = val;
      }
      if (label.includes("byggår") || label.includes("byggnadsår") || label.includes("byggd")) {
        data.byggnadsår = val;
      }
      if (label.includes("tomtstorlek") || label.includes("tomtarea") || label === "tomt") {
        data.tomtstorlek = val;
      }
    });
    const LEAF_LABEL_MAP = {
      "driftkostnad": "driftkostnad",
      "upplåtelseform": "upplatelseform",
      "tomtarea": "tomtstorlek",
      "tomtstorlek": "tomtstorlek",
      "uppvärmning": "uppvarmning",
      "energiklass": "energiklass",
      "byggår": "byggnadsår",
      "byggnadsår": "byggnadsår",
      "antal rum": "antalRum",
      "pantbrev": "pantbrev",
      "avgift": "avgift",
      "bostadsrättsavgift": "avgift",
      "förening": "brfName",
      "brf": "brfName",
      "boarea": "livingArea",
      "boyta": "livingArea"
    };
    document.querySelectorAll("span, div").forEach((el) => {
      if (el.children.length > 0) {
        return;
      }
      const labelText = el.textContent.trim().toLowerCase();
      const fieldKey = LEAF_LABEL_MAP[labelText];
      if (!fieldKey || data[fieldKey]) {
        return;
      }
      const valueEl = el.nextElementSibling || el.parentElement?.nextElementSibling;
      if (!valueEl) {
        return;
      }
      const val = valueEl.textContent.trim();
      if (val && val !== labelText) {
        data[fieldKey] = val;
      }
    });
  }
  if (site === "hemnet") {
    const descSelectors = [
      '[data-testid="property-description"]',
      '[class*="PropertyDescription"]',
      '[class*="property-description"]',
      '[class*="Description_container"]',
      '[class*="description-text"]'
    ];
    for (const sel of descSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el?.textContent?.trim().length > 80) {
          data.beskrivning = el.textContent.trim();
          break;
        }
      } catch (_) {
      }
    }
    if (!data.beskrivning) {
      let best = "";
      document.querySelectorAll('p, [class*="text"], [class*="Text"], section').forEach((el) => {
        const t = el.textContent.trim();
        if (t.length > best.length && t.length > 150 && t.length < 5e3) {
          best = t;
        }
      });
      if (best.length > 150) {
        data.beskrivning = best;
      }
    }
  }
  const jsonLd = scrapeHemnetJsonLd();
  if (jsonLd) {
    if (!data.beskrivning && jsonLd.description) {
      data.beskrivning = jsonLd.description;
    }
    if (!data.antalRum && jsonLd.numberOfRooms) {
      data.antalRum = jsonLd.numberOfRooms + " rum";
    }
    if (!data.byggnadsår && jsonLd.yearBuilt) {
      data.byggnadsår = String(jsonLd.yearBuilt);
    }
    if (!data.address && jsonLd.name) {
      data.address = jsonLd.name;
    }
  }
  data.priceNum = parseSEK(data.price);
  data.propertyClass = classifyPropertyType(data.propertyType);
  data.pdfLinks = scrapePdfLinks();

  data.listingId = location.pathname.split("/").filter(Boolean).pop() || location.pathname;
  const agentLinkEl = document.querySelector('a[href*="utm_source=hemnet"][href*="content=listing"]') || document.querySelector('a[href*="utm_source=hemnet"][href*="utm_medium=referral"]');
  data.agentUrl = agentLinkEl?.href || null;
  return data;
}

const GENERIC_PDF_LINK = /^(öppna|ladda ner|download|open|visa|hämta|se dokument|pdf|fil)$/i;

function scrapePdfLinks() {
  return Array.from(document.querySelectorAll("a[href]"))
    .filter((a) => a.href.toLowerCase().includes(".pdf"))
    .map((a) => {
      let text = a.textContent.replace(/\s+/g, " ").trim();
      if (!text || GENERIC_PDF_LINK.test(text)) {
        let ancestor = a.parentElement;
        for (let i = 0; i < 4 && ancestor; i++) {
          const pEl = ancestor.querySelector("p");
          if (pEl && pEl.textContent.trim() && !GENERIC_PDF_LINK.test(pEl.textContent.trim())) {
            text = pEl.textContent.trim().slice(0, 120);
            break;
          }
          ancestor = ancestor.parentElement;
        }
      }
      text = text || "Dokument";
      return { href: a.href, text, docType: text.toLowerCase().includes("besiktning") ? "besiktning" : "arsredovisning" };
    });
}

function refreshHemnetDocs(data) {
  if (!shadowRoot) {
    return;
  }
  const fresh = scrapePdfLinks();
  if (fresh.length <= (data.pdfLinks?.length || 0)) {
    return;
  }
  data.pdfLinks = fresh;
  const docsSection = shadowRoot.getElementById("scout-docs-section");
  if (!docsSection) {
    return;
  }
  docsSection.style.display = "";
  const docsExtra = shadowRoot.getElementById("scout-docs-extra");
  // Rebuild all rows except scout-docs-extra
  Array.from(docsSection.children).forEach((child) => {
    if (child.id !== "scout-docs-extra") {
      child.remove();
    }
  });
  const title = document.createElement("div");
  title.style.cssText = "font-size:11px;font-weight:700;color:#6b7280;margin-bottom:5px";
  title.textContent = "DOKUMENT";
  docsSection.insertBefore(title, docsExtra);
  fresh.forEach((l) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:5px";
    row.innerHTML = `<span style="font-size:12px;color:#374151;max-width:62%">📄 ${l.text}</span>
      <button class="scout-agent-pdf-btn"
        data-url="${l.href.replace(/"/g, "&quot;")}"
        data-label="${l.text.replace(/"/g, "&quot;")}"
        style="font-size:11px;padding:3px 8px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:4px;color:#1a3c5e;cursor:pointer;font-weight:600;white-space:nowrap">
        Analysera
      </button>`;
    docsSection.insertBefore(row, docsExtra);
  });
  attachAgentPdfListeners(shadowRoot, data);
}

function injectSidebar(data) {
  if (document.getElementById("scout-host")) {
    return;
  }
  const host = document.createElement("div");
  host.id = "scout-host";
  host.style.cssText = "position:fixed;top:0;right:0;width:0;height:0;z-index:2147483647;";
  document.documentElement.appendChild(host);
  shadowRoot = host.attachShadow({ mode: "open" });
  const cssUrl = chrome.runtime.getURL("output.css");
  const linkEl = document.createElement("link");
  linkEl.rel = "stylesheet";
  linkEl.href = cssUrl;
  shadowRoot.appendChild(linkEl);
  const container = document.createElement("div");
  container.innerHTML = buildSidebarHTML(data);
  shadowRoot.appendChild(container);
  sidebarRoot = container;
  attachSidebarListeners(data);
  autoDetectPDF(data);
}

function buildSidebarHTML(data) {
  const health = scoreScrapeHealth(data);
  const degradedBadge = health.status !== "healthy" ? `<div class="scout-badge-warn">⚠️ Scraping degraderad – fyll i manuellt</div>` : "";
  const calcSection = buildCalculatorSection(data);
  const typeLabel = data.propertyClass === "villa" ? "Villa" : data.propertyClass === "bostadsratt" ? "BRF" : "";
  const quickBadges = [
    typeLabel ? `<span class="scout-quick-badge">${typeLabel}</span>` : "",
    data.antalRum ? `<span class="scout-quick-badge">${data.antalRum}</span>` : "",
    data.livingArea ? `<span class="scout-quick-badge">${data.livingArea}</span>` : ""
  ].filter(Boolean).join(" ");
  return `
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  .scout-sidebar {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    position: fixed; top: 0; right: 0;
    width: 380px; height: 100vh;
    background: #f4f6f9;
    box-shadow: -3px 0 20px rgba(0,0,0,0.18);
    display: flex; flex-direction: column;
    transition: transform 0.25s ease;
    pointer-events: all; overflow: hidden;
    z-index: 2147483647;
  }
  .scout-sidebar.collapsed { transform: translateX(348px); }
  .scout-header {
    background: linear-gradient(135deg, #1a3c5e 0%, #254e7a 100%);
    color: #fff; padding: 13px 16px;
    display: flex; align-items: center; justify-content: space-between;
    cursor: pointer; user-select: none; flex-shrink: 0;
  }
  .scout-header-title { font-size: 13px; font-weight: 700; letter-spacing: 0.4px; }
  .scout-toggle { font-size: 11px; opacity: 0.7; }
  .scout-badge-warn {
    background: #fff8e1; color: #795548; font-size: 11px;
    padding: 6px 14px; border-bottom: 1px solid #ffe082; flex-shrink: 0;
  }
  .scout-body { flex: 1; overflow-y: auto; padding: 14px 12px; }
  .scout-card {
    background: #fff; border-radius: 10px; padding: 12px 14px;
    margin-bottom: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.07);
  }
  .scout-section-title {
    font-size: 10px; font-weight: 800; text-transform: uppercase;
    letter-spacing: 0.7px; color: #8a96a3; margin-bottom: 10px;
    display: flex; align-items: center; gap: 6px;
  }
  .scout-section-title::before {
    content: ''; display: inline-block; width: 3px; height: 12px;
    background: #1a3c5e; border-radius: 2px; flex-shrink: 0;
  }
  .scout-address { font-size: 15px; font-weight: 700; color: #1a1a2e; line-height: 1.3; }
  .scout-price { font-size: 18px; font-weight: 800; color: #1a3c5e; margin: 3px 0 8px; }
  .scout-quick-badges { display: flex; flex-wrap: wrap; gap: 5px; }
  .scout-quick-badge {
    background: #e8f0fe; color: #1a3c5e; font-size: 11px; font-weight: 600;
    padding: 2px 8px; border-radius: 10px;
  }
  .scout-kv {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 12.5px; padding: 5px 0; border-bottom: 1px solid #f0f2f5;
  }
  .scout-kv:last-child { border-bottom: none; }
  .scout-kv-label { color: #6b7280; }
  .scout-kv-value { font-weight: 600; color: #1a1a2e; text-align: right; max-width: 55%; }
  .scout-divider { height: 1px; background: #f0f2f5; margin: 8px 0; }
  .scout-kv.muted .scout-kv-label { color: #9ca3af; font-size: 11.5px; }
  .scout-kv.muted .scout-kv-value { color: #9ca3af; font-size: 11.5px; font-weight: 500; }
  .scout-kv.total .scout-kv-label { color: #1a1a2e; font-weight: 700; }
  .scout-kv.total .scout-kv-value { color: #1a3c5e; font-weight: 800; font-size: 14px; }
  .scout-kv.netto .scout-kv-value { color: #2e7d32; font-weight: 700; }
  .scout-energy-badge {
    display: inline-block; font-size: 11px; font-weight: 800;
    padding: 1px 7px; border-radius: 4px; color: #fff; letter-spacing: 0.5px;
  }
  .scout-energy-A { background: #1b5e20; }
  .scout-energy-B { background: #2e7d32; }
  .scout-energy-C { background: #558b2f; }
  .scout-energy-D { background: #f9a825; color: #333; }
  .scout-energy-E { background: #ef6c00; }
  .scout-energy-F { background: #c62828; }
  .scout-energy-G { background: #7b1fa2; }
  .scout-item {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 7px 9px; border-radius: 7px; margin-bottom: 5px;
    font-size: 12.5px; line-height: 1.4;
  }
  .scout-item.red    { background: #fff5f5; border: 1px solid #fecaca; }
  .scout-item.yellow { background: #fffbeb; border: 1px solid #fde68a; }
  .scout-item.green  { background: #f0fdf4; border: 1px solid #bbf7d0; }
  .scout-item.info   { background: #eff6ff; border: 1px solid #bfdbfe; }
  .scout-item .icon  { font-size: 14px; flex-shrink: 0; margin-top: 1px; }
  .scout-item-body strong { display: block; font-weight: 600; font-size: 12.5px; color: #1a1a2e; }
  .scout-item-body p { margin: 2px 0 0; color: #555; font-size: 11.5px; line-height: 1.3; }
  .scout-item-ai-text {
    display: none; margin: 3px 0 0; color: #555;
    font-size: 11.5px; line-height: 1.35;
  }
  .scout-field { display: flex; flex-direction: column; margin-bottom: 8px; }
  .scout-field label { font-size: 11px; color: #6b7280; margin-bottom: 3px; font-weight: 500; }
  .scout-field input[type="number"], .scout-field input[type="text"] {
    border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px 10px;
    font-size: 13px; width: 100%; background: #f9fafb;
    transition: border-color 0.15s;
  }
  .scout-field input:focus { outline: none; border-color: #1a3c5e; background: #fff; }
  .scout-ränta-row {
    display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
  }
  .scout-ränta-row label { font-size: 11px; color: #6b7280; font-weight: 500; flex-shrink: 0; }
  .scout-ränta-row input[type="number"] {
    width: 60px; border: 1px solid #e5e7eb; border-radius: 6px;
    padding: 5px 8px; font-size: 13px; text-align: center; background: #f9fafb;
  }
  .scout-ränta-row input[type="range"] {
    flex: 1; accent-color: #1a3c5e; height: 4px;
  }
  .scout-btn {
    background: #1a3c5e; color: #fff; border: none; border-radius: 7px;
    padding: 9px 14px; font-size: 13px; font-weight: 600;
    cursor: pointer; width: 100%; margin-top: 4px;
    transition: background 0.15s;
  }
  .scout-btn:hover:not(:disabled) { background: #254e7a; }
  .scout-btn:disabled { background: #c9d1da; cursor: not-allowed; }
  .scout-btn.secondary {
    background: #e8f0fe; color: #1a3c5e; margin-top: 6px;
  }
  .scout-btn.secondary:hover:not(:disabled) { background: #d4e4fd; }
  .scout-status {
    font-size: 12px; color: #6b7280; text-align: center;
    padding: 6px; display: none;
  }
  .scout-status.visible { display: block; }
  .scout-drop-zone {
    border: 2px dashed #c9d4df; border-radius: 8px; padding: 16px;
    text-align: center; font-size: 12px; color: #6b7280;
    cursor: pointer; background: #f9fafb; margin-bottom: 8px;
    transition: border-color 0.15s;
  }
  .scout-drop-zone:hover { border-color: #1a3c5e; }
  .scout-drop-zone.has-content { border-color: #16a34a; background: #f0fdf4; color: #166534; }
  .scout-drop-zone textarea {
    width: 100%; height: 80px; border: none; background: transparent;
    font-size: 12px; resize: none; outline: none; color: #333;
  }
  .scout-pdf-badge {
    font-size: 11px; color: #166534; font-weight: 600;
    margin-bottom: 6px; display: none;
  }
  .scout-pdf-badge.visible { display: block; }
  .scout-results { display: none; }
  .scout-results.visible { display: block; }
  .scout-spinner {
    display: inline-block; width: 13px; height: 13px;
    border: 2px solid #e5e7eb; border-top-color: #1a3c5e;
    border-radius: 50%; animation: scout-spin 0.8s linear infinite;
    margin-right: 6px; vertical-align: middle;
  }
  @keyframes scout-spin { to { transform: rotate(360deg); } }
  .scout-property-type-select {
    width: 100%; padding: 6px 8px; font-size: 13px;
    border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 8px;
    background: #f9fafb;
  }
  .scout-calc-group-label {
    font-size: 10px; font-weight: 800; text-transform: uppercase;
    letter-spacing: 0.6px; color: #8a96a3; margin: 10px 0 5px;
  }
  .scout-calc-box {
    background: #f9fafb; border-radius: 7px; padding: 8px 10px;
    margin-bottom: 4px;
  }
  .scout-broker-badge {
    background: #dcfce7; color: #166534; font-size: 10px; font-weight: 700;
    padding: 2px 7px; border-radius: 8px; margin-left: 8px;
  }
</style>
<div class="scout-sidebar" id="scout-sidebar">
  <div class="scout-header" id="scout-toggle-btn">
    <span class="scout-toggle" id="scout-toggle-icon">◀</span>
    <span class="scout-header-title">AI Property Scout<span id="scout-broker-badge-slot"></span></span>
  </div>
  ${degradedBadge}
  <div class="scout-body" id="scout-body">

    <!-- Fastighet -->
    <div class="scout-card">
      <div class="scout-section-title">Fastighet</div>
      <div class="scout-address">${data.address || "Adress okänd"}</div>
      <div class="scout-price">${data.price || "Pris okänt"}</div>
      ${quickBadges ? `<div class="scout-quick-badges">${quickBadges}</div>` : ""}
    </div>

    <!-- Fakta -->
    ${buildFactsSection(data)}

    <!-- Mäklartext nyckelinfo -->
    ${buildDescriptionHighlights(data)}

    <!-- Property type override if unknown -->
    ${data.propertyClass === "unknown" ? `
    <div class="scout-card">
      <div class="scout-section-title">Fastighetstyp</div>
      <select class="scout-property-type-select" id="scout-type-override">
        <option value="">Välj fastighetstyp manuellt</option>
        <option value="villa">Villa / Radhus</option>
        <option value="bostadsratt">Bostadsrätt</option>
        <option value="tomt">Tomt / Mark</option>
      </select>
    </div>
    ` : ""}

    <!-- Annonsanalys (AI) -->
    ${buildListingAnalysisSection(data)}

    <!-- Kostnadskalkyl -->
    <div class="scout-card" id="scout-calc-section">
      <div class="scout-section-title">Kostnadskalkyl</div>
      <div id="scout-calc-content">${calcSection}</div>
    </div>

    <!-- Dokumentanalys (PDF) -->
    <div class="scout-card">
      <div class="scout-section-title">Dokumentanalys (AI)</div>
      <div class="scout-pdf-badge" id="scout-pdf-auto-badge">✓ PDF hittad automatiskt</div>
      <div class="scout-drop-zone" id="scout-drop-zone">
        <div id="scout-drop-prompt">
          <div style="font-size:22px;margin-bottom:6px">📄</div>
          <div style="font-weight:600;font-size:12px">Släpp årsredovisning eller besiktningsprotokoll</div>
          <div style="margin-top:4px;font-size:11px;color:#9ca3af">PDF, TXT eller klistra in text</div>
        </div>
        <textarea id="scout-pdf-text" placeholder="Klistra in text här..." style="display:none"></textarea>
      </div>
      <div style="margin-bottom:6px">
        <input type="file" id="scout-file-input" accept=".pdf,.txt" style="font-size:11px;width:100%;color:#6b7280">
      </div>
      <div class="scout-status" id="scout-analyze-status"></div>
      <button class="scout-btn" id="scout-analyze-btn" disabled>Analysera dokument</button>
    </div>

    <!-- PDF Analysresultat -->
    <div class="scout-results" id="scout-results">
      <div class="scout-card">
        <div class="scout-section-title">Analysresultat</div>
        <div id="scout-results-content"></div>
        <div id="scout-export-section" style="display:none;margin-top:10px;border-top:1px solid #e5e7eb;padding-top:10px">
          <button class="scout-btn" id="scout-export-btn">📄 Exportera rapport</button>
        </div>
      </div>
    </div>

    <!-- Upgrade CTA -->
    <div id="scout-upgrade-cta" style="display:none;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:12px;margin-bottom:12px;font-size:13px">
      <strong>Kvot uppnådd</strong><br>
      <span id="scout-upgrade-msg" style="font-size:12px;color:#6b7280">Du har nått din månadsgräns – uppgradera eller vänta till nästa månad.</span>
      <button class="scout-btn" style="margin-top:8px" id="scout-upgrade-btn">Uppgradera →</button>
    </div>

  </div>
</div>`;
}

function buildCalculatorSection(data) {
  const priceNum = data.priceNum || 0;
  const räntaField = `
      <div class="scout-ränta-row">
        <label>Ränta %</label>
        <input type="number" id="scout-ränta-input" value="4.0" min="0.5" max="15" step="0.25">
        <input type="range"  id="scout-ränta-slider" value="4.0" min="0.5" max="15" step="0.25">
      </div>`;
  if (!priceNum) {
    return `
        <div class="scout-field">
          <label>Pris (kr)</label>
          <input type="number" id="scout-price-input" placeholder="Fyll i manuellt">
        </div>
        <div class="scout-field">
          <label>Kontantinsats (kr)</label>
          <input type="number" id="scout-kontant-input" placeholder="">
        </div>
        ${räntaField}
        <button class="scout-btn secondary" id="scout-calc-btn">Beräkna</button>
        <div id="scout-calc-result"></div>`;
  }
  const defaultKontant = Math.round(priceNum * 0.15);
  return `
        <div class="scout-field">
          <label>Kontantinsats (kr)</label>
          <input type="number" id="scout-kontant-input" value="${defaultKontant}">
        </div>
        ${räntaField}
        <button class="scout-btn secondary" id="scout-calc-btn">Beräkna</button>
        <div id="scout-calc-result"></div>`;
}

function energiklassBadge(klass) {
  if (!klass) {
    return "";
  }
  const letter = klass.trim().toUpperCase().charAt(0);
  if (!/^[A-G]$/.test(letter)) {
    return `<span style="font-weight:600">${klass}</span>`;
  }
  return `<span class="scout-energy-badge scout-energy-${letter}">${letter}</span>`;
}

function buildFactsSection(data) {
  const rows = [];
  if (data.livingArea) {
    rows.push(["Boarea", data.livingArea]);
  }
  if (data.antalRum) {
    rows.push(["Antal rum", data.antalRum]);
  }
  if (data.byggnadsår) {
    rows.push(["Byggår", data.byggnadsår]);
  }
  if (data.tomtstorlek) {
    rows.push(["Tomtstorlek", data.tomtstorlek]);
  }
  if (data.upplatelseform) {
    rows.push(["Upplåtelseform", data.upplatelseform]);
  }
  if (data.brfName) {
    rows.push(["Förening", data.brfName]);
  }
  if (data.avgift) {
    rows.push(["Månadsavgift", data.avgift]);
  }
  if (data.driftkostnad) {
    rows.push(["Driftkostnad", data.driftkostnad]);
  }
  if (data.uppvarmning) {
    rows.push(["Uppvärmning", data.uppvarmning]);
  }
  const mainRows = rows.map(
    ([label, value]) => `<div class="scout-kv"><span class="scout-kv-label">${label}</span><span class="scout-kv-value">${value}</span></div>`
  ).join("");
  const hasTomträtt = (data.upplatelseform || "").toLowerCase().includes("tomträtt") || (data.beskrivning || "").toLowerCase().includes("tomträtt");
  const tomträttRow = hasTomträtt ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:7px 10px;margin-top:4px;font-size:12px;color:#b91c1c">
             <strong>⚠ Tomträtt — kommunen äger marken</strong><br>
             <span style="color:#6b7280;font-size:11px">Avgiften omförhandlas periodiskt och kan höjas kraftigt. Verifiera nästa omförhandlingstidpunkt.</span>
           </div>` : "";
  let energiBlock = "";
  if (data.energiklass) {
    const letter = data.energiklass.trim().toUpperCase().charAt(0);
    const isGreen = letter === "A" || letter === "B";
    const greenSavings = data.priceNum ? Math.round(data.priceNum * 0.85 * 1e-3 / 12) : null;
    energiBlock = `
        <div class="scout-kv">
          <span class="scout-kv-label">Energiklass</span>
          <span class="scout-kv-value">${energiklassBadge(data.energiklass)}</span>
        </div>
        ${isGreen ? `
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:7px 10px;margin-top:4px;font-size:12px">
          <strong style="color:#166534">Grönt bolån möjligt (klass ${letter})</strong><br>
          <span style="color:#6b7280;font-size:11px">
            Rabatt ~0,10 procentenheter.${greenSavings ? ` Besparing ca ${new Intl.NumberFormat("sv-SE").format(greenSavings)} kr/mån vid 85% belåning.` : ""}
          </span>
        </div>` : ""}`;
  }
  const pantbrevRow = data.pantbrev ? `<div class="scout-kv"><span class="scout-kv-label">Pantbrev (befintliga)</span><span class="scout-kv-value">${data.pantbrev}</span></div>` : "";
  let calcRows = "";
  if (data.priceNum && data.propertyClass === "villa") {
    const lagfart = Math.round(data.priceNum * 0.015 + 825);
    const pantbrevNum = parseSEK(data.pantbrev) || 0;
    const pantbrevBehov = Math.max(0, data.priceNum * 0.85 - pantbrevNum);
    const pantbrevKostnad = pantbrevBehov > 0 ? Math.round(pantbrevBehov * 0.02 + 375) : 0;
    const totalEngång = lagfart + pantbrevKostnad + Math.round(data.priceNum * 0.15);
    calcRows = `
        <div class="scout-divider"></div>
        <div class="scout-kv muted">
          <span class="scout-kv-label">Lagfart (1,5% + 825 kr)</span>
          <span class="scout-kv-value">~${new Intl.NumberFormat("sv-SE").format(lagfart)} kr</span>
        </div>
        ${pantbrevBehov > 0 ? `<div class="scout-kv muted">
                 <span class="scout-kv-label">Pantbrev (2% + 375 kr)</span>
                 <span class="scout-kv-value">~${new Intl.NumberFormat("sv-SE").format(pantbrevKostnad)} kr</span>
               </div>` : `<div class="scout-kv muted">
                 <span class="scout-kv-label">Pantbrev</span>
                 <span class="scout-kv-value" style="color:#16a34a">Täckt ✓</span>
               </div>`}
        <div class="scout-kv" style="margin-top:2px">
          <span class="scout-kv-label" style="font-weight:600;color:#374151">Totalt kontant (15% + avg.)</span>
          <span class="scout-kv-value" style="color:#1a3c5e;font-weight:700">~${new Intl.NumberFormat("sv-SE").format(totalEngång)} kr</span>
        </div>`;
  }
  const adressQuery = data.address ? encodeURIComponent(data.address.split(",")[0].trim()) : "";
  const slutprisLink = adressQuery ? `<div style="margin-top:10px">
             <a href="https://www.booli.se/slutpriser?q=${adressQuery}" target="_blank"
                style="font-size:11.5px;color:#1a3c5e;text-decoration:none;font-weight:600;display:flex;align-items:center;gap:4px">
               🔍 Jämför slutpriser på Booli →
             </a>
           </div>` : "";
  if (!mainRows && !energiBlock && !pantbrevRow && !calcRows) {
    return "";
  }
  const agentSection = data.agentUrl ? `
      <div style="margin-top:10px;border-top:1px solid #e5e7eb;padding-top:10px">
        <button class="scout-btn secondary" id="scout-agent-fetch-btn" style="width:100%">🔍 Hämta mer info från mäklarsidan</button>
        <div class="scout-status" id="scout-agent-status"></div>
        <div id="scout-agent-data"></div>
        <div id="scout-agent-refresh"></div>
      </div>` : "";
  const hemnetDocRows = (data.pdfLinks || []).map((l) => `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
          <span style="font-size:12px;color:#374151;max-width:62%">📄 ${l.text || l.docType}</span>
          <button class="scout-agent-pdf-btn"
            data-url="${l.href.replace(/"/g, "&quot;")}"
            data-label="${(l.text || l.docType).replace(/"/g, "&quot;")}"
            style="font-size:11px;padding:3px 8px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:4px;color:#1a3c5e;cursor:pointer;font-weight:600;white-space:nowrap">
            Analysera
          </button>
        </div>`).join("");
  const hemnetDocs = `
        <div id="scout-docs-section" style="margin-top:10px;border-top:1px solid #e5e7eb;padding-top:10px;${(data.pdfLinks || []).length === 0 ? "display:none" : ""}">
          <div style="font-size:11px;font-weight:700;color:#6b7280;margin-bottom:5px">DOKUMENT</div>
          ${hemnetDocRows}
          <div id="scout-docs-extra"></div>
        </div>`;
  return `
    <div class="scout-card">
      <div class="scout-section-title">Fakta</div>
      ${mainRows}${energiBlock}${pantbrevRow}${calcRows}${tomträttRow}${slutprisLink}${hemnetDocs}${agentSection}
    </div>`;
}

function buildAgentDataHTML(agentData) {
  const rows = [];
  if (agentData.antal_sovrum != null) {
    rows.push(["Antal sovrum", agentData.antal_sovrum]);
  }
  if (agentData.biarea != null) {
    rows.push(["Biarea", agentData.biarea + " m²"]);
  }
  if (agentData.fastighetsbeteckning) {
    rows.push(["Fastighetsbeteckning", agentData.fastighetsbeteckning]);
  }
  if (agentData.fasad) {
    rows.push(["Fasad", agentData.fasad]);
  }
  if (agentData.tak) {
    rows.push(["Tak", agentData.tak]);
  }
  if (agentData.stomme) {
    rows.push(["Stomme", agentData.stomme]);
  }
  if (agentData.grundlaggning) {
    rows.push(["Grundläggning", agentData.grundlaggning]);
  }
  if (agentData.fonster) {
    rows.push(["Fönster", agentData.fonster]);
  }
  if (agentData.ventilation) {
    rows.push(["Ventilation", agentData.ventilation]);
  }
  if (agentData.uppvarmning) {
    rows.push(["Uppvärmning", agentData.uppvarmning]);
  }
  if (agentData.vatten_avlopp) {
    rows.push(["Vatten & avlopp", agentData.vatten_avlopp]);
  }
  if (agentData.energiprestanda_kwh != null) {
    rows.push(["Energiprestanda", agentData.energiprestanda_kwh + " kWh/m²/år"]);
  }
  if (agentData.taxeringsvarde != null) {
    rows.push(["Taxeringsvärde", formatSEK(agentData.taxeringsvarde)]);
  }
  if (agentData.fastighetsskatt != null) {
    rows.push(["Fastighetsskatt", formatSEK(agentData.fastighetsskatt) + "/år"]);
  }
  if (agentData.parkering) {
    rows.push(["Parkering", agentData.parkering]);
  }
  if (agentData.servitut) {
    rows.push(["Servitut", agentData.servitut]);
  }
  const rowsHtml = rows.map(
    ([label, value]) => `<div class="scout-kv"><span class="scout-kv-label">${label}</span><span class="scout-kv-value" style="max-width:55%;text-align:right;word-break:break-word">${value}</span></div>`
  ).join("");
  const renovHtml = Array.isArray(agentData.renoveringar) && agentData.renoveringar.length > 0 ? `<div class="scout-divider"></div>
           <div style="font-size:11px;color:#6b7280;font-weight:600;margin-bottom:3px">Renoveringar</div>
           ${agentData.renoveringar.map(
    (r) => `<div style="font-size:12px;color:#374151;padding:1px 0">▸ ${r}</div>`
  ).join("")}` : "";
  if (!rowsHtml && !renovHtml) {
    return '<p style="font-size:12px;color:#9ca3af;margin:4px 0">Inga ytterligare uppgifter hittades.</p>';
  }
  return `
    <div style="margin-top:6px;padding:8px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px">
      <div style="font-size:11px;font-weight:700;color:#0369a1;margin-bottom:6px">📎 Från mäklarsidan</div>
      ${rowsHtml}${renovHtml}
    </div>`;
}

function renderAgentResult(shadowRoot, agentData, pdfLinks, fromCache = false) {
  const agentDataEl = shadowRoot.getElementById("scout-agent-data");
  const agentFetchBtn = shadowRoot.getElementById("scout-agent-fetch-btn");
  const agentRefreshEl = shadowRoot.getElementById("scout-agent-refresh");
  if (agentFetchBtn) {
    agentFetchBtn.style.display = "none";
  }
  if (agentDataEl) {
    agentDataEl.innerHTML = buildAgentDataHTML(agentData);
  }
  if (agentRefreshEl) {
    agentRefreshEl.innerHTML = fromCache ? `<div style="text-align:right;margin-top:4px">
                 <button id="scout-agent-reload-btn" style="background:none;border:none;color:#9ca3af;font-size:11px;cursor:pointer;padding:0">🔄 Hämta ny info</button>
               </div>` : "";
  }
  if (Array.isArray(pdfLinks) && pdfLinks.length > 0) {
    const docsExtra = shadowRoot.getElementById("scout-docs-extra");
    if (docsExtra) {
      docsExtra.innerHTML = "";
      const existingLabels = new Set(
        [...shadowRoot.querySelectorAll(".scout-agent-pdf-btn")].map((b) => b.getAttribute("data-label")?.toLowerCase().replace(/\s+/g, "") || "")
      );
      const newLinks = pdfLinks.filter(({ label: pdfLabel }) => {
        const key = (pdfLabel || "").toLowerCase().replace(/\s+/g, "");
        return key.length > 2 && !existingLabels.has(key);
      });
      if (newLinks.length > 0) {
        const docsSection = shadowRoot.getElementById("scout-docs-section");
        if (docsSection) {
          docsSection.style.display = "";
        }
        newLinks.forEach(({ label: pdfLabel, url: pdfUrl, pdfBase64 }) => {
          if (pdfBase64) {
            blobDocMap.set((pdfLabel || "").toLowerCase().replace(/\s+/g, ""), pdfBase64);
          }
          const row = document.createElement("div");
          row.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:5px";
          const hasData = pdfUrl || pdfBase64;
          const action = hasData ? `<button class="scout-agent-pdf-btn"
                               ${pdfUrl ? `data-url="${pdfUrl.replace(/"/g, "&quot;")}"` : 'data-blob="1"'}
                               data-label="${(pdfLabel || "Dokument").replace(/"/g, "&quot;")}"
                               style="font-size:11px;padding:3px 8px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:4px;color:#1a3c5e;cursor:pointer;font-weight:600;white-space:nowrap">
                               Analysera
                           </button>` : `<span style="font-size:11px;color:#9ca3af;white-space:nowrap">Ladda ner manuellt</span>`;
          row.innerHTML = `<span style="font-size:12px;color:#374151;max-width:62%">📄 ${pdfLabel || "Dokument"}</span>${action}`;
          docsExtra.appendChild(row);
        });
      }
    }
  }
}

function docTypeFromLabel(label) {
  const lower = label.toLowerCase();
  if (lower.includes("besiktning") || lower.includes("protokoll") || lower.includes("frågelista") || lower.includes("fragelista")) {
    return "besiktning";
  }
  if (lower.includes("årsredovisning") || lower.includes("arsredovisning")) {
    return "arsredovisning";
  }
  if (lower.includes("stadgar")) {
    return "stadgar";
  }
  return "besiktning";
}

function attachAgentPdfListeners(shadowRoot, propertyData) {
  shadowRoot.querySelectorAll(".scout-agent-pdf-btn:not([data-listening])").forEach((btn) => {
    btn.setAttribute("data-listening", "1");
    // Auto-restore cached result on sidebar load — no need to click again
    const autoLabel = btn.getAttribute("data-label");
    const autoCacheKey = propertyData?.listingId ? `pdfCache_${propertyData.listingId}_${autoLabel}` : null;
    if (autoCacheKey) {
      chrome.storage.local.get(autoCacheKey).then((stored) => {
        const hit = stored[autoCacheKey];
        if (hit) {
          renderResults(hit.data, hit.docType, false, autoLabel);
        }
      });
    }
    btn.addEventListener("click", async () => {
      const url = btn.getAttribute("data-url");
      const isBlob = btn.getAttribute("data-blob") === "1";
      const label = btn.getAttribute("data-label");
      if (!url && !isBlob) {
        return;
      }
      const originalBtnHTML = btn.innerHTML;
      function s(html) {
        btn.innerHTML = html || originalBtnHTML;
        btn.style.minWidth = html ? "110px" : "";
      }
      btn.disabled = true;
      s(`<span class="scout-spinner"></span> Hämtar…`);
      const pdfCacheKey = propertyData?.listingId ? `pdfCache_${propertyData.listingId}_${label}` : null;
      if (pdfCacheKey) {
        const stored = await chrome.storage.local.get(pdfCacheKey);
        const hit = stored[pdfCacheKey];
        if (hit) {
          renderResults(hit.data, hit.docType, false, label);
          s("✓ Cachat");
          setTimeout(() => { s(""); btn.disabled = false; }, 1500);
          return;
        }
      }
      // Grant all-host permission so background can bypass CORS and executeScript on any redirect target
      if (!isBlob && url) {
        await chrome.runtime.sendMessage({ type: "REQUEST_AGENT_PERMISSION", origin: "*://*/*" });
      }
      let pdfBase64;
      let pdfText;
      if (isBlob) {
        const mapKey = (label || "").toLowerCase().replace(/\s+/g, "");
        pdfBase64 = blobDocMap.get(mapKey);
        if (!pdfBase64) {
          s("⚠️ Ladda ner manuellt");
          btn.disabled = false;
          return;
        }
      } else {
        const fetchResult = await chrome.runtime.sendMessage({ type: "FETCH_PDF", url });
        if (!fetchResult?.base64 && !fetchResult?.pdfText) {
          window.open(url, "_blank");
          s("↗ Öppnad i ny flik");
          btn.disabled = false;
          return;
        }
        pdfBase64 = fetchResult.base64 || null;
        pdfText = fetchResult.pdfText || null;
      }
      const isLargePdf = pdfBase64 && pdfBase64.length > 500000;
      const docType = docTypeFromLabel(label);
      if (isLargePdf) {
        const confirmed = await new Promise((resolve) => {
          s("");
          btn.disabled = false;
          const notice = document.createElement("div");
          notice.style.cssText = "font-size:11px;background:#fff7ed;border:1px solid #fed7aa;border-radius:4px;padding:5px 8px;margin-bottom:4px;color:#92400e;line-height:1.5";
          notice.innerHTML = `⚠️ Stor PDF – kostsammare analys.
            <div style="margin-top:3px;display:flex;gap:10px">
              <a id="scout-pdf-confirm" style="color:#1a3c5e;cursor:pointer;text-decoration:underline;font-weight:600">Analysera ändå</a>
              <a id="scout-pdf-cancel" style="color:#6b7280;cursor:pointer;text-decoration:underline">Avbryt</a>
              <a id="scout-pdf-tip" style="color:#6b7280;cursor:pointer;text-decoration:underline">Drag & drop (billigare)</a>
            </div>`;
          btn.parentElement.after(notice);
          notice.querySelector("#scout-pdf-confirm").onclick = () => { notice.remove(); btn.disabled = true; resolve(true); };
          notice.querySelector("#scout-pdf-cancel").onclick = () => { notice.remove(); resolve(false); };
          notice.querySelector("#scout-pdf-tip").onclick = () => {
            notice.remove();
            shadowRoot.getElementById("scout-drop-zone")?.scrollIntoView({ behavior: "smooth", block: "center" });
            resolve(false);
          };
        });
        if (!confirmed) {
          btn.disabled = false;
          return;
        }
      }
      const inQueue = activeAnalyzeCount > 0;
      activeAnalyzeCount++;
      s(`<span class="scout-spinner"></span> ${inQueue ? "I kö…" : "Analyserar…"}`);
      const response = await new Promise((resolve) => {
        analyzeQueue = analyzeQueue.catch(() => {}).then(async () => {
          s(`<span class="scout-spinner"></span> Analyserar${isLargePdf ? " (kan ta en stund)" : ""}…`);
          try {
            const resp = await chrome.runtime.sendMessage({
              type: "ANALYZE",
              docType,
              pdfBase64,
              pdfText,
              propertyData
            });
            resolve(resp);
          } catch (e) {
            resolve({ error: e.message });
          } finally {
            activeAnalyzeCount--;
          }
        });
      });
      btn.disabled = false;
      s("");
      if (response?.error) {
        s(response.error === "no_api_key" ? "⚙️ API-nyckel saknas" : `⚠️ ${response.error.slice(0, 40)}`);
      } else {
        renderResults(response.data, response.docType || docType, response.truncated, label);
        if (pdfCacheKey) {
          chrome.storage.local.set({ [pdfCacheKey]: { data: response.data, docType: response.docType || docType, ts: Date.now() } });
        }
      }
    });
  });
}

function buildDescriptionHighlights(data) {
  const text = data.beskrivning || "";
  if (text.length < 80) {
    return "";
  }
  const lower = text.toLowerCase();
  const findings = [];
  const renovItems = [
    { key: "stambyte", label: "Stambyte", baseColor: "green" },
    { key: "tak", label: "Tak", baseColor: "green" },
    { key: "badrum", label: "Badrum", baseColor: "green" },
    { key: "kök", label: "Kök", baseColor: "green" },
    { key: "fönster", label: "Fönster", baseColor: "green" },
    { key: "fasad", label: "Fasad", baseColor: "green" },
    { key: "ventilation", label: "Ventilation", baseColor: "green" },
    { key: "värmepump", label: "Värmepump", baseColor: "green" },
    { key: "bergvärme", label: "Bergvärme", baseColor: "green" },
    { key: "fjärrvärme", label: "Fjärrvärme", baseColor: "green" },
    { key: "dränering", label: "Dränering", baseColor: "yellow" },
    { key: "avlopp", label: "Avlopp/VA", baseColor: "yellow" },
    { key: "el ", label: "El", baseColor: "yellow" },
    { key: "grund", label: "Grund", baseColor: "yellow" },
    { key: "isolering", label: "Isolering", baseColor: "yellow" }
  ];
  const redFlags = [
    { key: "radon", label: "Radon nämns – verifiera mätning" },
    { key: "asbest", label: "Asbest omnämnt" },
    { key: "eternit", label: "Eternit (kan innehålla asbest)" },
    { key: "mögel", label: "Mögel omnämnt" },
    { key: "röta", label: "Röta omnämnt" },
    { key: "fukt", label: "Fukt omnämnt" },
    { key: "servitut", label: "Servitut / inskränkning" },
    { key: "sättning", label: "Sättning omnämnt" },
    { key: "tomträtt", label: "Tomträtt — kommunen äger marken" },
    { key: "oäkta", label: "Oäkta BRF kan ge sämre skattevillkor" }
  ];
  const renovBehov = [
    { key: "originalskick", label: "Originalskick — sannolikt renoveringsbehov" },
    { key: "äldre standard", label: "Äldre standard — planera för upprustning" },
    { key: "upprustning", label: "Upprustning nämns" },
    { key: "stor potential", label: "Potential — kan dölja renoveringsbehov" },
    { key: "potential", label: "Potential omnämnt" },
    { key: "varsamt", label: "Varsamt renoverat — kolla vad som inte åtgärdats" }
  ];
  const juridikFlags = [
    { key: "juridisk person", label: "Juridisk person accepteras" },
    { key: "delat ägarskap", label: "Delat ägarskap möjligt" },
    { key: "andrahandsuthyrning", label: "Andrahandsuthyrning omnämnt" },
    { key: "ombildning", label: "Ombildning nämns" },
    { key: "avgiftshöjning", label: "Avgiftshöjning omnämnt" }
  ];
  const renovFindings = [];
  for (const item of renovItems) {
    const idx = lower.indexOf(item.key);
    if (idx === -1) {
      continue;
    }
    const near = text.slice(Math.max(0, idx - 60), Math.min(text.length, idx + 120));
    const years = near.match(/\b(19|20)\d{2}\b/g) || [];
    const yearLabel = years.length > 0 ? ` (${[...new Set(years)].join(", ")})` : "";
    const color = years.length > 0 ? item.baseColor : "yellow";
    const finding = { label: item.label + yearLabel, color, key: item.key.trim() };
    findings.push(finding);
    renovFindings.push(finding);
  }
  keyInfoFindings = renovFindings;
  for (const flag of redFlags) {
    const re = new RegExp("(?<![a-zåäö])" + flag.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (re.test(lower)) {
      findings.push({ label: flag.label, color: "red", note: "" });
    }
  }
  for (const item of renovBehov) {
    if (lower.includes(item.key)) {
      findings.push({ label: item.label, color: "yellow", note: "" });
    }
  }
  for (const flag of juridikFlags) {
    if (lower.includes(flag.key)) {
      const isRisk = flag.key === "avgiftshöjning";
      findings.push({ label: flag.label, color: isRisk ? "red" : "info", note: "" });
    }
  }
  if (findings.length === 0) {
    return "";
  }
  const items = findings.map((f) => `
      <div class="scout-item ${f.color}"${f.key ? ` data-key="${f.key}"` : ""}>
        <span class="icon">${f.color === "red" ? "🔴" : f.color === "green" ? "🟢" : f.color === "info" ? "ℹ️" : "🟡"}</span>
        <div class="scout-item-body">
          <strong>${f.label}</strong>
          ${f.key ? '<p class="scout-item-ai-text"></p>' : ""}
        </div>
      </div>`).join("");
  return `
    <div class="scout-card">
      <div class="scout-section-title">Mäklartext — nyckelinfo</div>
      ${items}
    </div>`;
}

function buildListingAnalysisSection(data) {
  if (!data.beskrivning) {
    return "";
  }
  return `
    <div class="scout-card" id="scout-listing-analysis-card">
      <div class="scout-section-title">Annonsanalys (AI)</div>
      <div class="scout-status" id="scout-listing-status"></div>
      <div id="scout-listing-results"></div>
      <div id="scout-listing-refresh"></div>
      <button class="scout-btn secondary" id="scout-listing-analyze-btn">Analysera mäklartext</button>
      <div id="scout-custom-prompt-section" style="margin-top:10px;border-top:1px solid #e5e7eb;padding-top:10px">
        <textarea id="scout-custom-prompt-input" placeholder="Ställ en egen fråga om fastigheten…" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;font-family:inherit;resize:vertical;min-height:60px;color:#1a1a2e"></textarea>
        <button class="scout-btn secondary" id="scout-custom-prompt-btn" style="margin-top:6px;width:100%">Skicka fråga</button>
        <div class="scout-status" id="scout-custom-prompt-status"></div>
        <div id="scout-custom-prompt-result"></div>
      </div>
    </div>`;
}

async function loadKeyInfoDetails(data) {
  if (!data.beskrivning || keyInfoFindings.length === 0) {
    return;
  }
  let results = null;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "KEY_INFO_DETAILS",
      items: keyInfoFindings.map((f) => ({ key: f.key, label: f.label })),
      beskrivning: data.beskrivning
    });
    if (response?.error) {
      const msg = response.error === "no_api_key" ? "AI-detaljer kräver API-nyckel (Inställningar ⚙️)" : `AI-fel: ${response.error}`;
      keyInfoAIData = Object.fromEntries(keyInfoFindings.map((f) => [f.key, msg]));
      return;
    } else if (response?.ok && response.data?.results) {
      results = response.data.results;
      keyInfoAIData = results;
    }
  } catch (e) {
    keyInfoAIData = Object.fromEntries(keyInfoFindings.map((f) => [f.key, `Fel: ${e.message}`]));
    return;
  }
  if (results) {
    shadowRoot.querySelectorAll(".scout-item[data-key]").forEach((itemEl) => {
      const key = itemEl.dataset.key;
      const text = results[key];
      if (!text) {
        return;
      }
      const p = itemEl.querySelector(".scout-item-ai-text");
      if (p) {
        p.textContent = text;
        p.style.display = "block";
      }
    });
  }
}

function attachSidebarListeners(data) {
  currentPropertyData = data;
  getTier().then((tier) => {
    if (tier === "consumer") {
      return;
    }
    const slot = shadowRoot.getElementById("scout-broker-badge-slot");
    if (slot && !slot.textContent) {
      slot.innerHTML = ` <span class="scout-broker-badge">MÄKLARE</span>`;
    }
  });
  const sidebar = shadowRoot.getElementById("scout-sidebar");
  const toggleBtn = shadowRoot.getElementById("scout-toggle-btn");
  const toggleIcon = shadowRoot.getElementById("scout-toggle-icon");
  const dropZone = shadowRoot.getElementById("scout-drop-zone");
  const pdfTextArea = shadowRoot.getElementById("scout-pdf-text");
  const fileInput = shadowRoot.getElementById("scout-file-input");
  const analyzeBtn = shadowRoot.getElementById("scout-analyze-btn");
  const calcBtn = shadowRoot.getElementById("scout-calc-btn");
  const typeOverride = shadowRoot.getElementById("scout-type-override");
  const upgradeBtn = shadowRoot.getElementById("scout-upgrade-btn");
  const räntaInput = shadowRoot.getElementById("scout-ränta-input");
  const räntaSlider = shadowRoot.getElementById("scout-ränta-slider");
  const listingAnalyzeBtn = shadowRoot.getElementById("scout-listing-analyze-btn");
  let collapsed = false;
  let pdfContent = null;
  let docType = null;
  let propertyClass = data.propertyClass;
  toggleBtn?.addEventListener("click", () => {
    collapsed = !collapsed;
    sidebar.classList.toggle("collapsed", collapsed);
    toggleIcon.textContent = collapsed ? "▶" : "◀";
  });
  typeOverride?.addEventListener("change", (e) => {
    propertyClass = e.target.value || "unknown";
    updateCalcSection(propertyClass, data);
  });
  räntaInput?.addEventListener("input", () => {
    if (räntaSlider) {
      räntaSlider.value = räntaInput.value;
    }
  });
  räntaSlider?.addEventListener("input", () => {
    if (räntaInput) {
      räntaInput.value = parseFloat(räntaSlider.value).toFixed(2);
    }
  });
  calcBtn?.addEventListener("click", () => {
    runCalculator(data, propertyClass);
  });
  listingAnalyzeBtn?.addEventListener("click", async () => {
    listingAnalyzeBtn.disabled = true;
    const statusEl = shadowRoot.getElementById("scout-listing-status");
    const resultsEl = shadowRoot.getElementById("scout-listing-results");
    if (statusEl) {
      statusEl.innerHTML = '<span class="scout-spinner"></span> AI analyserar mäklartext…';
      statusEl.classList.add("visible");
    }
    const response = await chrome.runtime.sendMessage({
      type: "INITIAL_ANALYSIS",
      beskrivning: data.beskrivning,
      propertyData: data
    });
    listingAnalyzeBtn.disabled = false;
    if (statusEl) {
      statusEl.innerHTML = "";
      statusEl.classList.remove("visible");
    }
    if (response?.error) {
      const msg = response.error === "no_api_key" ? "Ange din API-nyckel under Inställningar ⚙️" : `Fel: ${response.error}`;
      if (statusEl) {
        statusEl.innerHTML = msg;
        statusEl.classList.add("visible");
      }
    } else if (resultsEl && response?.data) {
      resultsEl.innerHTML = buildListingAnalysisResults(response.data);
      listingAnalyzeBtn.style.display = "none";
      allAnalysisExports.set("Mäklaranalys", { data: listingAnalysisToReportItems(response.data), docType: "besiktning", label: "Mäklaranalys" });
      showExportButtonIfBroker();
      const refreshEl = shadowRoot.getElementById("scout-listing-refresh");
      if (refreshEl) {
        refreshEl.innerHTML = `<div style="text-align:right;margin-bottom:6px">
                    <button id="scout-listing-reload-btn" style="background:none;border:none;color:#9ca3af;font-size:11px;cursor:pointer;padding:0">🔄 Analysera igen</button>
                </div>`;
        shadowRoot.getElementById("scout-listing-reload-btn")?.addEventListener("click", () => {
          resultsEl.innerHTML = "";
          refreshEl.innerHTML = "";
          listingAnalyzeBtn.style.display = "";
        });
      }
      if (data.listingId) {
        chrome.storage.local.set({
          [`analysisCache_${data.listingId}`]: { result: response.data, ts: Date.now() }
        });
      }
    }
  });
  const customPromptBtn = shadowRoot.getElementById("scout-custom-prompt-btn");
  const customPromptInput = shadowRoot.getElementById("scout-custom-prompt-input");
  const customPromptStatus = shadowRoot.getElementById("scout-custom-prompt-status");
  const customPromptResult = shadowRoot.getElementById("scout-custom-prompt-result");
  customPromptBtn?.addEventListener("click", async () => {
    const question = customPromptInput?.value?.trim();
    if (!question) {
      return;
    }
    customPromptBtn.disabled = true;
    if (customPromptStatus) {
      customPromptStatus.innerHTML = '<span class="scout-spinner"></span> Väntar på svar…';
      customPromptStatus.classList.add("visible");
    }
    const cachedAgent = data.listingId ? (await chrome.storage.local.get(`agentCache_${data.listingId}`))[`agentCache_${data.listingId}`] : null;
    const response = await chrome.runtime.sendMessage({
      type: "CUSTOM_PROMPT",
      question,
      beskrivning: data.beskrivning,
      propertyData: data,
      agentData: cachedAgent?.agentData || null,
      analysisContext: serializeAnalysisForPrompt()
    });
    customPromptBtn.disabled = false;
    if (customPromptStatus) {
      customPromptStatus.innerHTML = "";
      customPromptStatus.classList.remove("visible");
    }
    if (response?.error) {
      const msg = response.error === "no_api_key" ? "Ange din API-nyckel under Inställningar ⚙️" : `Fel: ${response.error}`;
      if (customPromptStatus) {
        customPromptStatus.innerHTML = msg;
        customPromptStatus.classList.add("visible");
      }
    } else if (customPromptResult && response?.answer) {
      customPromptResult.innerHTML = `<div class="scout-item info" style="margin-top:8px"><span class="icon">💬</span><div class="scout-item-body"><p>${response.answer.replace(/\n/g, "<br>")}</p></div></div>`;
    }
  });
  const agentFetchBtn = shadowRoot.getElementById("scout-agent-fetch-btn");
  const agentStatusEl = shadowRoot.getElementById("scout-agent-status");
  const agentDataEl = shadowRoot.getElementById("scout-agent-data");
  agentFetchBtn?.addEventListener("click", async () => {
    const agentUrl = data.agentUrl;
    if (!agentUrl) {
      return;
    }
    const origin = new URL(agentUrl).origin + "/*";
    const permRes = await chrome.runtime.sendMessage({ type: "REQUEST_AGENT_PERMISSION", origin });
    const granted = permRes?.granted ?? false;
    if (!granted) {
      if (agentStatusEl) {
        agentStatusEl.textContent = "Tillåtelse nekades — kan inte hämta mäklarinfo.";
        agentStatusEl.classList.add("visible");
      }
      return;
    }
    agentFetchBtn.disabled = true;
    if (agentStatusEl) {
      agentStatusEl.innerHTML = '<span class="scout-spinner"></span> Öppnar mäklarens sida… (5–10 sek)';
      agentStatusEl.classList.add("visible");
    }
    const response = await chrome.runtime.sendMessage({
      type: "FETCH_AGENT_PAGE",
      url: agentUrl
    });
    if (agentStatusEl) {
      agentStatusEl.innerHTML = "";
      agentStatusEl.classList.remove("visible");
    }
    if (response?.error) {
      if (agentStatusEl) {
        agentStatusEl.textContent = `Fel: ${response.error}`;
        agentStatusEl.classList.add("visible");
      }
      agentFetchBtn.disabled = false;
      agentFetchBtn.style.display = "";
      return;
    }
    if (response?.data) {
      renderAgentResult(shadowRoot, response.data, response.pdfLinks || [], false);
      attachAgentPdfListeners(shadowRoot, data);
      const cacheKey = `agentCache_${data.listingId}`;
      chrome.storage.local.set({
        [cacheKey]: { agentData: response.data, pdfLinks: response.pdfLinks || [], ts: Date.now() }
      });
    }
  });
  if (data.listingId) {
    chrome.storage.local.get(`analysisCache_${data.listingId}`).then((stored) => {
      const cached = stored[`analysisCache_${data.listingId}`];
      if (!cached) {
        return;
      }
      const resultsEl = shadowRoot.getElementById("scout-listing-results");
      const refreshEl = shadowRoot.getElementById("scout-listing-refresh");
      const analyzeBtnEl = shadowRoot.getElementById("scout-listing-analyze-btn");
      if (resultsEl) {
        resultsEl.innerHTML = buildListingAnalysisResults(cached.result);
      }
      if (analyzeBtnEl) {
        analyzeBtnEl.style.display = "none";
      }
      if (refreshEl) {
        refreshEl.innerHTML = `<div style="text-align:right;margin-bottom:6px">
                    <button id="scout-listing-reload-btn" style="background:none;border:none;color:#9ca3af;font-size:11px;cursor:pointer;padding:0">🔄 Analysera igen</button>
                </div>`;
        shadowRoot.getElementById("scout-listing-reload-btn")?.addEventListener("click", () => {
          if (resultsEl) {
            resultsEl.innerHTML = "";
          }
          if (refreshEl) {
            refreshEl.innerHTML = "";
          }
          if (analyzeBtnEl) {
            analyzeBtnEl.style.display = "";
          }
        });
      }
    });
  }
  if (data.agentUrl && data.listingId) {
    const cacheKey = `agentCache_${data.listingId}`;
    chrome.storage.local.get(cacheKey).then((stored) => {
      const cached = stored[cacheKey];
      if (!cached) {
        return;
      }
      renderAgentResult(shadowRoot, cached.agentData, cached.pdfLinks || [], true);
      attachAgentPdfListeners(shadowRoot, data);
      const reloadBtn = shadowRoot.getElementById("scout-agent-reload-btn");
      reloadBtn?.addEventListener("click", () => {
        const agentFetchBtnAgain = shadowRoot.getElementById("scout-agent-fetch-btn");
        const agentRefreshEl = shadowRoot.getElementById("scout-agent-refresh");
        const agentDataEl = shadowRoot.getElementById("scout-agent-data");
        if (agentFetchBtnAgain) {
          agentFetchBtnAgain.style.display = "";
          agentFetchBtnAgain.disabled = false;
        }
        if (agentRefreshEl) {
          agentRefreshEl.innerHTML = "";
        }
        if (agentDataEl) {
          agentDataEl.innerHTML = "";
        }
        const existing = shadowRoot.getElementById("scout-agent-pdf-links");
        if (existing) {
          existing.remove();
        }
      });
    });
  }
  dropZone?.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.style.borderColor = "#1a3c5e";
  });
  dropZone?.addEventListener("dragleave", () => {
    dropZone.style.borderColor = "#90a4ae";
  });
  dropZone?.addEventListener("drop", async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      await handleFileInput(file);
    }
    trackEvent("pdf_drop_zone_used", { input_method: "drop", site, tier: await getTier() });
  });
  dropZone?.addEventListener("click", () => {
    pdfTextArea.style.display = "block";
    shadowRoot.getElementById("scout-drop-prompt").style.display = "none";
    pdfTextArea.focus();
  });
  pdfTextArea?.addEventListener("input", () => {
    const val = pdfTextArea.value.trim();
    pdfContent = val || null;
    analyzeBtn.disabled = !pdfContent;
    docType = guessDocType(pdfContent || "");
    if (val) {
      dropZone.classList.add("has-content");
    } else {
      dropZone.classList.remove("has-content");
    }
    trackEvent("pdf_drop_zone_used", { input_method: "paste", site, tier: "unknown" });
  });
  fileInput?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      await handleFileInput(file);
      trackEvent("pdf_drop_zone_used", { input_method: "upload", site, tier: await getTier() });
    }
  });
  attachAgentPdfListeners(shadowRoot, data);
  analyzeBtn?.addEventListener("click", async () => {
    if (!pdfContent) {
      return;
    }
    analyzeBtn.disabled = true;
    setStatus('<span class="scout-spinner"></span> AI analyserar dokument...');
    trackEvent("pdf_analyze_clicked", { doc_type: docType || "unknown", tier: await getTier(), site });
    const response = await chrome.runtime.sendMessage({
      type: "ANALYZE",
      docType: docType || guessDocType(pdfContent),
      pdfText: pdfContent,
      propertyData: data
    });
    analyzeBtn.disabled = false;
    setStatus("");
    if (response?.error) {
      handleAnalysisError(response.error);
    } else {
      renderResults(response.data, response.docType, response.truncated);
    }
  });
  upgradeBtn?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage?.();
  });
  if (keyInfoFindings.length > 0) {
    loadKeyInfoDetails(data);
  }
  async function handleFileInput(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target.result;
        pdfContent = text;
        docType = guessDocType(text);
        fillDropZone(text, "manual");
        resolve();
      };
      if (file.type === "application/pdf") {
        reader.readAsDataURL(file);
      } else {
        reader.readAsText(file);
      }
    });
  }
}

function fillDropZone(content, source) {
  const dropZone = shadowRoot?.getElementById("scout-drop-zone");
  const pdfTextArea = shadowRoot?.getElementById("scout-pdf-text");
  const autoBadge = shadowRoot?.getElementById("scout-pdf-auto-badge");
  const analyzeBtn = shadowRoot?.getElementById("scout-analyze-btn");
  const dropPrompt = shadowRoot?.getElementById("scout-drop-prompt");
  if (!dropZone) {
    return;
  }
  pdfTextArea.style.display = "block";
  pdfTextArea.value = typeof content === "string" ? content.substring(0, 500) + "..." : "";
  dropPrompt.style.display = "none";
  dropZone.classList.add("has-content");
  analyzeBtn.disabled = false;
  if (source === "auto" && autoBadge) {
    autoBadge.classList.add("visible");
    trackEvent("pdf_auto_detected", { site });
  }
}

function setStatus(html) {
  const el = shadowRoot?.getElementById("scout-analyze-status");
  if (!el) {
    return;
  }
  el.innerHTML = html;
  el.classList.toggle("visible", !!html);
}

function guessDocType(text) {
  const lower = text.toLowerCase();
  if (lower.includes("besiktning") || lower.includes("protokoll") || lower.includes("fukt")) {
    return "besiktning";
  }
  return "arsredovisning";
}

async function getTier() {
  const { license } = await chrome.storage.local.get("license");
  return license?.tier || "consumer";
}

function runCalculator(data, propertyClass) {
  const priceInput = shadowRoot.getElementById("scout-price-input");
  const kontantInput = shadowRoot.getElementById("scout-kontant-input");
  const räntaInput = shadowRoot.getElementById("scout-ränta-input");
  const resultEl = shadowRoot.getElementById("scout-calc-result");
  const price = data.priceNum || parseInt(priceInput?.value || "0", 10);
  const kontant = parseInt(kontantInput?.value || "0", 10);
  const räntaPct = parseFloat(räntaInput?.value || "4.0");
  const räntaDec = räntaPct / 100;
  const driftkostnad = parseSEK(data.driftkostnad) || 0;
  const avgift = parseSEK(data.avgift) || 0;
  const pantbrev = parseSEK(data.pantbrev) || 0;
  if (!price || !kontant) {
    resultEl.innerHTML = '<p style="font-size:12px;color:#c62828;padding:4px 0">Fyll i pris och kontantinsats.</p>';
    return;
  }
  const belåning = Math.max(0, price - kontant);
  const belåningsgrad = price > 0 ? belåning / price : 0;
  const amortkravPct = belåningsgrad > 0.7 ? 2 : 1;
  const belåningsText = `${Math.round(belåningsgrad * 100)}% belåning → amorteringskrav ${amortkravPct}%`;
  let html = `<div style="font-size:11px;color:#6b7280;margin-bottom:8px;padding:4px 8px;background:#f9fafb;border-radius:5px">${belåningsText}</div>`;
  if (propertyClass === "villa") {
    const c = calculateVillaCosts(price, kontant, pantbrev, driftkostnad, räntaDec);
    html += buildCostTable([
      ["Kontantinsats", formatSEK(c.kontantinsats)],
      ["Lagfart (1,5%)", formatSEK(c.lagfart)],
      ["Pantbrev (tillägg)", formatSEK(c.pantbrevKostnad)]
    ], [
      ["Bolån", formatSEK(c.bolån)],
      [`Ränta (${räntaPct}%)`, formatSEKMonth(c.ränta)],
      [`Amortering (${amortkravPct}%)`, formatSEKMonth(c.amortering)],
      ["Driftkostnad", formatSEKMonth(c.drift)],
      ["Fastighetsavgift", formatSEKMonth(c.fastighetsavgift)]
    ], c.totalKontant, c.totalMånad, c.totalMånadNetto);
  } else if (propertyClass === "tomt") {
    const c = calculateTomtCosts(price, kontant, räntaDec);
    html += buildCostTable([
      ["Kontantinsats", formatSEK(c.kontantinsats)],
      ["Lagfart (1,5%)", formatSEK(c.lagfart)]
    ], [
      ["Bolån", formatSEK(c.bolån)],
      [`Ränta (${räntaPct}%)`, formatSEKMonth(c.ränta)],
      [`Amortering (${amortkravPct}%)`, formatSEKMonth(c.amortering)]
    ], c.totalKontant, c.totalMånad, c.totalMånadNetto);
  } else {
    const c = calculateBrfCosts(price, kontant, avgift, räntaDec);
    html += buildCostTable([
      ["Kontantinsats", formatSEK(c.kontantinsats)]
    ], [
      ["Bolån", formatSEK(c.bolån)],
      [`Ränta (${räntaPct}%)`, formatSEKMonth(c.ränta)],
      [`Amortering (${amortkravPct}%)`, formatSEKMonth(c.amortering)],
      ["Månadsavgift", formatSEKMonth(c.avgift)]
    ], c.totalKontant, c.totalMånad, c.totalMånadNetto);
  }
  resultEl.innerHTML = html;
  trackEvent("calculator_used", { property_type: propertyClass, site });
}

function buildCostTable(kontantRows, månadRows, totalKontant, totalMånad, totalMånadNetto) {
  const row = ([label, value], cls = "") => `<div class="scout-kv${cls ? " " + cls : ""}"><span class="scout-kv-label">${label}</span><span class="scout-kv-value">${value}</span></div>`;
  const ränteavdrag = totalMånad - totalMånadNetto;
  return `
    <div class="scout-calc-group-label">Kontant vid köp</div>
    <div class="scout-calc-box">
      ${kontantRows.map((r) => row(r)).join("")}
      <div class="scout-divider"></div>
      ${row(["Totalt kontant", formatSEK(totalKontant)], "total")}
    </div>
    <div class="scout-calc-group-label">Månadskostnad</div>
    <div class="scout-calc-box">
      ${månadRows.map((r) => row(r)).join("")}
      <div class="scout-divider"></div>
      ${row(["Total (brutto)", formatSEKMonth(totalMånad)], "total")}
      ${row([`Ränteavdrag 30%`, "−" + formatSEKMonth(ränteavdrag)], "muted")}
      ${row(["Total (netto)", formatSEKMonth(totalMånadNetto)], "total netto")}
    </div>`;
}

function updateCalcSection(propertyClass, data) {
  const resultEl = shadowRoot?.getElementById("scout-calc-result");
  if (resultEl) {
    resultEl.innerHTML = "";
  }
}

function renderResults(data, docType, truncated, label) {
  const resultsSection = shadowRoot?.getElementById("scout-results");
  const resultsContent = shadowRoot?.getElementById("scout-results-content");
  if (!resultsSection || !resultsContent) {
    return;
  }
  resultsSection.classList.add("visible");
  let html = "";
  if (truncated) {
    html += `<div class="scout-item yellow"><span class="icon">⚠️</span><div class="scout-item-body"><strong>Trunkerat</strong><p>Dokumentet var för långt – analyserade de första 30 000 tecknen.</p></div></div>`;
  }
  if (docType === "besiktning") {
    if (Array.isArray(data)) {
      html += data.map((item) => buildTrafficItem(item.kategori, item.risk, item.sammanfattning)).join("");
    } else {
      html += `<div class="scout-item info"><span class="icon">ℹ️</span><div class="scout-item-body"><p>${JSON.stringify(data)}</p></div></div>`;
    }
  } else {
    if (data && typeof data === "object") {
      html += buildBrfResults(data);
    } else {
      html += `<div class="scout-item info"><span class="icon">ℹ️</span><div class="scout-item-body"><p>${data}</p></div></div>`;
    }
  }
  const block = document.createElement("div");
  block.style.cssText = "margin-bottom:12px";
  if (label) {
    block.setAttribute("data-result-label", label);
    const existing = resultsContent.querySelector(`[data-result-label="${CSS.escape(label)}"]`);
    if (existing) {
      existing.remove();
    }
  }
  const hasPrior = resultsContent.children.length > 0;
  const header = label ? `<div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px${hasPrior ? ";border-top:1px solid #e5e7eb;padding-top:10px;margin-top:4px" : ""}">${label}</div>` : "";
  block.innerHTML = header + html;
  resultsContent.appendChild(block);
  resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  const exportKey = label || docType || "analys";
  allAnalysisExports.set(exportKey, { data, docType, label: exportKey });
  showExportButtonIfBroker();
}

async function showExportButtonIfBroker() {
  const tier = await getTier();
  if (tier === "consumer") {
    return;
  }
  const exportSection = shadowRoot?.getElementById("scout-export-section");
  if (!exportSection) {
    return;
  }
  exportSection.style.display = "";
  if (!exportSection.dataset.wired) {
    exportSection.dataset.wired = "1";
    exportSection.querySelector("#scout-export-btn")?.addEventListener("click", async () => {
      const { whitelabel } = await chrome.storage.local.get("whitelabel");
      const listingId = currentPropertyData?.listingId;
      const agentCached = listingId ? (await chrome.storage.local.get(`agentCache_${listingId}`))[`agentCache_${listingId}`] : null;
      const keyInfo = keyInfoFindings.map((f) => ({ ...f, aiText: keyInfoAIData[f.key] || null }));
      exportReport(
        [...allAnalysisExports.values()],
        currentPropertyData || {},
        whitelabel || {},
        { keyInfo, agentData: agentCached?.agentData || null }
      );
    });
  }
}

function buildTrafficItem(title, risk, description) {
  const tl = trafficLight(risk);
  return `<div class="scout-item ${tl.color}">
      <span class="icon">${tl.icon}</span>
      <div class="scout-item-body">
        <strong>${title}</strong>
        <p>${description || ""}</p>
      </div>
    </div>`;
}

function buildBrfResults(d) {
  const items = [];
  if (d.lan_per_kvm != null) {
    const risk = d.lan_per_kvm < 5e3 ? "green" : d.lan_per_kvm < 1e4 ? "yellow" : "red";
    items.push(buildTrafficItem(
      "Lån per kvm",
      risk,
      `${new Intl.NumberFormat("sv-SE").format(Math.round(d.lan_per_kvm))} kr/kvm${d.skuld_kr ? ` (total skuld: ${new Intl.NumberFormat("sv-SE").format(d.skuld_kr)} kr)` : ""}`
    ));
  }
  if (d.akta) {
    const risk = d.akta === "äkta" ? "green" : d.akta === "oäkta" ? "red" : "yellow";
    items.push(buildTrafficItem("Äkta / Oäkta BRF", risk, d.akta_forklaring || d.akta));
  }
  if (d.avgiftshojning_planerad != null) {
    const risk = d.avgiftshojning_planerad ? "red" : "green";
    items.push(buildTrafficItem(
      "Avgiftshöjning",
      risk,
      d.avgiftshojning_notering || (d.avgiftshojning_planerad ? "Planerad avgiftshöjning" : "Ingen planerad höjning")
    ));
  }
  if (d.renoveringar?.length > 0) {
    const hasStambyte = d.renoveringar.some((r) => r.typ?.toLowerCase().includes("stambyte"));
    items.push(buildTrafficItem(
      "Renoveringar",
      hasStambyte ? "red" : "yellow",
      d.renoveringar.map((r) => `${r.typ} (${r.år})`).join(", ")
    ));
  }
  if (d.parkering) {
    const risk = d.parkering === "ingår" ? "green" : d.parkering === "kö" ? "yellow" : "red";
    items.push(buildTrafficItem("Parkering", risk, d.parkering));
  }
  if (d.imd) {
    items.push(buildTrafficItem("IMD – Individuell mätning", "yellow", "El debiteras individuellt – kontrollera kostnad"));
  }
  if (d.notering) {
    items.push(buildTrafficItem("Övrigt", "yellow", d.notering));
  }
  if (d.skuld_kr && d.total_yta_kvm && d.total_yta_kvm > 0) {
    const extrakostnadPerKvm = d.skuld_kr * 0.01 / 12 / d.total_yta_kvm;
    const fmt = (v) => new Intl.NumberFormat("sv-SE").format(Math.round(v));
    const extrakostnadHuset = Math.round(d.skuld_kr * 0.01 / 12);
    items.push(buildTrafficItem(
      "Räntekänslighet (+1 % ränta)",
      extrakostnadPerKvm > 50 ? "red" : extrakostnadPerKvm > 25 ? "yellow" : "green",
      `Föreningen behöver täcka ~${fmt(extrakostnadHuset)} kr/mån extra. Motsvarar ~${fmt(extrakostnadPerKvm)} kr/kvm/mån → sannolikt avgiftshöjning om räntan stiger.`
    ));
  }
  return items.join("") || '<div class="scout-item info"><span class="icon">ℹ️</span><div class="scout-item-body"><p>Inga kritiska fynd identifierade.</p></div></div>';
}

function serializeAnalysisForPrompt() {
  if (allAnalysisExports.size === 0) {
    return null;
  }
  const parts = [];
  for (const { data, label } of allAnalysisExports.values()) {
    if (!data) {
      continue;
    }
    const lines = [`${label}:`];
    if (Array.isArray(data)) {
      for (const item of data) {
        const suffix = item.sammanfattning ? `: ${item.sammanfattning}` : "";
        lines.push(`- ${item.kategori} (${item.risk})${suffix}`);
      }
    } else if (typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        if (v == null) {
          continue;
        }
        if (Array.isArray(v) && v.length === 0) {
          continue;
        }
        lines.push(`- ${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
      }
    }
    if (lines.length > 1) {
      parts.push(lines.join("\n"));
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function listingAnalysisToReportItems(d) {
  if (!d || typeof d !== "object") {
    return [];
  }
  const items = [];
  if (d.sammanfattning) {
    items.push({ kategori: "Sammanfattning", risk: "grön", sammanfattning: d.sammanfattning });
  }
  for (const f of d.rod_flaggor || []) {
    items.push({ kategori: f.rubrik, risk: "röd", sammanfattning: f.detalj });
  }
  for (const f of d.gul_flaggor || []) {
    items.push({ kategori: f.rubrik, risk: "gul", sammanfattning: f.detalj });
  }
  if (Array.isArray(d.renoveringar) && d.renoveringar.length > 0) {
    const desc = d.renoveringar.map((r) => `${r.typ}${r.år ? " (" + r.år + ")" : ""}`).join(", ");
    items.push({ kategori: "Renoveringshistorik", risk: "grön", sammanfattning: desc });
  }
  for (const f of d.gron_flaggor || []) {
    items.push({ kategori: f.rubrik, risk: "grön", sammanfattning: f.detalj });
  }
  if (d.maklar_kritik) {
    items.push({ kategori: "Mäklarkritiken", risk: "gul", sammanfattning: d.maklar_kritik });
  }
  return items;
}

function buildListingAnalysisResults(d) {
  if (!d || typeof d !== "object") {
    return `<div class="scout-item info"><span class="icon">ℹ️</span><div class="scout-item-body"><p>${d || "Ingen data"}</p></div></div>`;
  }
  const items = [];
  if (d.sammanfattning) {
    items.push(`<div class="scout-item info"><span class="icon">📋</span><div class="scout-item-body"><strong>Sammanfattning</strong><p>${d.sammanfattning}</p></div></div>`);
  }
  if (d.maklar_kritik) {
    items.push(`<div class="scout-item yellow"><span class="icon">🔍</span><div class="scout-item-body"><strong>Mäklarkritikern</strong><p>${d.maklar_kritik}</p></div></div>`);
  }
  for (const flag of d.rod_flaggor || []) {
    items.push(buildTrafficItem(flag.rubrik, "red", flag.detalj));
  }
  for (const flag of d.gul_flaggor || []) {
    items.push(buildTrafficItem(flag.rubrik, "yellow", flag.detalj));
  }
  if (Array.isArray(d.renoveringar) && d.renoveringar.length > 0) {
    const renovList = d.renoveringar.map((r) => `${r.typ}${r.år ? " (" + r.år + ")" : ""}${r.notering ? " — " + r.notering : ""}`).join("<br>");
    items.push(`<div class="scout-item green"><span class="icon">🔧</span><div class="scout-item-body"><strong>Renoveringshistorik</strong><p>${renovList}</p></div></div>`);
  }
  for (const flag of d.gron_flaggor || []) {
    items.push(buildTrafficItem(flag.rubrik, "green", flag.detalj));
  }
  if (Array.isArray(d.planerade_atgarder) && d.planerade_atgarder.length > 0) {
    const planList = d.planerade_atgarder.map((p) => `${p.rubrik}${p.detalj ? ": " + p.detalj : ""}`).join("<br>");
    items.push(`<div class="scout-item yellow"><span class="icon">🗓️</span><div class="scout-item-body"><strong>Planerade åtgärder</strong><p>${planList}</p></div></div>`);
  }
  if (d.villkor) {
    const v = d.villkor;
    const juridikItems = [
      [v.juridisk_person, "Juridisk person accepteras"],
      [v.delat_agarskap, "Delat ägarskap möjligt"],
      [v.andrahandsuthyrning, "Andrahandsuthyrning tillåten"],
      [v.ombildning_pagaende, "Ombildning pågår"]
    ].filter(([val]) => val !== null && val !== undefined);
    if (juridikItems.length > 0) {
      const rows = juridikItems.map(
        ([val, label]) => `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px">
                   <span>${val ? "✅" : "❌"}</span>
                   <span style="color:${val ? "#166534" : "#6b7280"}">${label}</span>
                 </div>`
      ).join("");
      items.push(`<div class="scout-item info"><span class="icon">⚖️</span><div class="scout-item-body"><strong>Juridik & villkor</strong>${rows}</div></div>`);
    }
  }
  if (Array.isArray(d.positiva_detaljer) && d.positiva_detaljer.length > 0) {
    const chips = d.positiva_detaljer.map((detail) => `<span style="background:#e0f2fe;color:#0369a1;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;display:inline-block;margin:2px 2px 2px 0">${detail}</span>`).join("");
    items.push(`<div class="scout-item info"><span class="icon">✨</span><div class="scout-item-body"><strong>Bekvämlighets­faktorer</strong><p style="margin-top:5px">${chips}</p></div></div>`);
  }
  return items.join("") || '<div class="scout-item info"><span class="icon">ℹ️</span><div class="scout-item-body"><p>Inga fynd att rapportera.</p></div></div>';
}

function handleAnalysisError(errorMsg) {
  if (errorMsg === "quota_exceeded") {
    const cta = shadowRoot?.getElementById("scout-upgrade-cta");
    if (cta) {
      cta.style.display = "block";
    }
    return;
  }
  if (errorMsg === "no_api_key") {
    setStatus("Ange din API-nyckel under Inställningar ⚙️");
    return;
  }
  setStatus(`Fel: ${errorMsg}`);
}

function resetSidebar() {
  if (!shadowRoot) {
    return;
  }
  const resultsSection = shadowRoot.getElementById("scout-results");
  const resultsContent = shadowRoot.getElementById("scout-results-content");
  const pdfTextArea = shadowRoot.getElementById("scout-pdf-text");
  const dropZone = shadowRoot.getElementById("scout-drop-zone");
  const autoBadge = shadowRoot.getElementById("scout-pdf-auto-badge");
  const analyzeBtn = shadowRoot.getElementById("scout-analyze-btn");
  const dropPrompt = shadowRoot.getElementById("scout-drop-prompt");
  const calcResult = shadowRoot.getElementById("scout-calc-result");
  const upgradeCta = shadowRoot.getElementById("scout-upgrade-cta");
  const statusEl = shadowRoot.getElementById("scout-analyze-status");
  if (resultsSection) {
    resultsSection.classList.remove("visible");
  }
  if (resultsContent) {
    resultsContent.innerHTML = "";
  }
  if (pdfTextArea) {
    pdfTextArea.value = "";
    pdfTextArea.style.display = "none";
  }
  if (dropZone) {
    dropZone.classList.remove("has-content");
  }
  if (autoBadge) {
    autoBadge.classList.remove("visible");
  }
  if (analyzeBtn) {
    analyzeBtn.disabled = true;
  }
  if (dropPrompt) {
    dropPrompt.style.display = "block";
  }
  if (calcResult) {
    calcResult.innerHTML = "";
  }
  if (upgradeCta) {
    upgradeCta.style.display = "none";
  }
  if (statusEl) {
    statusEl.innerHTML = "";
    statusEl.classList.remove("visible");
  }
  chrome.runtime.sendMessage({ type: "ABORT_REQUEST" });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SIDEBAR_STATUS") {
    if (msg.status === "quota_exceeded") {
      const cta = shadowRoot?.getElementById("scout-upgrade-cta");
      const msgEl = shadowRoot?.getElementById("scout-upgrade-msg");
      if (cta) {
        cta.style.display = "block";
      }
      if (msgEl) {
        msgEl.textContent = "Du har nått din månadsgräns – uppgradera eller vänta till nästa månad.";
      }
      trackEvent("upgrade_cta_shown", { feature: "quota" });
    } else if (msg.status === "rate_limit") {
      setStatus(`<span class="scout-spinner"></span> ${msg.msg}`);
    }
  }
});

function autoDetectPDF(data) {
  try {
    chrome.runtime.sendMessage({ type: "AUTO_DETECT_PDF" }, (response) => {
      if (chrome.runtime.lastError) {
        return;
      }
      if (response?.pdfText) {
        fillDropZone(response.pdfText, "auto");
        trackEvent("pdf_strategy_used", { strategy: 1, site });
      }
    });
  } catch (_) {
  }
}

function interceptPdfLinks() {
  const DOC_KEYWORDS = ["årsredovisning", "arsredovisning", "besiktning", "protokoll"];
  const links = document.querySelectorAll("a[href]");
  links.forEach((link) => {
    const text = (link.textContent + link.href).toLowerCase();
    if (DOC_KEYWORDS.some((kw) => text.includes(kw))) {
      link.addEventListener("click", async (e) => {
        e.preventDefault();
        const url = link.href;
        const result = await chrome.runtime.sendMessage({ type: "FETCH_PDF", url });
        if (result?.base64) {
          fillDropZone(result.base64, "auto");
          trackEvent("pdf_strategy_used", { strategy: 2, site });
        } else {
          window.open(url, "_blank");
        }
      }, { once: true });
    }
  });
}

function waitForNavRender(ms = 1e3) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function init() {
  console.log("[Scout] init() called, pathname:", location.pathname, "lastScrapedURL:", lastScrapedURL);
  const isListingPage = site === "hemnet" ? /\/bostad\//.test(location.pathname) : /\/bostad\//.test(location.pathname);
  if (!isListingPage) {
    console.log("[Scout] not a listing page, skipping");
    return;
  }
  if (lastScrapedURL === location.href) {
    console.log("[Scout] already scraped this URL, skipping");
    return;
  }
  lastScrapedURL = location.href;
  const data = await scrapeProperty();
  console.log("[Scout] scraped data:", data);
  const health = scoreScrapeHealth(data);
  await trackEvent("property_viewed", {
    property_type: data.propertyClass,
    site,
    listing_id: data.listingId
  });
  await trackEvent("scrape_quality", {
    status: health.status,
    fields_found: Object.keys(data).filter((k) => data[k]).length,
    fields_missing: health.missing,
    has_pdfs: data.pdfLinks?.length > 0,
    selector_version: 1,
    url_pattern: location.pathname.replace(/\d+/g, ":id"),
    site
  });
  console.log("[Scout] calling injectSidebar...");
  try {
    injectSidebar(data);
    console.log("[Scout] injectSidebar done, scout-host:", document.getElementById("scout-host"));
  } catch (e) {
    console.error("[Scout] injectSidebar threw:", e);
  }
  interceptPdfLinks();
  // Hemnet renders PDF links dynamically — re-check after React has had time to render
  setTimeout(() => refreshHemnetDocs(data), 2500);
  setTimeout(() => refreshHemnetDocs(data), 5000);
}

let lastUrl = location.href;

function onNavigate() {
  console.log("[Scout] onNavigate() called, new URL:", location.href);
  if (location.href === lastUrl) {
    console.log("[Scout] same URL, skipping");
    return;
  }
  lastUrl = location.href;
  document.getElementById("scout-host")?.remove();
  sidebarRoot = null;
  shadowRoot = null;
  lastScrapedURL = null;
  try {
    resetSidebar();
  } catch (_) {
  }
  console.log("[Scout] waiting 1000ms then calling init...");
  waitForNavRender(1e3).then(() => init());
}

setInterval(() => {
  if (location.href !== lastUrl) {
    onNavigate();
  }
}, 500);

window.addEventListener("popstate", onNavigate);
console.log("[Scout v7] content.js loaded on", location.href);
init();

const SELECTOR_CONFIG_URL = "https://raw.githubusercontent.com/AidinD/ai-property-scout/main/selectors.json";
const SELECTOR_VERSION = 2;

export const DEFAULT_SELECTORS = {
  version: SELECTOR_VERSION,
  hemnet: {
    // Hemnet uses CSS Modules — match on the stable prefix before the hash
    price: [
      'h2[class*="NestTitle"]',
      'h1[class*="NestTitle"]',
      '[class*="nestTitle"]',
      '[data-testid="property-price"]'
    ],
    address: [
      'h1[class*="NestTitle"]',
      '[class*="property-address"]',
      "h1"
    ],
    // Living area is extracted by text pattern in scrapeProperty()
    livingArea: [],
    // Property type is extracted from the URL slug in scrapeProperty()
    propertyType: []
  },
  booli: {
    price: ['[class*="Price"]', ".listing-price"],
    address: ['[class*="Address"]', 'h1[class*="address"]'],
    livingArea: ['[class*="Area"]'],
    propertyType: ['[class*="Type"]']
  }
};

export async function loadSelectors() {
  const cached = await chrome.storage.local.get("selectorConfig");
  if (cached.selectorConfig && Date.now() - cached.selectorConfig.ts < 864e5) {
    return cached.selectorConfig.data;
  }
  try {
    const res = await fetch(SELECTOR_CONFIG_URL);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const config = await res.json();
    await chrome.storage.local.set({ selectorConfig: { data: config, ts: Date.now() } });
    return config;
  } catch (e) {
    console.debug("[Scout] Selector config fetch failed – using defaults");
    return cached.selectorConfig?.data || DEFAULT_SELECTORS;
  }
}

export function scrapeField(selectors, doc = document) {
  for (const selector of selectors) {
    try {
      const el = doc.querySelector(selector);
      if (el?.textContent?.trim()) {
        return el.textContent.trim();
      }
    } catch (_) {
      continue;
    }
  }
  return null;
}

export function scoreScrapeHealth(data, site = "hemnet") {
  // Booli listings sometimes omit price ("kontakta mäklare") — not a scraping failure
  const coreFields = site === "booli" ? ["address", "livingArea"] : ["price", "address", "livingArea"];
  const coreMissing = coreFields.filter((f) => !data[f]);
  if (coreMissing.length > 0) {
    return { status: "critical", missing: coreMissing };
  }
  let optionalFields;
  let threshold;
  if (site === "booli") {
    // Booli exposes fewer fields — pantbrev/upplatelseform/uppvarmning not in Apollo state.
    optionalFields = ["avgift", "driftkostnad", "antalRum", "byggnadsår"];
    threshold = 1;
  } else if (data.propertyClass === "bostadsratt") {
    // BRF listings don't have pantbrev or uppvarmning — check BRF-relevant fields.
    optionalFields = ["avgift", "driftkostnad", "upplatelseform", "brfName"];
    threshold = 2;
  } else if (data.propertyClass === "tomt") {
    optionalFields = ["tomtstorlek", "upplatelseform"];
    threshold = 1;
  } else {
    // Villa, fritidshus, gård
    optionalFields = ["driftkostnad", "pantbrev", "upplatelseform", "uppvarmning"];
    threshold = 2;
  }
  const optionalFound = optionalFields.filter((f) => data[f]).length;
  if (optionalFound < threshold) {
    return { status: "degraded", missing: optionalFields.filter((f) => !data[f]) };
  }
  return { status: "healthy", missing: [] };
}

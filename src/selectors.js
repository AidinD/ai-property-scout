const SELECTOR_CONFIG_URL = "https://raw.githubusercontent.com/AidinD/ai-property-scout/main/selectors.json";
const SELECTOR_VERSION = 1;

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

export function scoreScrapeHealth(data) {
  const coreFields = ["price", "address", "livingArea"];
  const coreMissing = coreFields.filter((f) => !data[f]);
  if (coreMissing.length > 0) {
    return { status: "critical", missing: coreMissing };
  }
  const optionalFields = ["avgift", "driftkostnad", "pantbrev", "upplatelseform", "uppvarmning"];
  const optionalFound = optionalFields.filter((f) => data[f]).length;
  if (optionalFound < 2) {
    return { status: "degraded", missing: [] };
  }
  return { status: "healthy", missing: [] };
}

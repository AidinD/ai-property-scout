export function formatSEK(value) {
  if (value == null || isNaN(value)) {
    return "Ej tillgänglig";
  }
  return new Intl.NumberFormat("sv-SE").format(Math.round(value)) + " kr";
}

export function formatSEKMonth(value) {
  if (value == null || isNaN(value)) {
    return "Ej tillgänglig";
  }
  return new Intl.NumberFormat("sv-SE").format(Math.round(value)) + " kr/mån";
}

export function parseSEK(str) {
  if (!str) {
    return null;
  }
  const cleaned = str.replace(/[^\d]/g, "");
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? null : num;
}

export function trafficLight(risk) {
  const map = {
    red: { icon: "🔴", color: "red", label: "Hög risk" },
    yellow: { icon: "🟡", color: "yellow", label: "Notera" },
    green: { icon: "🟢", color: "green", label: "OK" },
    röd: { icon: "🔴", color: "red", label: "Hög risk" },
    gul: { icon: "🟡", color: "yellow", label: "Notera" },
    grön: { icon: "🟢", color: "green", label: "OK" }
  };
  return map[risk?.toLowerCase()] || map.yellow;
}

export function classifyPropertyType(typeStr) {
  if (!typeStr) {
    return "unknown";
  }
  const lower = typeStr.toLowerCase();
  if (lower.includes("fritidshus") || lower.includes("fritid")) {
    return "fritidshus";
  }
  if (lower.includes("gård") || lower.includes("gard") || lower.includes("lantbruk") || lower.includes("skog")) {
    return "gard";
  }
  if (lower.includes("villa") || lower.includes("radhus") || lower.includes("parhus") || lower.includes("kedjehus")) {
    return "villa";
  }
  if (lower.includes("bostadsrätt") || lower.includes("bostadsratt") || lower.includes("lägenhet") || lower.includes("lagenhet")) {
    return "bostadsratt";
  }
  if (lower.includes("tomt") || lower.includes("mark")) {
    return "tomt";
  }
  return "unknown";
}

export function calculateVillaCosts(price, kontantinsats, pantbrev, driftkostnad, räntaDecimal = 0.04) {
  const p = price || 0;
  const k = kontantinsats || 0;
  const bolån = Math.max(0, p - k);
  const lagfart = p * 0.015 + 825;
  const pantbrevBehov = Math.max(0, p * 0.85 - (pantbrev || 0));
  const pantbrevKostnad = pantbrevBehov > 0 ? pantbrevBehov * 0.02 + 375 : 0;
  const fastighetsavgift = 794;
  const belåningsgrad = p > 0 ? bolån / p : 0;
  const amorteringsKrav = belåningsgrad > 0.7 ? 0.02 : 0.01;
  const ränta = bolån * räntaDecimal / 12;
  const amortering = bolån * amorteringsKrav / 12;
  const drift = driftkostnad || 0;
  const ränteavdrag = ränta * 0.3;
  return {
    kontantinsats: k,
    lagfart,
    pantbrevKostnad,
    pantbrevBehov,
    fastighetsavgift,
    bolån,
    belåningsgrad,
    amorteringsKrav,
    ränta,
    ränteavdrag,
    amortering,
    drift,
    totalKontant: k + lagfart + pantbrevKostnad,
    totalMånad: ränta + amortering + drift + fastighetsavgift,
    totalMånadNetto: ränta - ränteavdrag + amortering + drift + fastighetsavgift
  };
}

export function calculateFritidsCosts(price, kontantinsats, pantbrev, driftkostnad, räntaDecimal = 0.04) {
  const result = calculateVillaCosts(price, kontantinsats, pantbrev, driftkostnad, räntaDecimal);
  // Fritidshus fastighetsavgift: cap 4 512 kr/år (2024) ≈ 376 kr/mån vs villa 794 kr/mån
  const fritidsavgift = 376;
  return {
    ...result,
    fastighetsavgift: fritidsavgift,
    totalMånad: result.ränta + result.amortering + result.drift + fritidsavgift,
    totalMånadNetto: result.ränta - result.ränteavdrag + result.amortering + result.drift + fritidsavgift
  };
}

export function calculateGardCosts(price, kontantinsats, pantbrev, driftkostnad, räntaDecimal = 0.04) {
  // Gård/lantbruk: same lagfart/pantbrev structure as villa, fastighetsavgift varies widely
  // Use villa calc as approximation — show a note to user about complexity
  return calculateVillaCosts(price, kontantinsats, pantbrev, driftkostnad, räntaDecimal);
}

export function calculateBrfCosts(price, kontantinsats, avgift, räntaDecimal = 0.04) {
  const p = price || 0;
  const k = kontantinsats || 0;
  const bolån = Math.max(0, p - k);
  const belåningsgrad = p > 0 ? bolån / p : 0;
  const amorteringsKrav = belåningsgrad > 0.7 ? 0.02 : 0.01;
  const ränta = bolån * räntaDecimal / 12;
  const ränteavdrag = ränta * 0.3;
  const amortering = bolån * amorteringsKrav / 12;
  const avg = avgift || 0;
  return {
    kontantinsats: k,
    bolån,
    belåningsgrad,
    amorteringsKrav,
    ränta,
    ränteavdrag,
    amortering,
    avgift: avg,
    totalKontant: k,
    totalMånad: ränta + amortering + avg,
    totalMånadNetto: ränta - ränteavdrag + amortering + avg
  };
}

export function calculateTomtCosts(price, kontantinsats, räntaDecimal = 0.04) {
  const p = price || 0;
  const k = kontantinsats || 0;
  const bolån = Math.max(0, p - k);
  const lagfart = p * 0.015 + 825;
  const belåningsgrad = p > 0 ? bolån / p : 0;
  const amorteringsKrav = belåningsgrad > 0.7 ? 0.02 : 0.01;
  const ränta = bolån * räntaDecimal / 12;
  const ränteavdrag = ränta * 0.3;
  const amortering = bolån * amorteringsKrav / 12;
  return {
    kontantinsats: k,
    lagfart,
    bolån,
    belåningsgrad,
    amorteringsKrav,
    ränta,
    ränteavdrag,
    amortering,
    totalKontant: k + lagfart,
    totalMånad: ränta + amortering,
    totalMånadNetto: ränta - ränteavdrag + amortering
  };
}

export function parseAIJson(text) {
  if (!text) {
    return null;
  }
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch (_) {}
  // Truncation recovery: find last top-level closing brace
  const start = cleaned.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let lastValidEnd = -1;
    for (let i = start; i < cleaned.length; i++) {
      if (cleaned[i] === "{") {
        depth++;
      } else if (cleaned[i] === "}") {
        depth--;
        if (depth === 0) {
          lastValidEnd = i;
          break;
        }
      }
    }
    if (lastValidEnd === -1) {
      lastValidEnd = cleaned.lastIndexOf("}");
    }
    if (lastValidEnd > start) {
      try {
        return JSON.parse(cleaned.slice(start, lastValidEnd + 1));
      } catch (_) {}
    }
  }
  return null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

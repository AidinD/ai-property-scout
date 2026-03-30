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
  if (lower.includes("villa") || lower.includes("radhus") || lower.includes("fritidshus")) {
    return "villa";
  }
  if (lower.includes("bostadsrätt") || lower.includes("bostadsratt") || lower.includes("br")) {
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
  } catch (_) {
    return null;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

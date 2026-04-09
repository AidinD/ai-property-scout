/**
 * AI Property Scout — Cloudflare Worker
 *
 * Proxies AI requests (Anthropic / OpenAI) on behalf of licensed users.
 * Enforces per-license monthly quotas via KV (USAGE_KV binding).
 *
 * Required Worker Secrets (set via Cloudflare dashboard):
 *   SCOUT_TOKEN       — shared secret, same value as in extension .env
 *   CENTRAL_API_KEY   — Anthropic or OpenAI API key (never in extension code)
 *
 * Required KV namespace binding:
 *   USAGE_KV          — for quota tracking (create via dashboard or wrangler)
 */

// Monthly quota limits per tier (null = unlimited)
const TIER_QUOTAS = {
  consumer: null,      // free tier — tracked client-side, no license key
  spekulant: 15,
  broker_solo: 50,
  broker_pro: 150,
  whitelabel: null
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": [
    "Content-Type",
    "X-Scout-Token",
    "X-License-Id",
    "X-Provider",
    "X-Tier",
    "X-Analysis-Type",
    "X-Device-Id",
    "anthropic-beta"
  ].join(", ")
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

function getMonthKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
    }

    // Authenticate request
    const scoutToken = request.headers.get("X-Scout-Token");
    if (!scoutToken || scoutToken !== env.SCOUT_TOKEN) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    const licenseId = request.headers.get("X-License-Id") || null;
    const tier = request.headers.get("X-Tier") || "consumer";
    const provider = (request.headers.get("X-Provider") || "anthropic").toLowerCase();
    const anthropicBeta = request.headers.get("anthropic-beta") || null;

    // Quota check for licensed tiers (skip for dev, anon/free, and unlimited tiers)
    const limit = TIER_QUOTAS[tier];
    const skipQuota = !licenseId || licenseId === "dev" || limit === null || !env.USAGE_KV;

    if (!skipQuota) {
      const monthKey = getMonthKey();
      const kvKey = `usage:${licenseId}:${monthKey}`;
      const currentUsage = parseInt((await env.USAGE_KV.get(kvKey)) || "0", 10);

      if (currentUsage >= limit) {
        return jsonResponse({ error: "quota_exceeded", used: currentUsage, limit, tier }, 429);
      }

      // Increment counter — fire and forget (don't block the response path)
      const ttlSeconds = 40 * 24 * 60 * 60; // 40 days, expires well after month end
      env.USAGE_KV.put(kvKey, String(currentUsage + 1), { expirationTtl: ttlSeconds });
    }

    // Parse request body
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    // Build upstream request
    let upstreamUrl;
    const upstreamHeaders = { "Content-Type": "application/json" };

    if (provider === "openai") {
      upstreamUrl = "https://api.openai.com/v1/chat/completions";
      upstreamHeaders["Authorization"] = `Bearer ${env.CENTRAL_API_KEY}`;
    } else {
      upstreamUrl = "https://api.anthropic.com/v1/messages";
      upstreamHeaders["x-api-key"] = env.CENTRAL_API_KEY;
      upstreamHeaders["anthropic-version"] = "2023-06-01";
      if (anthropicBeta) {
        upstreamHeaders["anthropic-beta"] = anthropicBeta;
      }
    }

    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body)
    });

    const responseText = await upstreamRes.text();
    return new Response(responseText, {
      status: upstreamRes.status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
};

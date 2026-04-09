/**
 * AI Property Scout — Cloudflare Worker
 *
 * Proxies AI requests (Anthropic / OpenAI) on behalf of licensed users.
 * Validates licenses server-side against Lemon Squeezy API (cached 1h in KV).
 * Enforces per-license monthly quotas and free-tier total limits via KV.
 *
 * Required Worker Secrets (set via Cloudflare dashboard):
 *   SCOUT_TOKEN       — shared secret, same value as in extension .env
 *   CENTRAL_API_KEY   — Anthropic or OpenAI API key (never in extension code)
 *
 * Required KV namespace binding:
 *   USAGE_KV          — quota tracking + license validation cache
 */

// Must match LS_VARIANT_TIERS in background.js
const LS_VARIANT_TIERS = {
  936197: "consumer_pro",
  936220: "broker_solo",
  936227: "broker_pro",
  936245: "whitelabel"
};

// Monthly quota per tier (null = unlimited).
// consumer = free tier, enforced as a total (not monthly) limit via device-ID.
const TIER_QUOTAS = {
  consumer:     null,   // handled separately via FREE_TIER_LIMIT + device-ID
  consumer_pro: 15,
  broker_solo:  50,
  broker_pro:   150,
  whitelabel:   null
};

const FREE_TIER_LIMIT = 3; // total analyses, not per month

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

/**
 * Validates a license key against Lemon Squeezy API.
 * Result is cached in KV for 1 hour to avoid per-request latency.
 * Returns { valid: true, tier } or { valid: false, error? }.
 */
async function validateLicense(licenseId, env) {
  // Check KV cache first
  if (env.USAGE_KV) {
    const cached = await env.USAGE_KV.get(`license_cache:${licenseId}`, "json");
    if (cached) {
      return cached;
    }
  }

  // Call Lemon Squeezy license validation API (no auth header required)
  let res;
  try {
    res = await fetch("https://api.lemonsqueezy.com/v1/licenses/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: licenseId })
    });
  } catch {
    // LS API unreachable — fail closed to avoid bypassing validation
    return { valid: false, error: "ls_unreachable" };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { valid: false, error: "ls_invalid_response" };
  }

  if (!data.valid) {
    return { valid: false };
  }

  const variantId = data.meta?.variant_id;
  const tier = LS_VARIANT_TIERS[variantId] || null;
  if (!tier) {
    return { valid: false, error: "unknown_variant" };
  }

  const result = { valid: true, tier };

  // Cache for 1 hour
  if (env.USAGE_KV) {
    await env.USAGE_KV.put(
      `license_cache:${licenseId}`,
      JSON.stringify(result),
      { expirationTtl: 3600 }
    );
  }

  return result;
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

    // Authenticate request — SCOUT_TOKEN is the extension's identity proof
    const scoutToken = request.headers.get("X-Scout-Token");
    if (!scoutToken || scoutToken !== env.SCOUT_TOKEN) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    const licenseId = request.headers.get("X-License-Id") || null;
    const provider = (request.headers.get("X-Provider") || "anthropic").toLowerCase();
    const anthropicBeta = request.headers.get("anthropic-beta") || null;

    // --- Resolve tier server-side. Never trust X-Tier from client. ---
    let validatedTier;

    if (!licenseId) {
      // Free tier: enforce total analysis limit by device ID
      const deviceId = request.headers.get("X-Device-Id");
      if (!deviceId) {
        return jsonResponse({ error: "device_id_required" }, 400);
      }
      if (env.USAGE_KV) {
        const freeKey = `free:${deviceId}:total`;
        const used = parseInt((await env.USAGE_KV.get(freeKey)) || "0", 10);
        if (used >= FREE_TIER_LIMIT) {
          return jsonResponse({ error: "quota_exceeded", used, limit: FREE_TIER_LIMIT, tier: "consumer" }, 429);
        }
        await env.USAGE_KV.put(freeKey, String(used + 1));
      }
      validatedTier = "consumer";

    } else if (licenseId === "dev") {
      // Dev bypass — only allowed when DEV_MODE=true is set in the Worker environment.
      // Set via: wrangler secret put DEV_MODE (value: "true") for local testing only.
      // In production this variable must not exist or be set to anything other than "true".
      if (env.DEV_MODE !== "true") {
        return jsonResponse({ error: "invalid_license" }, 401);
      }
      validatedTier = request.headers.get("X-Tier") || "broker_pro";

    } else {
      // Licensed user — validate against Lemon Squeezy, ignore X-Tier header
      const validation = await validateLicense(licenseId, env);
      if (!validation.valid) {
        const status = validation.error === "ls_unreachable" ? 503 : 401;
        return jsonResponse({ error: validation.error || "invalid_license" }, status);
      }
      validatedTier = validation.tier;
    }

    // Monthly quota check (consumer tier is handled above via device-ID)
    const limit = TIER_QUOTAS[validatedTier];
    const skipQuota = limit === null || licenseId === "dev" || !licenseId || !env.USAGE_KV;

    if (!skipQuota) {
      const monthKey = getMonthKey();
      const kvKey = `usage:${licenseId}:${monthKey}`;
      const currentUsage = parseInt((await env.USAGE_KV.get(kvKey)) || "0", 10);

      if (currentUsage >= limit) {
        return jsonResponse({ error: "quota_exceeded", used: currentUsage, limit, tier: validatedTier }, 429);
      }

      // Increment counter — fire and forget (don't block response)
      const ttlSeconds = 40 * 24 * 60 * 60; // 40 days
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

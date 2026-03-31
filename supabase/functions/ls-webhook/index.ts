import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const LS_VARIANT_TIERS: Record<number, string> = {
  936197: "consumer_pro",
  936220: "broker_solo",
  936227: "broker_pro",
  936245: "whitelabel",
};

const TIER_QUOTAS: Record<string, number> = {
  consumer_pro: 50,
  broker_solo:  300,
  broker_pro:   800,
  whitelabel:   2000,
};

function nextResetDate(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

function farFuture(): string {
  return new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString();
}

async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const sigBytes = new Uint8Array(
    signature.match(/.{1,2}/g)!.map((b) => parseInt(b, 16))
  );
  return crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(body));
}

Deno.serve(async (req) => {
  const body = await req.text();
  const signature = req.headers.get("X-Signature") ?? "";
  const secret = Deno.env.get("LS_WEBHOOK_SECRET")!;

  const valid = await verifySignature(body, signature, secret);
  if (!valid) {
    return new Response("Unauthorized", { status: 401 });
  }

  const event = JSON.parse(body);
  const eventName: string = event.meta?.event_name;
  const attrs = event.data?.attributes;

  // --- order_created: skapa licens ---
  if (eventName === "order_created" && attrs?.status === "paid") {
    const item = attrs.first_order_item;
    if (!item) {
      return new Response("ok");
    }

    const variantId: number = item.variant_id;
    const licenseKey: string = item.license_key;
    const tier: string = LS_VARIANT_TIERS[variantId];

    if (!tier || !licenseKey) {
      return new Response("ok");
    }

    await supabase.from("licenses").upsert({
      license_key:    licenseKey,
      tier,
      quota_monthly:  TIER_QUOTAS[tier],
      quota_used:     0,
      quota_reset_at: nextResetDate(),
      ls_order_id:    String(event.data.id),
      expires_at:     farFuture(),
    });
  }

  // --- subscription_created: lägg till subscription_id på licensen ---
  if (eventName === "subscription_created") {
    const orderId = String(attrs?.order_id);
    const subscriptionId = String(event.data?.id);

    await supabase
      .from("licenses")
      .update({ ls_subscription_id: subscriptionId })
      .eq("ls_order_id", orderId);
  }

  // --- subscription_payment_success / recovered: återställ kvot ---
  if (eventName === "subscription_payment_success" || eventName === "subscription_payment_recovered") {
    const subscriptionId = String(attrs?.subscription_id ?? event.data?.id);

    await supabase
      .from("licenses")
      .update({
        quota_used:     0,
        quota_reset_at: nextResetDate(),
        expires_at:     farFuture(),
        updated_at:     new Date().toISOString(),
      })
      .eq("ls_subscription_id", subscriptionId);
  }

  // --- subscription_cancelled: access gäller till periodens slut ---
  if (eventName === "subscription_cancelled") {
    const subscriptionId = String(event.data?.id);
    const endsAt = attrs?.ends_at ?? attrs?.renews_at ?? new Date().toISOString();

    await supabase
      .from("licenses")
      .update({
        expires_at: endsAt,
        updated_at: new Date().toISOString(),
      })
      .eq("ls_subscription_id", subscriptionId);
  }

  // --- subscription_expired: stäng av direkt ---
  if (eventName === "subscription_expired") {
    const subscriptionId = String(event.data?.id);

    await supabase
      .from("licenses")
      .update({
        expires_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("ls_subscription_id", subscriptionId);
  }

  return new Response("ok");
});

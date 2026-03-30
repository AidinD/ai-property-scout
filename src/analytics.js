const ANALYTICS_ENDPOINT = "https://eyvadvcnarfpprxbukmv.supabase.co/functions/v1/collect-events";
const BATCH_INTERVAL_MS = 60 * 60 * 1e3;
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV5dmFkdmNuYXJmcHByeGJ1a212Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3ODUzODEsImV4cCI6MjA5MDM2MTM4MX0.rZXkwQRwgsburUjvjG5z21A-B87J-hZqNYZdK-tZiQI";

export async function trackEvent(name, props = {}) {
  const { analyticsOptIn, analyticsUserId } = await chrome.storage.local.get([
    "analyticsOptIn",
    "analyticsUserId"
  ]);
  if (!analyticsOptIn) {
    return;
  }
  const userId = analyticsUserId || await initUserId();
  const event = {
    event_type: name,
    userId,
    tier: props.tier || "unknown",
    site: props.site || null,
    listing_id: props.listing_id || null,
    ts: Date.now(),
    ...props
  };
  const { eventQueue = [] } = await chrome.storage.local.get("eventQueue");
  eventQueue.push(event);
  await chrome.storage.local.set({ eventQueue });
  if (eventQueue.length >= 20) {
    flushEvents(true);
  }
}

export async function flushEvents(force = false) {
  const { eventQueue = [], lastFlush = 0 } = await chrome.storage.local.get([
    "eventQueue",
    "lastFlush"
  ]);
  if (!eventQueue.length) {
    return;
  }
  if (!force && Date.now() - lastFlush < BATCH_INTERVAL_MS) {
    return;
  }
  const rows = eventQueue.map((e) => ({
    event_type: e.event_type,
    listing_id: e.listing_id || null,
    site: e.site || null,
    tier: e.tier || null,
    license_id: e.license_id || null
  }));
  try {
    await fetch(ANALYTICS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({ events: rows })
    });
    await chrome.storage.local.set({ eventQueue: [], lastFlush: Date.now() });
  } catch (_) {
    console.debug("[Scout Analytics] Flush failed – will retry later");
  }
}

async function initUserId() {
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ analyticsUserId: id });
  return id;
}

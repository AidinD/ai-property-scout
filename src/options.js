const TIER_LABELS = {
  consumer: "Consumer",
  broker_solo: "Broker Solo",
  broker_pro: "Broker Pro",
  whitelabel: "White Label"
};

async function load() {
  const data = await chrome.storage.local.get([
    "userMode",
    "apiKey",
    "aiProvider",
    "license",
    "analyticsOptIn",
    "whitelabel"
  ]);
  document.getElementById("user-mode").value = data.userMode || "spekulant";
  document.getElementById("ai-provider").value = data.aiProvider || "anthropic";
  document.getElementById("api-key").value = data.apiKey || "";
  document.getElementById("analytics-optin").checked = !!data.analyticsOptIn;
  if (data.license?.key) {
    document.getElementById("license-key").value = data.license.key;
  }
  updateTierDisplay(data.license?.tier || "consumer");
  const wl = data.whitelabel || {};
  document.getElementById("wl-name").value = wl.brokerName || "";
  document.getElementById("wl-firm").value = wl.brokerFirm || "";
  document.getElementById("wl-phone").value = wl.phone || "";
  document.getElementById("wl-color").value = wl.primaryColor || "#003087";
  document.getElementById("wl-logo").value = wl.logoUrl || "";
  updateSectionVisibility(data.license?.tier || "consumer");
}

function updateTierDisplay(tier) {
  const label = document.getElementById("tier-label");
  const badge = document.getElementById("tier-badge");
  if (label) {
    label.textContent = tier;
  }
  if (badge) {
    badge.textContent = TIER_LABELS[tier] || tier;
    badge.className = `tier-badge ${tier.replace("_", "-")}`;
  }
}

function updateSectionVisibility(tier) {
  const isBroker = tier !== "consumer";
  document.getElementById("api-key-section").classList.toggle("hidden", isBroker);
  document.getElementById("whitelabel-section").classList.toggle("hidden", !isBroker);
}

document.getElementById("validate-license-btn").addEventListener("click", async () => {
  const key = document.getElementById("license-key").value.trim();
  const statusEl = document.getElementById("license-status");
  statusEl.className = "status-msg";
  if (!key) {
    await chrome.storage.local.remove("license");
    updateTierDisplay("consumer");
    updateSectionVisibility("consumer");
    statusEl.textContent = "Licens borttagen – consumer-tier aktiv";
    statusEl.className = "status-msg success";
    return;
  }
  statusEl.textContent = "Validerar...";
  statusEl.className = "status-msg success";
  const response = await chrome.runtime.sendMessage({ type: "VALIDATE_LICENSE", licenseKey: key });
  if (response.error) {
    statusEl.textContent = response.error === "invalid_license" ? "Ogiltig licensnyckel" : `Fel: ${response.error}`;
    statusEl.className = "status-msg error";
  } else {
    updateTierDisplay(response.tier);
    updateSectionVisibility(response.tier);
    statusEl.textContent = `Tier aktiverad: ${TIER_LABELS[response.tier] || response.tier}`;
    statusEl.className = "status-msg success";
  }
});

document.getElementById("save-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("save-status");
  const whitelabel = {
    brokerName: document.getElementById("wl-name").value.trim(),
    brokerFirm: document.getElementById("wl-firm").value.trim(),
    phone: document.getElementById("wl-phone").value.trim(),
    primaryColor: document.getElementById("wl-color").value.trim() || "#003087",
    logoUrl: document.getElementById("wl-logo").value.trim()
  };
  await chrome.storage.local.set({
    userMode: document.getElementById("user-mode").value,
    apiKey: document.getElementById("api-key").value.trim(),
    aiProvider: document.getElementById("ai-provider").value,
    analyticsOptIn: document.getElementById("analytics-optin").checked,
    whitelabel
  });
  statusEl.textContent = "Inställningar sparade ✓";
  statusEl.className = "status-msg success";
  setTimeout(() => {
    statusEl.className = "status-msg";
  }, 3e3);
  const logoUrl = whitelabel.logoUrl;
  const previewWrap = document.getElementById("wl-preview-wrap");
  if (logoUrl) {
    document.getElementById("wl-preview-logo").src = logoUrl;
    document.getElementById("wl-preview-name").textContent = whitelabel.brokerName;
    previewWrap.style.display = "flex";
  } else {
    previewWrap.style.display = "none";
  }
});

document.getElementById("clear-data-btn").addEventListener("click", async () => {
  if (!confirm("Är du säker? All lokal data tas bort.")) {
    return;
  }
  await chrome.storage.local.clear();
  await load();
  const statusEl = document.getElementById("save-status");
  statusEl.textContent = "All data rensad";
  statusEl.className = "status-msg success";
  setTimeout(() => {
    statusEl.className = "status-msg";
  }, 3e3);
});

chrome.storage.local.get("analyticsOptIn", ({ analyticsOptIn }) => {
  if (analyticsOptIn) {
    chrome.runtime.sendMessage({ type: "FLUSH_ANALYTICS" });
  }
});

load();

document.getElementById("settings-btn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

const MAX_DISPLAY = 30;

const STATUSES = [
  { key: "ny",      label: "Ny",      bg: "#f3f4f6", color: "#6b7280", border: "#e5e7eb" },
  { key: "visning", label: "Visning", bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" },
  { key: "anbud",   label: "Anbud",   bg: "#fffbeb", color: "#92400e", border: "#fde68a" },
  { key: "klar",    label: "Klar",    bg: "#f0fdf4", color: "#166534", border: "#bbf7d0" },
];

const STATUS_SORT = { anbud: 0, visning: 1, ny: 2 };

function getStatus(item) {
  return STATUSES.find(s => s.key === (item.status || "ny")) || STATUSES[0];
}

function formatDate(ts) {
  const diff = Date.now() - ts;
  if (diff < 86400000) {
    return "Idag";
  }
  if (diff < 172800000) {
    return "Igår";
  }
  const d = new Date(ts);
  return d.toLocaleDateString("sv-SE", { month: "short", day: "numeric" });
}

function applyPillStyle(pill, status) {
  pill.style.background = status.bg;
  pill.style.color = status.color;
  pill.style.borderColor = status.border;
  pill.textContent = status.label;
}

function buildCard(item) {
  const { red = 0, yellow = 0, green = 0 } = item.riskSummary || {};
  const hasAnalyses = red > 0 || yellow > 0 || green > 0;
  const badges = [
    red > 0 ? `<span class="risk-badge red">🔴 ${red}</span>` : "",
    yellow > 0 ? `<span class="risk-badge yellow">🟡 ${yellow}</span>` : ""
  ].filter(Boolean).join("");

  const card = document.createElement("div");
  card.className = "listing-card";
  card.dataset.id = item.listingId;

  const statusDef = getStatus(item);
  card.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:6px">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
          <div class="listing-address" style="flex:1;min-width:0">${item.address || "Okänd adress"}</div>
          <span class="status-pill" style="flex-shrink:0;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;border:1px solid;cursor:pointer;white-space:nowrap;user-select:none"></span>
        </div>
        ${item.price ? `<div class="listing-price">${item.price}</div>` : ""}
        <div class="listing-meta">
          <div class="risk-badges">${hasAnalyses
            ? badges || '<span style="font-size:11px;color:#9ca3af">Inga röda/gula</span>'
            : '<span style="font-size:11px;color:#9ca3af;font-style:italic">Ej analyserad</span>'
          }</div>
          <div class="listing-date">${formatDate(item.analyzedAt)}</div>
        </div>
      </div>
      <button class="delete-btn" title="Ta bort" style="flex-shrink:0;background:none;border:none;cursor:pointer;color:#9ca3af;font-size:16px;padding:2px 4px;line-height:1;border-radius:4px;margin-left:2px">×</button>
    </div>
  `;

  const pill = card.querySelector(".status-pill");
  applyPillStyle(pill, statusDef);

  pill.addEventListener("click", async (e) => {
    e.stopPropagation();
    const current = STATUSES.findIndex(s => s.key === (item.status || "ny"));
    const next = STATUSES[(current + 1) % STATUSES.length];
    item.status = next.key;
    applyPillStyle(pill, next);

    const stored = await chrome.storage.local.get("portfolioIndex");
    const idx = stored.portfolioIndex || [];
    const entry = idx.find(i => i.listingId === item.listingId);
    if (entry) {
      entry.status = next.key;
      await chrome.storage.local.set({ portfolioIndex: idx });
    }
  });

  card.querySelector(".delete-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const stored = await chrome.storage.local.get("portfolioIndex");
    const idx = (stored.portfolioIndex || []).filter(i => i.listingId !== item.listingId);
    await chrome.storage.local.set({ portfolioIndex: idx });
    card.remove();

    const listEl = document.getElementById("portfolio-list");
    if (!listEl.querySelector(".listing-card")) {
      document.getElementById("empty-state").style.display = "";
      document.getElementById("count-label").style.display = "none";
      document.getElementById("clear-btn").style.display = "none";
    } else {
      const remaining = idx.length;
      document.getElementById("count-label").textContent = `${remaining} objekt sparade`;
    }
  });

  card.addEventListener("click", () => {
    chrome.tabs.create({ url: item.url });
  });

  return card;
}

async function loadPortfolio() {
  const stored = await chrome.storage.local.get("portfolioIndex");
  function isAnalyzed(item) {
    const { red = 0, yellow = 0, green = 0 } = item.riskSummary || {};
    return red > 0 || yellow > 0 || green > 0;
  }

  const index = (stored.portfolioIndex || []).slice().sort((a, b) => {
    const sa = STATUS_SORT[a.status || "ny"] ?? 2;
    const sb = STATUS_SORT[b.status || "ny"] ?? 2;
    if (sa !== sb) {
      return sa - sb;
    }
    const aa = isAnalyzed(a) ? 0 : 1;
    const ab = isAnalyzed(b) ? 0 : 1;
    if (aa !== ab) {
      return aa - ab;
    }
    return b.analyzedAt - a.analyzedAt;
  });

  const listEl = document.getElementById("portfolio-list");
  const emptyEl = document.getElementById("empty-state");
  const countLabel = document.getElementById("count-label");
  const clearBtn = document.getElementById("clear-btn");

  if (index.length === 0) {
    emptyEl.style.display = "";
    return;
  }

  countLabel.style.display = "";
  countLabel.textContent = `${index.length} objekt sparade`;
  clearBtn.style.display = "";

  const active = index.filter(i => (i.status || "ny") !== "klar").slice(0, MAX_DISPLAY);
  const done = index.filter(i => (i.status || "ny") === "klar").slice(0, MAX_DISPLAY);

  function appendGroup(items, label, firstGroup) {
    if (items.length === 0) {
      return;
    }
    const section = document.createElement("div");
    section.className = "group-section";
    const header = document.createElement("div");
    header.className = "section-label";
    if (!firstGroup) {
      header.style.marginTop = "14px";
    }
    header.textContent = label;
    section.appendChild(header);
    items.forEach(item => section.appendChild(buildCard(item)));
    listEl.appendChild(section);
  }

  appendGroup(active, "Aktiva objekt", true);
  appendGroup(done, "Avslutade");

  const totalDisplayed = active.length + done.length;
  if (index.length > totalDisplayed) {
    const note = document.createElement("div");
    note.style.cssText = "font-size:11px;color:#9ca3af;text-align:center;padding:8px 0 4px";
    note.textContent = `Visar ${totalDisplayed} av ${index.length} objekt`;
    listEl.appendChild(note);
  }

  clearBtn.addEventListener("click", async () => {
    if (!confirm(`Rensa alla ${index.length} objekt från portfolio?`)) {
      return;
    }
    await chrome.storage.local.remove("portfolioIndex");
    listEl.innerHTML = "";
    countLabel.style.display = "none";
    clearBtn.style.display = "none";
    emptyEl.style.display = "";
  });
}

loadPortfolio();

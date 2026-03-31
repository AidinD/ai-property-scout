export function exportReport(analyses, propertyData, whitelabelConfig, context = {}) {
  const {
    brokerName = "",
    brokerFirm = "",
    phone = "",
    logoUrl = "",
    primaryColor = "#1a3c5e"
  } = whitelabelConfig || {};
  const { keyInfo = [], agentData = null } = context;
  const reportWindow = window.open("", "_blank");
  if (!reportWindow) {
    alert("Popup blockerad – tillåt popup-fönster för att exportera rapporten.");
    return;
  }
  const analysesList = Array.isArray(analyses) && analyses[0]?.label !== undefined
    ? analyses
    : [{ data: analyses, docType: "besiktning", label: null }];
  const analysesHtml = analysesList.map(({ data, docType, label }) =>
    (label ? `<div class="section-title">${label}</div>` : "") + buildReportItems(data, docType)
  ).join("");
  const factsHtml = buildFactsSection(propertyData, agentData);
  const keyInfoHtml = buildKeyInfoSection(keyInfo);
  const itemsHtml = factsHtml + keyInfoHtml + analysesHtml;
  const date = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date());
  const html = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <title>Fastighetsanalys – ${propertyData.address || "Rapport"}</title>
  <style>
    @media print {
      body { margin: 0; }
      .no-print { display: none !important; }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Georgia, 'Times New Roman', serif;
      color: #1a1a2e;
      font-size: 14px;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 32px;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 3px solid ${primaryColor};
      padding-bottom: 16px;
      margin-bottom: 28px;
    }
    .header-logo img {
      max-height: 60px;
      max-width: 180px;
      object-fit: contain;
    }
    .header-broker {
      text-align: right;
      font-size: 13px;
    }
    .header-broker .name {
      font-size: 16px;
      font-weight: 700;
      color: ${primaryColor};
    }
    h1 {
      font-size: 22px;
      color: ${primaryColor};
      margin-bottom: 4px;
    }
    .subtitle {
      font-size: 13px;
      color: #666;
      margin-bottom: 24px;
    }
    .section-title {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #888;
      margin: 20px 0 10px;
      padding-bottom: 4px;
      border-bottom: 1px solid #eee;
    }
    .item {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 8px 12px;
      border-radius: 6px;
      margin-bottom: 6px;
      font-size: 13px;
    }
    .item.red    { background: #fff0f0; border-left: 4px solid #ef5350; }
    .item.yellow { background: #fffde7; border-left: 4px solid #ffc107; }
    .item.green  { background: #f1f8e9; border-left: 4px solid #66bb6a; }
    .item.info   { background: #eff6ff; border-left: 4px solid #60a5fa; }
    .item .icon  { font-size: 16px; flex-shrink: 0; }
    .item-body strong { display: block; font-weight: 700; }
    .item-body p { margin-top: 2px; color: #444; }
    .facts-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 4px; }
    .facts-table td { padding: 4px 6px; vertical-align: top; }
    .facts-table td:first-child { color: #888; width: 40%; }
    .facts-table td:last-child { font-weight: 500; }
    .compliance { background: #ffebee; border: 1px solid #ef9a9a; border-radius: 4px; padding: 4px 8px; font-size: 11px; font-weight: 700; color: #c62828; margin-top: 4px; display: inline-block; }
    .footer {
      margin-top: 40px;
      padding-top: 16px;
      border-top: 1px solid #eee;
      font-size: 11px;
      color: #999;
      line-height: 1.5;
    }
    .print-btn {
      background: ${primaryColor};
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 10px 20px;
      font-size: 14px;
      cursor: pointer;
      margin-bottom: 24px;
    }
  </style>
</head>
<body>

<div class="no-print" style="display:flex;gap:10px;align-items:center;margin-bottom:24px">
  <button class="print-btn" onclick="window.print()">📄 Spara som PDF (Ctrl+P)</button>
  <button class="print-btn" style="background:#4b5563" onclick="downloadReport()">💾 Ladda ner HTML</button>
</div>
<script>
function downloadReport() {
  var title = document.title.replace(/[^\w\s\-åäö]/gi, "").trim();
  var blob = new Blob([document.documentElement.outerHTML], { type: "text/html;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = title + ".html";
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<div class="header">
  <div class="header-logo">
    ${logoUrl ? `<img src="${logoUrl}" alt="Logo">` : `<span style="font-size:22px;font-weight:700;color:${primaryColor}">${brokerFirm || "AI Property Scout"}</span>`}
  </div>
  <div class="header-broker">
    <div class="name">${brokerName}</div>
    <div>${brokerFirm}</div>
    ${phone ? `<div>${phone}</div>` : ""}
    <div style="margin-top:4px;color:#999;font-size:12px">${date}</div>
  </div>
</div>

<h1>${propertyData.address || "Fastighetsanalys"}</h1>
<div class="subtitle">
  ${propertyData.price ? `Pris: ${propertyData.price}` : ""}
  ${propertyData.livingArea ? ` · ${propertyData.livingArea}` : ""}
</div>

${itemsHtml}

<div class="footer">
  <p>Analys genererad av <strong>${brokerName || "AI Property Scout"}</strong> med AI Property Scout.</p>
  <p style="margin-top:4px"><em>Denna analys är ett beslutsstöd och ersätter inte mäklarens juridiska ansvar eller en professionell besiktning. Uppgifterna är baserade på tillgänglig dokumentation vid analystillfället.</em></p>
</div>

</body>
</html>`;
  reportWindow.document.write(html);
  reportWindow.document.close();
}

function buildReportItems(data, docType) {
  if (!data) {
    return "<p>Ingen analysdata tillgänglig.</p>";
  }
  if (Array.isArray(data) || docType === "besiktning") {
    return data.map((item) => {
      const color = mapRiskColor(item.risk);
      const icon = mapRiskIcon(item.risk);
      const compliance = item.compliance_flagga ? `<span class="compliance">⚠️ Compliance-flagga</span>` : "";
      return `<div class="item ${color}">
            <span class="icon">${icon}</span>
            <div class="item-body">
              <strong>${item.kategori}</strong>
              <p>${item.sammanfattning || ""}</p>
              ${compliance}
            </div>
          </div>`;
    }).join("");
  }
  const items = [];
  if (data.lan_per_kvm != null) {
    const color = data.lan_per_kvm < 5e3 ? "green" : data.lan_per_kvm < 1e4 ? "yellow" : "red";
    items.push({ color, icon: mapRiskIcon(color), title: "Lån per kvm", desc: `${new Intl.NumberFormat("sv-SE").format(Math.round(data.lan_per_kvm))} kr/kvm` });
  }
  if (data.akta) {
    const color = data.akta === "äkta" ? "green" : data.akta === "oäkta" ? "red" : "yellow";
    items.push({ color, icon: mapRiskIcon(color), title: "Äkta / Oäkta BRF", desc: data.akta_forklaring || data.akta });
  }
  if (data.avgiftshojning_planerad != null) {
    const color = data.avgiftshojning_planerad ? "red" : "green";
    items.push({ color, icon: mapRiskIcon(color), title: "Avgiftshöjning", desc: data.avgiftshojning_notering || (data.avgiftshojning_planerad ? "Planerad" : "Ej planerad") });
  }
  if (data.renoveringar?.length > 0) {
    const hasStambyte = data.renoveringar.some((r) => r.typ?.toLowerCase().includes("stambyte"));
    items.push({ color: hasStambyte ? "red" : "yellow", icon: hasStambyte ? "🔴" : "🟡", title: "Renoveringar", desc: data.renoveringar.map((r) => `${r.typ} (${r.år})`).join(", ") });
  }
  if (data.parkering) {
    const color = data.parkering === "ingår" ? "green" : data.parkering === "kö" ? "yellow" : "red";
    items.push({ color, icon: mapRiskIcon(color), title: "Parkering", desc: data.parkering });
  }
  if (data.notering) {
    items.push({ color: "yellow", icon: "🟡", title: "Övrigt", desc: data.notering });
  }
  return items.map(
    (i) => `<div class="item ${i.color}">
        <span class="icon">${i.icon}</span>
        <div class="item-body"><strong>${i.title}</strong><p>${i.desc}</p></div>
      </div>`
  ).join("") || "<p>Inga kritiska fynd.</p>";
}

function mapRiskColor(risk) {
  const lower = (risk || "").toLowerCase();
  if (lower === "röd" || lower === "red") {
    return "red";
  }
  if (lower === "grön" || lower === "green") {
    return "green";
  }
  return "yellow";
}

function mapRiskIcon(riskOrColor) {
  const lower = (riskOrColor || "").toLowerCase();
  if (lower === "röd" || lower === "red") {
    return "🔴";
  }
  if (lower === "grön" || lower === "green") {
    return "🟢";
  }
  return "🟡";
}

function buildFactsSection(propertyData, agentData) {
  const fmt = (v) => (v != null ? String(v) : null);
  const rows = [
    ["Adress", fmt(propertyData.address)],
    ["Pris", fmt(propertyData.price)],
    ["Boarea", fmt(propertyData.livingArea)],
    ["Antal rum", fmt(propertyData.antalRum)],
    ["Byggår", fmt(propertyData.byggnadsår)],
    ["Fastighetstyp", fmt(propertyData.propertyType)],
    ["Upplåtelseform", fmt(propertyData.upplatelseform)],
    ["Energiklass", fmt(propertyData.energiklass)],
    ["Uppvärmning", fmt(propertyData.uppvarmning)],
    ["Driftkostnad", fmt(propertyData.driftkostnad)],
    ["BRF-avgift", fmt(propertyData.avgift)],
    ["Tomtstorlek", fmt(propertyData.tomtstorlek)],
    ["Befintliga pantbrev", fmt(propertyData.pantbrev)]
  ].filter(([, v]) => v);
  const agentRows = agentData ? [
    ["Fasad", fmt(agentData.fasad)],
    ["Tak", fmt(agentData.tak)],
    ["Stomme", fmt(agentData.stomme)],
    ["Grundläggning", fmt(agentData.grundlaggning)],
    ["Fönster", fmt(agentData.fonster)],
    ["Ventilation", fmt(agentData.ventilation)],
    ["Vatten & avlopp", fmt(agentData.vatten_avlopp)],
    ["Fastighetsbeteckning", fmt(agentData.fastighetsbeteckning)],
    ["Taxeringsvärde", agentData.taxeringsvarde ? `${new Intl.NumberFormat("sv-SE").format(agentData.taxeringsvarde)} kr` : null],
    ["Fastighetsskatt", agentData.fastighetsskatt ? `${new Intl.NumberFormat("sv-SE").format(agentData.fastighetsskatt)} kr/år` : null],
    ["Energiprestanda", agentData.energiprestanda_kwh ? `${agentData.energiprestanda_kwh} kWh/m²/år` : null],
    ["Parkering", fmt(agentData.parkering)],
    ["Servitut", fmt(agentData.servitut)],
    ["Biarea", agentData.biarea ? `${agentData.biarea} m²` : null],
    ["Renoveringar", Array.isArray(agentData.renoveringar) && agentData.renoveringar.length > 0 ? agentData.renoveringar.join(", ") : null]
  ].filter(([, v]) => v) : [];
  if (rows.length === 0 && agentRows.length === 0) {
    return "";
  }
  const allRows = [...rows, ...agentRows];
  return `<div class="section-title">Fastighetsfakta</div>
    <table class="facts-table">${allRows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>`;
}

function buildKeyInfoSection(keyInfo) {
  if (!keyInfo || keyInfo.length === 0) {
    return "";
  }
  const colorMap = { red: "red", yellow: "yellow", green: "green", info: "info" };
  const iconMap = { red: "🔴", yellow: "🟡", green: "🟢", info: "ℹ️" };
  const items = keyInfo.map(({ label, color, aiText }) => {
    const c = colorMap[color] || "yellow";
    const icon = iconMap[color] || "🟡";
    return `<div class="item ${c}">
      <span class="icon">${icon}</span>
      <div class="item-body"><strong>${label}</strong>${aiText ? `<p>${aiText}</p>` : ""}</div>
    </div>`;
  }).join("");
  return `<div class="section-title">Nyckelinfo från mäklartext</div>${items}`;
}

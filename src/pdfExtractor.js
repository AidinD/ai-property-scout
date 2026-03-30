(function() {
  function extractTextFromPDFViewer() {
    const body = document.body?.innerText || document.documentElement?.innerText || "";
    return body.trim();
  }
  const text = extractTextFromPDFViewer();
  if (text && text.length > 50) {
    chrome.runtime.sendMessage({
      type: "PDF_TEXT",
      text,
      tabId: null
      // background.js infers from sender
    });
  }
})();

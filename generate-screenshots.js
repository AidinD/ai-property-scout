const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const fileUrl = 'file:///' + path.resolve(__dirname, 'screenshots.html').replace(/\\/g, '/');
  await page.goto(fileUrl, { waitUntil: 'networkidle0' });

  const scenes = ['scene1', 'scene2', 'scene3'];
  for (const id of scenes) {
    const el = await page.$(`#${id}`);
    await el.screenshot({
      path: `screenshot-${id}.png`,
      type: 'png',
      omitBackground: false,
    });
    console.log(`Saved screenshot-${id}.png`);
  }

  await browser.close();
})();

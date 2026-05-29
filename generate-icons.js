const sharp = require('sharp');
const path = require('path');

const src = 'C:\\Users\\aidin\\Downloads\\ai_property_scout_icon.svg';
const sizes = [16, 48, 128];

(async () => {
  for (const size of sizes) {
    const out = path.join(__dirname, 'dist', 'icons', `icon${size}.png`);
    await sharp(src)
      .resize(size, size)
      .png()
      .toFile(out);
    console.log(`Saved icon${size}.png`);
  }
})();

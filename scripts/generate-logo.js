/**
 * scripts/generate-logo.js
 * ---------------------------------------------------------------------------
 * Genera assets/logo.png (512x512) replicando el ícono oficial de Cine
 * Tucumano: fondo amarillo, marca "G" y texto "CINE TUCUMANO" en negro.
 *
 * Uso los assets oficiales del sitio como materia prima:
 *   - icon512_maskable.png  -> recorto la marca "G"
 *   - color de fondo        -> sampleado del propio asset (consistencia total)
 *
 * Es un script one-off de desarrollo (jimp es devDependency, no viaja a prod):
 *   node scripts/generate-logo.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const Jimp = require('jimp');

const BASE = 'https://cinetucumano.com.ar';
const TMP = path.join(__dirname, '..', '.tmp-assets');
const OUT = path.join(__dirname, '..', 'assets', 'logo.png');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`${res.statusCode} ${url}`));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const maskablePath = path.join(TMP, 'icon512_maskable.png');
  if (!fs.existsSync(maskablePath)) {
    await download(`${BASE}/icon512_maskable.png`, maskablePath);
  }

  const maskable = await Jimp.read(maskablePath);

  // Color de fondo exacto del asset oficial (esquina superior izquierda).
  const d = maskable.bitmap.data;
  const bg = Jimp.rgbaToInt(d[0], d[1], d[2], 255);
  console.log('color de fondo sampleado:', '#' + bg.toString(16).padStart(8, '0').slice(0, 6));

  // Lienzo 512x512 con el color de marca.
  const canvas = new Jimp(512, 512, bg);

  // Recorto la marca "G" del centro del asset maskable y la escalo.
  const size = maskable.bitmap.width; // 512
  const crop = Math.round(size * 0.62); // la G ocupa ~62% central
  const offset = Math.round((size - crop) / 2);
  const g = maskable.clone().crop(offset, offset, crop, crop);

  const gWidth = 270;
  const gHeight = gWidth; // el recorte es cuadrado
  g.resize(gWidth, gHeight);
  canvas.composite(g, Math.round((512 - gWidth) / 2), 48);

  // Texto "CINE TUCUMANO" en dos líneas centradas.
  const font = await Jimp.loadFont(Jimp.FONT_SANS_64_BLACK);
  const line1 = 'CINE';
  const line2 = 'TUCUMANO';
  const w1 = Jimp.measureText(font, line1);
  const w2 = Jimp.measureText(font, line2);
  canvas.print(font, Math.round((512 - w1) / 2), 348, line1);
  canvas.print(font, Math.round((512 - w2) / 2), 428, line2);

  await canvas.writeAsync(OUT);
  console.log('ícono generado en', OUT);
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});

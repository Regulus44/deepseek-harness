// Generate DeepSeek icon assets from the official logo vector.
//
// Source: the whale mark shipped with dsh-web-frontend (dist/favicon.svg).
// The favicon only colors the path white under dark mode and leaves it
// unfilled otherwise, so we extract the path and re-fill it with the official
// DeepSeek Blue #4D6BFE, then render PNGs and a multi-size .ico for Windows.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = process.env.DSH_ICON_SRC || path.join(ROOT, 'build', 'icon-source.svg');
const OUT = path.join(ROOT, 'build');
const FILL = '#4D6BFE'; // DeepSeek Blue

const svg = readFileSync(SRC, 'utf8');
const match = svg.match(/<path[^>]*\bd="([^"]+)"/);
if (!match) throw new Error('could not find the logo path in ' + SRC);
const d = match[1];

// Rebuild a clean, deterministically-colored SVG at a crisp base size.
const cleanSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 50 50">` +
  `<path d="${d}" fill="${FILL}"/></svg>`;

mkdirSync(OUT, { recursive: true });

const base = await sharp(Buffer.from(cleanSvg)).png().toBuffer(); // 256x256

const sizes = [256, 128, 64, 48, 32, 16];
const buffers = [];
for (const size of sizes) {
  const buf = await sharp(base).resize(size, size).png().toBuffer();
  const file = path.join(OUT, `icon-${size}.png`);
  writeFileSync(file, buf);
  buffers.push(buf);
  console.log(`wrote ${path.relative(ROOT, file)} (${buf.length} bytes)`);
}

const ico = await pngToIco(buffers);
const icoPath = path.join(OUT, 'icon.ico');
writeFileSync(icoPath, ico);
console.log(`wrote ${path.relative(ROOT, icoPath)} (${ico.length} bytes)`);

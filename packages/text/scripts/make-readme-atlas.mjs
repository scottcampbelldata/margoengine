// Margo-authored BMFont SDF atlas from the repository's licensed Source Sans 3 test font.
// From the repository root: node scripts/gpu-lock.mjs run --owner=codex-readme5 --max=3 -- node packages/text/scripts/make-readme-atlas.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const root = resolve(import.meta.dirname, '../../..');
const out = resolve(root, 'packages/text/tests/fixtures/fonts/readme');
const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await launchBrowser({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${server.resolvedUrls.local[0]}packages/text/tests/fixtures/fonts/OFL.txt`);
  const result = await page.evaluate(async () => {
    const { alphaToSdf } = await import('/packages/text/src/sdf.ts');
    const face = new FontFace('Margo README Sans', 'url(/packages/text/tests/fixtures/fonts/SourceSans3-Regular.ttf)');
    await face.load();
    document.fonts.add(face);
    const size = 48,
      buffer = 9,
      radius = 16,
      cell = 80,
      columns = 16;
    const atlas = new OffscreenCanvas(columns * cell, 6 * cell),
      context = atlas.getContext('2d');
    context.fillStyle = '#000';
    context.fillRect(0, 0, atlas.width, atlas.height);
    const scratch = new OffscreenCanvas(cell, cell),
      draw = scratch.getContext('2d', { willReadFrequently: true });
    draw.font = `${size}px "Margo README Sans"`;
    const metrics = draw.measureText('Hg'),
      base = Math.ceil(metrics.fontBoundingBoxAscent);
    const chars = [];
    for (let id = 32; id < 127; id++) {
      const letter = String.fromCodePoint(id),
        m = draw.measureText(letter);
      const x0 = Math.floor(-m.actualBoundingBoxLeft) - 1,
        y0 = Math.floor(-m.actualBoundingBoxAscent) - 1;
      const width = id === 32 ? 0 : Math.ceil(m.actualBoundingBoxRight) + 1 - x0 + 2 * buffer;
      const height = id === 32 ? 0 : Math.ceil(m.actualBoundingBoxDescent) + 1 - y0 + 2 * buffer;
      if (width > cell || height > cell) throw new Error(`Atlas cell is too small for ${letter}`);
      const x = ((id - 32) % columns) * cell,
        y = Math.floor((id - 32) / columns) * cell;
      chars.push({
        id,
        x,
        y,
        width,
        height,
        xoffset: x0 - buffer,
        yoffset: base + y0 - buffer,
        xadvance: m.width,
        page: 0,
      });
      if (!width) continue;
      draw.clearRect(0, 0, cell, cell);
      draw.fillStyle = '#000';
      draw.fillText(letter, buffer - x0, buffer - y0);
      const alpha = draw.getImageData(0, 0, width, height);
      const field = alphaToSdf(alpha.data, width, height, { radius, cutoff: 0.5 }, 4, 3);
      for (let i = 0; i < field.length; i++) {
        alpha.data[i * 4] = alpha.data[i * 4 + 1] = alpha.data[i * 4 + 2] = field[i];
        alpha.data[i * 4 + 3] = 255;
      }
      context.putImageData(alpha, x, y);
    }
    const blob = await atlas.convertToBlob({ type: 'image/png' });
    return {
      data: {
        pages: ['source-sans.png'],
        chars,
        info: { face: 'Margo README Sans', size },
        common: {
          lineHeight: base + Math.ceil(metrics.fontBoundingBoxDescent),
          base,
          scaleW: atlas.width,
          scaleH: atlas.height,
          pages: 1,
        },
        distanceField: { fieldType: 'sdf', distanceRange: radius },
      },
      png: Array.from(new Uint8Array(await blob.arrayBuffer())),
    };
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, 'source-sans.json'), JSON.stringify(result.data, null, 2) + '\n');
  writeFileSync(resolve(out, 'source-sans.png'), Buffer.from(result.png));
  console.log(`Generated ${result.data.chars.length} glyphs, ${result.png.length} PNG bytes in ${out}`);
} finally {
  await closeAll({ browser, servers: [server] });
}

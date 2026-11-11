import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BitmapFont } from '@margoengine/text/msdf';
import { GlyphAtlas } from '../dist/index.js';

const data = {
  pages: ['p.png'], info: { size: 2 }, common: { lineHeight: 2, base: 2 },
  chars: [{ id: 65, x: 0, y: 0, width: 2, height: 1, xoffset: 0, yoffset: 0, xadvance: 2, page: 0 }],
  distanceField: { fieldType: 'msdf', distanceRange: 2 },
};
const pixels = Uint8Array.of(40, 240, 40, 255, 240, 40, 40, 255);
test('keeps RGB channels intact and retains the scalar glyph-consumer fallback', () => {
  const font = new BitmapFont(data, [{ width: 2, height: 1, data: pixels }]);
  const g = font.glyph('A');
  assert.deepEqual(g.msdf, pixels);
  assert.notEqual(g.msdf, pixels);
  assert.deepEqual([...g.data], [40, 40]);
  // These operations do not commute. The GPU must use the middle value 140, not 40.
  const median = (a,b,c) => [a,b,c].sort((x,y)=>x-y)[1];
  assert.equal(median((40+240)/2,(240+40)/2,40),140);
  assert.equal((g.data[0]+g.data[1])/2,40);
});
test('atlas uploads RGB data as RGBA and restores it unchanged; scalar consumers stay valid', () => {
  const uploads = [];
  const device = { createTexture: () => ({ createView: () => ({}), destroy() {} }),
    queue: { writeTexture: (...args) => uploads.push(args) } };
  const g = new BitmapFont(data, [{ width: 2, height: 1, data: pixels }]).glyph('A');
  const rgba = new GlyphAtlas(device, 'rgba8unorm', 64, 1);
  rgba.place(g);
  assert.equal(uploads[0][1], g.msdf);
  assert.equal(uploads[0][2].bytesPerRow, 8);
  rgba.restore(device);
  assert.equal(uploads[1][1],g.msdf);
  const scalar = new GlyphAtlas(device,'r8unorm',64,1);
  scalar.place(g);
  assert.equal(uploads[2][1],g.data);
  rgba.dispose(); scalar.dispose();
});
test('single-channel fonts retain their old data path and multi-channel kinds include MTSDF', () => {
  assert.equal(new BitmapFont({...data,distanceField:{fieldType:'sdf',distanceRange:2}},[{width:2,height:1,data:pixels}]).glyph('A').msdf,undefined);
  const mtsdf = new BitmapFont({...data,distanceField:{fieldType:'mtsdf',distanceRange:2}},[{width:2,height:1,data:pixels}]);
  assert.deepEqual(mtsdf.glyph('A').msdf,pixels);
  const shader = readFileSync(new URL('../src/shader.ts',import.meta.url),'utf8');
  assert.ok(shader.indexOf('textureSampleLevel(colorAtlas') < shader.indexOf('texel = max(min(tint.r'));
});

test('PNG loading preserves MTSDF RGB values even below transparent alpha and obeys cancellation', async () => {
  const { encodePNG } = await import('@margoengine/exporters/capture');
  const raw=Uint8Array.of(19,211,73,0,217,31,137,41);
  const png=await encodePNG({width:2,height:1,data:raw});
  const page='data:image/png;base64,'+Buffer.from(png).toString('base64');
  const json='data:application/json,'+encodeURIComponent(JSON.stringify({...data,pages:[page],distanceField:{fieldType:'mtsdf',distanceRange:2}}));
  const font=await BitmapFont.load(json);
  assert.deepEqual(font.glyph('A').msdf,raw);
  await assert.rejects(BitmapFont.load(json,{signal:AbortSignal.abort()}),{name:'AbortError'});
});

test('a relative pagesAt resolves against the JSON file (batch 132b)', async () => {
  const { encodePNG } = await import('@margoengine/exporters/capture');
  const png = await encodePNG({ width: 2, height: 1, data: pixels });
  const asked = [], real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    if (String(url) === 'https://fonts.test/a/font.json') return new Response(JSON.stringify(data));
    if (String(url) === 'https://fonts.test/pages/p.png') return new Response(png);
    return new Response('', { status: 404 });
  };
  try {
    // Before the fix new URL('p.png', '../pages/') threw TypeError: Invalid URL.
    const font = await BitmapFont.load('https://fonts.test/a/font.json', { pagesAt: '../pages/' });
    assert.deepEqual(font.glyph('A').msdf, pixels);
    assert.deepEqual(asked, ['https://fonts.test/a/font.json', 'https://fonts.test/pages/p.png']);
  } finally {
    globalThis.fetch = real;
  }
});

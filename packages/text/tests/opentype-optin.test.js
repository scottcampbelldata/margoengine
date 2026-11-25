// Pay only for what you import: the CFF, CFF2 and variation readers are opt-in. TrueType fonts read without them;
// CFF files and variable instances name the fix; the async loaders fetch the readers only when a file needs them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { openType } from '@margoengine/loaders/font-opentype';
import { extrudeText, parseFontOutlines } from '../dist/extrude.js';
import { GlyphFieldFont } from '../dist/outline.js';

const bytes = (name) => readFileSync(new URL(`./fixtures/fonts/${name}`, import.meta.url));
const needsReaders = (e) => e.name === 'LoaderError' && e.code === 'unsupported' && /font-opentype/.test(e.message);

test('TrueType extrudes without the OpenType readers; CFF and variable instances ask for them', () => {
  const mesh = extrudeText('Ag', { font: bytes('SourceSans3-Regular.ttf') });
  assert.ok(mesh.indices.length > 0);
  assert.throws(() => extrudeText('Ag', { font: bytes('SourceSans3-Regular.otf') }), needsReaders);
  assert.throws(
    () => parseFontOutlines(bytes('SourceSans3VF-Upright.ttf')).withVariations({ wght: 700 }),
    needsReaders,
  );
  assert.ok(extrudeText('Ag', { font: bytes('SourceSans3-Regular.otf'), openType }).indices.length > 0);
  const bold = parseFontOutlines(bytes('SourceSans3VF-Upright.ttf'), { openType }).withVariations({ wght: 700 });
  assert.ok(bold.varied);
});

test('GlyphFieldFont.load imports the readers itself for a CFF file and a variable instance', async () => {
  const url = (name) => `data:font/otf;base64,${bytes(name).toString('base64')}`;
  const cff = await GlyphFieldFont.load(url('SourceSans3-Regular.otf'));
  const reference = new GlyphFieldFont(bytes('SourceSans3-Regular.otf'), { openType });
  assert.equal(cff.advance('AVg'), reference.advance('AVg'));
  const heavy = await GlyphFieldFont.load(url('SourceSans3VF-Upright.ttf'), { variations: { wght: 900 } });
  assert.ok(heavy.advance('H') > (await GlyphFieldFont.load(url('SourceSans3VF-Upright.ttf'))).advance('H'));
});

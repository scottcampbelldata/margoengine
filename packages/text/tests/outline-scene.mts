// Node side of tests/outline-node-gpu.mjs: the scene of outline-scene.js through the `webgpu` binding, from dist.
// Usage: node outline-scene.mts <font file> <out.png> <out.json>
import { readFile, writeFile } from 'node:fs/promises';
import { Camera, Engine } from '@margoengine/core';
import { createHeadlessCanvas, installGPU, readPixels, toPNG } from '@margoengine/headless';
import { Text, TextRenderer } from '@margoengine/text';
import { GlyphFieldFont } from '@margoengine/text/outline';
import { Label, Panel, Ui, UiRenderer } from '@margoengine/ui';
import { create } from 'webgpu';
import { SCENE_SIZE, buildScene, fieldHash } from './outline-scene.js';

const [fontFile, pngFile, jsonFile] = process.argv.slice(2);
const font = new GlyphFieldFont(await readFile(fontFile));
using installed = installGPU({ gpu: create([]) });
const engine = await Engine.create(createHeadlessCanvas({ width: SCENE_SIZE[0], height: SCENE_SIZE[1] }), { backend: 'webgpu' });
const errors: string[] = [];
engine.gpu.addEventListener('uncapturederror', (event) => errors.push((event as GPUUncapturedErrorEvent).error.message));
const camera = buildScene(engine, { TextRenderer, Text, Camera }, font);
engine.render({ camera });
await writeFile(pngFile, await toPNG(engine));

// A lower third through @margoengine/ui over the same frame (the plan's open risk: UiRenderer in Node): first as the
// README attaches it, then with input off, then with input and the accessibility mirror off, so the report says which
// part fails. Reported, not asserted (bug-sweep KB-FILM-UI-NODE).
const ui: { drawn?: number; error?: string; withoutInput?: number | string; bare?: number | string } = {};
const short = (error: unknown) => String((error as Error)?.stack ?? error).split('\n').slice(0, 3).join(' | ');
const inkOf = async () => {
  const { data } = await readPixels(engine);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - 0x1d) + Math.abs(data[i + 1] - 0x27) + Math.abs(data[i + 2] - 0x33) > 24) n++;
  return n;
};
const lowerThird = (name: string) => {
  const lower = new Ui({ width: SCENE_SIZE[0], height: SCENE_SIZE[1], font, reducedMotion: true });
  lower.add(new Panel({ anchor: 'bottom-left', margin: 24, padding: 12, background: 'surface', children: [new Label({ text: name })] }));
  return lower;
};
const before = await inkOf();
try {
  UiRenderer.attach(engine, lowerThird('Lower third: a name here'));
  engine.render({ camera });
  ui.drawn = (await inkOf()) - before;
} catch (error) {
  ui.error = short(error);
  try {
    UiRenderer.attach(engine, lowerThird('Lower third: no input'), { name: 'ui:noinput', input: false });
    engine.render({ camera });
    ui.withoutInput = (await inkOf()) - before;
  } catch (again) {
    ui.withoutInput = short(again);
    try {
      UiRenderer.attach(engine, lowerThird('Lower third: bare'), { name: 'ui:bare', input: false, mirror: false });
      engine.render({ camera });
      ui.bare = (await inkOf()) - before;
    } catch (third) {
      ui.bare = short(third);
    }
  }
}
await writeFile(jsonFile, JSON.stringify({ hash: await fieldHash(font), errors, ui, stats: font.stats }));
engine.dispose();

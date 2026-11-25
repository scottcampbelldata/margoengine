// Page side of tests/outline-node-gpu.mjs: the scene of outline-scene.js on a page canvas, built from src.
import { Camera, Engine } from '@margoengine/core';
import { Text, TextRenderer } from '../src/index.ts';
import { GlyphFieldFont } from '../src/outline.ts';
import { buildScene, fieldHash } from './outline-scene.js';

window.check = {
  async page(fontUrl) {
    const font = await GlyphFieldFont.load(fontUrl),
      engine = await Engine.create(document.querySelector('#page'), { backend: 'webgpu' }),
      errors = [];
    engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    engine.render({ camera: buildScene(engine, { TextRenderer, Text, Camera }, font) });
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return { hash: await fieldHash(font), errors, backend: engine.backend ?? 'webgpu' };
  },
  /** Kerning of pairs as the browser's own shaper measures it through a FontFace, at 1000 px. */
  async browserKerning(fontUrl, pairs) {
    const face = new FontFace('kerning-probe', await (await fetch(fontUrl)).arrayBuffer());
    await face.load();
    document.fonts.add(face);
    const context = new OffscreenCanvas(8, 8).getContext('2d');
    context.font = '1000px kerning-probe';
    context.fontKerning = 'normal';
    const width = (s) => context.measureText(s).width;
    const out = {};
    for (const pair of pairs) out[pair] = Math.round(width(pair) - width(pair[0]) - width(pair[1]));
    document.fonts.delete(face);
    return out;
  },
};
window.ready = true;

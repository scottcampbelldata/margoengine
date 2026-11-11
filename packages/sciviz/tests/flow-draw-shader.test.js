// Regression (found by KB-FF1b's check:wgsl run, 2026-11-11): sciviz exported its flow trail shader as a WGSL constant
// that still held the FLOW_PROJECT, FLOW_APPEARANCE and FLOW_COLOUR slots flow-particles.ts filled at draw time, so
// check:wgsl compiled the template and failed ("unexpected token | FLOW_PROJECT"). flowDraw is now a builder that fills
// every slot; check:wgsl compiles it with `globe` both ways.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

async function loadFlowShaders() {
  const entry = fileURLToPath(new URL('../src/flow-shaders.ts', import.meta.url)),
    result = await build({
      configFile: false,
      publicDir: false,
      logLevel: 'silent',
      build: { write: false, minify: false, lib: { entry, formats: ['es'] } },
    }),
    chunk = [result].flat().flatMap((r) => r.output).find((r) => r.type === 'chunk' && r.isEntry),
    dir = mkdtempSync(join(tmpdir(), 'sciviz-flow-shaders-'));
  try {
    writeFileSync(join(dir, 'flow-shaders.mjs'), chunk.code);
    return await import(pathToFileURL(join(dir, 'flow-shaders.mjs')).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('no exported flow shader holds an unfilled slot, and flowDraw fills each one', async () => {
  const shaders = await loadFlowShaders(),
    slot = /\bFLOW_[A-Z]+\b/;
  for (const [name, value] of Object.entries(shaders))
    if (typeof value === 'string') assert.doesNotMatch(value, slot, `${name} is complete WGSL`);
  assert.equal(typeof shaders.flowDraw, 'function');
  const flat = shaders.flowDraw(false),
    globe = shaders.flowDraw(true),
    aerial = shaders.flowDraw(true, 'fn planetAerial(p:vec3f,c:vec3f)->vec3f{return c;}');
  for (const code of [flat, globe, aerial]) assert.doesNotMatch(code, slot);
  assert.match(flat, /fn flowProject\(p:vec3f\)->vec3f\{return p;\}/);
  assert.match(globe, /0\.0066943799901413165/);
  assert.match(flat, /toOutput\(flow\.colour\.rgb\)/);
  assert.match(aerial, /toOutput\(planetAerial\(in\.world, flow\.colour\.rgb\)\)/);
});

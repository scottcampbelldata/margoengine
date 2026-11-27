// MARGO_COMPAT not applicable: the page compiles the layer's GLSL in WebGL2 directly and makes no WebGPU calls.
// The GLSL back end against the whole WGSL corpus in a real WebGL2 compiler (run by `npm run test:browser`, part of
// check:merge). Every recorded render pipeline is translated (storage buffers read through data textures, milestone
// M4) and its two shaders compiled and linked together; every vertex and fragment entry point of the corpus is
// translated and compiled on its own. A translation that WebGL2 refuses is a back-end bug. Entry points that
// write storage, use storage textures, atomics or compute are counted as waiting for a later milestone (M5), not skipped
// silently: the counts are printed and must not grow past the recorded ones without a reason. A module that enables
// an extension the layer does not map is refused with the coded error naming it (support/unmapped-enables.mjs), and a
// pipeline past the browser's texture units is refused as the device refuses it, counted and not linked.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { programUnits, unitsRefusal } from '../dist/device.js';
import { checkWGSL } from '../dist/wgsl.js';
import { translateStage, translateWGSL } from '../dist/glsl.js';
import { readCorpus } from './corpus/store.mjs';
import {
  assertEnableRefusal,
  assertOverUnits,
  assertUnmappedCounts,
  RECORDED_UNMAPPED_ENABLES,
  unmappedEnable,
} from './support/corpus-refusals.mjs';


const browser = await launchBrowser({ needs: 'none', headless: true });
const page = await browser.newPage();
const limits = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return null;
  return Object.fromEntries(
    ['MAX_TEXTURE_IMAGE_UNITS', 'MAX_VERTEX_TEXTURE_IMAGE_UNITS', 'MAX_COMBINED_TEXTURE_IMAGE_UNITS'].map((n) => [
      n,
      gl.getParameter(gl[n]),
    ]),
  );
});
assert.ok(limits, 'no WebGL2');
// The device counts against the browser's units; this check holds every pipeline to the WebGL2 minimum (OpenGL ES 3.0
// table 6.33: 16, 16, 32) as well, so a pipeline that fits only a roomier GPU fails here too.
const minimum = { MAX_TEXTURE_IMAGE_UNITS: 16, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32 };
const fitted = Object.fromEntries(Object.entries(limits).map(([n, v]) => [n, Math.min(v, minimum[n])]));

const { modules } = readCorpus();
const byKey = new Map(modules.map((m) => [m.key, m]));
const checked = new Map();
const ir = (key) => {
  if (!checked.has(key)) checked.set(key, checkWGSL(byKey.get(key).code));
  return checked.get(key);
};
/** Refusals that name a later milestone: the layer does not run these yet, by plan. */
const LATER = /milestone M[45]|has no subgroups/;

const programs = [],
  stages = [],
  waiting = new Map(),
  failures = [],
  unmapped = {},
  overUnits = [];
/** True when `m` enables an unmapped extension: asserts translate refuses it, coded and named, and counts it. */
const refusedEnable = (what, module, translate) => {
  const name = unmappedEnable(module);
  if (!name) return false;
  assert.throws(translate, (error) => (assertEnableRefusal(error, name, what), true));
  unmapped[name] = (unmapped[name] ?? 0) + 1;
  return true;
};
const refuse = (what, error) => {
  const message = String(error?.message ?? error);
  if (LATER.test(message)) {
    const reason = message.replace(/; see .*/, '').replace(/'[^']*'/g, "'...'");
    waiting.set(reason, (waiting.get(reason) ?? 0) + 1);
  } else failures.push(`${what}: ${message}`);
};

const seen = new Set();
for (const m of modules)
  for (const p of m.pipelines) {
    if (!p.vertex || p.vertex.module !== m.key) continue;
    const id = JSON.stringify([p.vertex, p.fragment, p.primitive?.topology]);
    if (seen.has(id)) continue;
    seen.add(id);
    const what = `pipeline ${m.package} ${m.key} ${p.vertex.entryPoint ?? ''}/${p.fragment?.entryPoint ?? ''}`;
    const translate = () =>
      translateWGSL({
        vertex: { module: ir(p.vertex.module), entryPoint: p.vertex.entryPoint, constants: p.vertex.constants },
        fragment: p.fragment && {
          module: ir(p.fragment.module),
          entryPoint: p.fragment.entryPoint,
          constants: p.fragment.constants,
        },
        points: p.primitive?.topology === 'point-list',
        // As the device translates: storage bindings without a dynamic offset share their group's data texture.
        sharedStorage: (group, binding) =>
          p.layout === 'auto' || !p.layout?.[group]?.find((e) => e.binding === binding)?.buffer?.dynamic,
        textureUnits: { vertex: fitted.MAX_VERTEX_TEXTURE_IMAGE_UNITS, fragment: fitted.MAX_TEXTURE_IMAGE_UNITS },
      });
    if (refusedEnable(what, ir(p.vertex.module), translate) || (p.fragment && refusedEnable(what, ir(p.fragment.module), translate)))
      continue;
    try {
      const program = translate();
      // As the device counts before it links (src/device/render.ts): past the units, refused, not linked.
      const over = programUnits(program, fitted).over;
      if (over) {
        overUnits.push([p.fragment?.module ?? p.vertex.module, `${what}: WebGL2 compatibility cannot do ${unitsRefusal(over)}`]);
        continue;
      }
      programs.push({
        id: `${m.package} ${m.key} ${p.vertex.entryPoint ?? ''}/${p.fragment?.entryPoint ?? ''}`,
        vertex: program.vertex.source,
        fragment: program.fragment.source,
      });
    } catch (error) {
      refuse(`pipeline ${m.package} ${m.key}`, error);
    }
  }

for (const m of modules) {
  const module = ir(m.key);
  for (const e of module.entryPoints) {
    if (e.stage === 'compute') continue;
    // Overrides without a default need a value; 1 suits every one the corpus declares without one.
    const constants = Object.fromEntries(
      module.globals.filter((g) => g.kind === 'override' && !g.init).map((g) => [g.name, 1]),
    );
    const what = `${e.stage} ${m.package} ${m.key} ${e.name}`;
    if (refusedEnable(what, module, () => translateStage({ module, entryPoint: e.name, constants }, e.stage))) continue;
    try {
      const stage = translateStage({ module, entryPoint: e.name, constants }, e.stage);
      stages.push({ id: `${m.package} ${m.key} ${e.stage} ${e.name}`, type: e.stage, source: stage.source });
    } catch (error) {
      refuse(`${e.stage} ${m.package} ${m.key} ${e.name}`, error);
    }
  }
}

try {
  const result = await page.evaluate(
    ({ programs, stages }) => {
      const gl = document.createElement('canvas').getContext('webgl2', { antialias: false });
      if (!gl) return { error: 'no WebGL2' };
      const out = [];
      const compile = (type, source) => {
        const s = gl.createShader(type === 'vertex' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        return s;
      };
      const log = (s) => (gl.getShaderParameter(s, gl.COMPILE_STATUS) ? null : gl.getShaderInfoLog(s));
      for (const p of programs) {
        const v = compile('vertex', p.vertex),
          f = compile('fragment', p.fragment);
        const program = gl.createProgram();
        gl.attachShader(program, v);
        gl.attachShader(program, f);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
          out.push(`${p.id}: ${log(v) ?? ''} ${log(f) ?? ''} ${gl.getProgramInfoLog(program)}`.slice(0, 2000));
        gl.deleteProgram(program);
        gl.deleteShader(v);
        gl.deleteShader(f);
      }
      for (const s of stages) {
        const shader = compile(s.type, s.source);
        const error = log(shader);
        if (error) out.push(`${s.id}: ${error}`.slice(0, 2000));
        gl.deleteShader(shader);
      }
      return { failures: out, renderer: gl.getParameter(gl.RENDERER) };
    },
    { programs, stages },
  );
  assert.equal(result.error, undefined, result.error);
  failures.push(...result.failures);
  const later = [...waiting].map(([reason, n]) => `  ${n} x ${reason}`).join('\n');
  console.log(
    `GLSL corpus: ${programs.length} pipelines linked, ${stages.length} entry points compiled on ${result.renderer}; waiting for later milestones:\n${later}`,
  );
  const enables = Object.entries(unmapped)
    .map(([name, n]) => `${n} x 'enable ${name};'`)
    .join(', ');
  console.log(`refused for an unmapped enable: ${enables || 'none'}; refused for texture units: ${overUnits.length}`);
  assert.deepEqual(failures, []);
  assertUnmappedCounts(unmapped, RECORDED_UNMAPPED_ENABLES.glsl, 'GLSL corpus');
  assertOverUnits(overUnits, 'GLSL corpus');
  // The corpus has hundreds of render pipelines without storage: a near-empty count means nothing was translated.
  assert.ok(programs.length > 200 && stages.length > 600, `${programs.length} pipelines, ${stages.length} stages`);
} finally {
  await browser.close();
}

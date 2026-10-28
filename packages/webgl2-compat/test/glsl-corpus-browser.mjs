// The GLSL back end against the whole WGSL corpus in a real WebGL2 compiler (run by `npm run test:browser`, part of
// check:merge). Every recorded render pipeline is translated (storage buffers read through data textures, milestone
// M4) and its two shaders compiled and linked together; every vertex and fragment entry point of the corpus is
// translated and compiled on its own. A translation that WebGL2 refuses is a back-end bug. Entry points that
// write storage, use storage textures, atomics or compute are counted as waiting for a later milestone (M5), not skipped
// silently: the counts are printed and must not grow past the recorded ones without a reason.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { checkWGSL } from '../dist/wgsl.js';
import { translateStage, translateWGSL } from '../dist/glsl.js';
import { readCorpus } from './corpus/store.mjs';

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
  failures = [];
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
    try {
      const program = translateWGSL({
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
      });
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
    try {
      const stage = translateStage({ module, entryPoint: e.name, constants }, e.stage);
      stages.push({ id: `${m.package} ${m.key} ${e.stage} ${e.name}`, type: e.stage, source: stage.source });
    } catch (error) {
      refuse(`${e.stage} ${m.package} ${m.key} ${e.name}`, error);
    }
  }
}

const browser = await launchBrowser({ needs: 'none', headless: true });
try {
  const page = await browser.newPage();
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
  assert.deepEqual(failures, []);
  // The corpus has hundreds of render pipelines without storage: a near-empty count means nothing was translated.
  assert.ok(programs.length > 200 && stages.length > 600, `${programs.length} pipelines, ${stages.length} stages`);
} finally {
  await browser.close();
}

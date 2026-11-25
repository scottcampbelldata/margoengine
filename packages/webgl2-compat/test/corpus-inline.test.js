// No corpus kernel grows into minutes of Direct3D compile (KB-COMPAT-FXCTIME1). ANGLE's WebGL2 on Windows hands the
// translated program to fxc, which inlines every call and unrolls every loop it can count: five kernels took it 38 to
// 98 s each to link cold, for anyone on the layer. A call-graph walk (scripts/support/wgsl-inline.mjs) measures what
// such a compiler makes of each entry point; a new recording with a kernel past these limits fails here, before its
// first cold link costs a user a minute. The voxel path tracer is checked on its own (docs/known-bugs.md, KB-L5a-10),
// as the corpus draw leaves it out.
import assert from 'node:assert/strict';
import test from 'node:test';
import { inlinedCopies, wgslCallGraph } from '../../../scripts/support/wgsl-inline.mjs';
import { readCorpus } from './corpus/store.mjs';

/**
 * Characters of function body an inline-everything, unroll-what-it-can-count compiler makes of one entry point. The
 * largest kernels that link in under a second hold up to 228,000 (terrain's surface); the robot-planning clearance
 * kernel held 3.4 million, sciviz's mapped volume 310,000.
 */
const SIZE_LIMIT = 250000;
/**
 * Copies of one function that holds an open loop (`loop` or `while`) and an array of its own. Such a function costs
 * fxc seconds a copy: lightmap's bake held six BVH walks and took 48 to 51 s; two walks take 7.
 */
const WALK_COPIES = 2;

const { modules } = readCorpus();

test('no corpus entry point inlines past the Direct3D compile limits (KB-COMPAT-FXCTIME1)', () => {
  const over = [];
  let entries = 0;
  for (const m of modules) {
    if (m.package === 'voxel-pathtracer') continue;
    const { bodies } = wgslCallGraph(m.code);
    for (const entry of Object.values(m.entryPoints).flat()) {
      entries++;
      const { copies, size } = inlinedCopies(m.code, entry);
      if (size > SIZE_LIMIT)
        over.push(`${m.package} ${m.key} ${entry}: ${size} characters inlined, over ${SIZE_LIMIT}`);
      for (const [name, n] of copies) {
        const body = bodies.get(name).body;
        if (n > WALK_COPIES && /\b(loop|while)\b/.test(body) && /\bvar\s+\w+\s*:\s*array</.test(body))
          over.push(`${m.package} ${m.key} ${entry}: ${n} copies of ${name}, over ${WALK_COPIES}`);
      }
    }
  }
  assert.ok(entries > 1000, `${entries} entry points checked`);
  assert.deepEqual(over, [], 'give each costly function one call site, in a loop whose bound the shader reads');
});

test('the inline walk counts call sites, and loops of constant bound once per trip', () => {
  const code = `
const N = 4u;
fn leaf() -> f32 { return 1.0; }
fn twice() -> f32 { return leaf() + leaf(); }
fn counted() -> f32 { var s = 0.0; for (var i = 0u; i < N; i++) { s += twice(); } return s; }
fn opaque(n: u32) -> f32 { var s = 0.0; for (var i = 0u; i < n; i++) { s += twice(); } return s; }
fn main() { let a = counted() + opaque(3u); }`;
  const { copies } = inlinedCopies(code, 'main');
  assert.equal(copies.get('twice'), 5, 'four unrolled trips and one rolled loop');
  assert.equal(copies.get('leaf'), 10);
  assert.equal(inlinedCopies(code, 'main', { unrollLimit: 2 }).copies.get('twice'), 2, 'past the limit a loop stays');
});

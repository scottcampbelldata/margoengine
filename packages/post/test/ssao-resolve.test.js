import test from 'node:test';
import assert from 'node:assert/strict';
import { SSAO } from '../dist/ssao.js';
import { GTAO } from '../dist/gtao.js';
import { PostStack } from '../dist/stack.js';
import { Tonemap } from '../../tonemap/dist/index.js';
import { harness } from './support.js';

for (const [label, Effect] of [
  ['SSAO', SSAO],
  ['GTAO', GTAO],
])
  for (const stacked of [false, true]) {
    if (Effect === GTAO && !stacked) continue;
    for (const samples of [1, 4])
      test(`${label} ${stacked ? 'stacked' : 'standalone'} ${samples}x resolves only depth before extraction`, () => {
        const h = harness({ samples }),
          effect = new Effect();
        const begin = h.view.begin;
        h.view.begin = () => begin(0); // Same camera and uniforms on both paths.
        h.engine.use(stacked ? new PostStack([effect, new Tonemap()]) : effect);
        h.frame();
        const count = () => h.gpu.record(() => h.frame()),
          optimized = count(),
          extractDepth = effect.extractDepth;
        // Historical path: resolve colour as well as depth before extracting the G-buffer.
        effect.extractDepth = function (c) {
          this.captureTarget.resolve(c.encoder);
        };
        const baseline = count();
        effect.extractDepth = extractDepth;
        const calls = (log, name) => log.filter((e) => e[0] === name),
          removed = samples === 4 ? 1 : 0;
        assert.equal(calls(baseline, 'beginRenderPass').length - calls(optimized, 'beginRenderPass').length, removed);
        // The removed pass has no draws or bindings. All shading work and upload bytes are identical.
        for (const name of [
          'beginComputePass',
          'pass.draw',
          'pass.setBindGroup',
          'pass.dispatchWorkgroups',
          'writeBuffer',
        ])
          assert.deepEqual(calls(optimized, name), calls(baseline, name), name);
        const resolves = (log) =>
          calls(log, 'beginRenderPass').filter((e) => e[1].colorAttachments?.some((a) => a.resolveTarget));
        assert.equal(resolves(optimized).length, resolves(baseline).length - removed);
        assert.equal(resolves(optimized).length, samples === 4 ? 2 : 0, 'ambient/G-buffer then final scene colour');
        h.engine.removePlugin(stacked ? 'post:stack' : effect.name);
      });
  }

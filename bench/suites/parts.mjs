// Parts: the kernel tick for the synthetic 5-level assembly at three sizes (Node), and the assembly drawn at 10,000 and
// 50,000 parts (browser).
import { sceneCases } from '../lib/browser.mjs';
import { headlessEngine, ms, nodeCase, timed } from '../lib/node.mjs';

export default {
  name: 'parts',
  title: 'Parts: assembly kernel tick, assembly drawing',
  uses: 'gpu',
  async cases(ctx) {
    const state = {};
    const assembly = (modules) =>
      nodeCase(
        `kernel-assembly-${modules * 27}`,
        `Kernel tick, parts assembly of ${modules * 27} parts (5 levels)`,
        { tickMs: ms(), tickCullMs: ms(false) },
        () => {
          const e = state[modules];
          return {
            tickMs: timed(() => e.store.tick(false), { reps: 60, warm: 10 }),
            tickCullMs: timed(() => e.store.tick(true), { reps: 60, warm: 10 }),
          };
        },
        {
          async setup() {
            const { buildAssembly } = await import('../../examples/package-benchmarks/parts/assembly.js');
            const e = await headlessEngine(Math.min(100_000, modules * 30 + Math.ceil(modules / 32) + 1));
            buildAssembly(e, modules);
            e.render();
            state[modules] = e;
          },
          async teardown() {
            state[modules]?.dispose();
            delete state[modules];
          },
        },
      );
    return [
      assembly(371),
      assembly(1852),
      assembly(3329),
      ...sceneCases('parts', { primary: ['cpuMs', 'gpuMs'] })(ctx),
    ];
  },
};

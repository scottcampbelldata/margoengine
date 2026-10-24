// CAD: the kernel tick for the synthetic 5-level assembly at three sizes (Node), the B-rep kernel's booleans,
// meshing and STEP round trip (Node, @margoengine/brep), and the assembly drawn at 10,000 and 50,000 parts (browser).
import { sceneCases } from '../lib/browser.mjs';
import { headlessEngine, ms, nodeCase, timed } from '../lib/node.mjs';

const brep = () => import('../../packages/brep/dist/index.js');

/** A 100 x 60 x 20 mm plate with a grid of `holes` drilled through it. */
function drilledPlate({ model }, holes) {
  const { boolean, box, cylinder, frameOf } = model,
    mm = 0.001,
    at = (x, y, z) => frameOf([x * mm, y * mm, z * mm], [0, 0, 1], [1, 0, 0]);
  let body = box('plate', [100 * mm, 60 * mm, 20 * mm], at(0, 0, 0));
  const side = Math.ceil(Math.sqrt(holes));
  for (let i = 0; i < holes; i++)
    body = boolean(
      `h${i}`,
      'subtract',
      body,
      cylinder(`c${i}`, 2 * mm, 30 * mm, at(10 + (80 * (i % side)) / side, 8 + (44 * Math.floor(i / side)) / side, -5)),
    );
  return body;
}

export default {
  name: 'cad',
  title: 'CAD: assembly kernel tick, B-rep booleans and STEP, assembly drawing',
  uses: 'gpu',
  async cases(ctx) {
    const state = {};
    const assembly = (modules) =>
      nodeCase(
        `kernel-assembly-${modules * 27}`,
        `Kernel tick, CAD assembly of ${modules * 27} parts (5 levels)`,
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
            const { buildAssembly } = await import('../../examples/package-benchmarks/cad/assembly.js');
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
      nodeCase(
        'brep-drill-16',
        'B-rep: drill 16 holes through a plate (16 booleans), then mesh it',
        { booleanMs: ms(), meshMs: ms() },
        async () => {
          const kernel = await brep();
          let body;
          const booleanMs = timed(() => (body = drilledPlate(kernel, 16)), { reps: 5, warm: 1 });
          const meshMs = timed(() => kernel.model.meshBodies([body], { deflection: 1e-5, angle: 0.3 }), { reps: 5 });
          return { booleanMs, meshMs };
        },
      ),
      nodeCase(
        'brep-step-roundtrip',
        'B-rep: write the drilled plate as STEP, parse and tessellate it',
        { writeMs: ms(false), parseMs: ms(), tessellateMs: ms(), stepBytes: { unit: 'B', exact: true } },
        async () => {
          const kernel = await brep(),
            body = (state.plate ??= drilledPlate(kernel, 16));
          let text, parsed;
          const writeMs = timed(() => (text = kernel.model.bodiesToSTEP([body])), { reps: 5 });
          const parseMs = timed(() => (parsed = kernel.parseSTEP(text)), { reps: 9 });
          const tessellateMs = timed(() => kernel.tessellateSTEP(parsed), { reps: 5 });
          return { writeMs, parseMs, tessellateMs, stepBytes: Buffer.byteLength(text) };
        },
        { teardown: async () => delete state.plate },
      ),
      ...sceneCases('cad', { primary: ['cpuMs', 'gpuMs'] })(ctx),
    ];
  },
};

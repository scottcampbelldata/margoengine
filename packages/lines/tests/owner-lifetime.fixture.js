import { Picking } from '../../selection/dist/index.js';

// One of each line kind, so every per-line resource (uniforms, points, colours, fill, texture) has an owner.
const strip = (y) => [-0.5, y, 0, 0, y + 0.2, 0, 0.5, y, 0];
// A unit quad as interleaved positions and two triangles.
const quad = { vertices: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], indices: [0, 1, 2, 0, 2, 3] };

export async function fixtures(load = (entry) => import(entry)) {
  const { Lines, Line, GridHelper, AxesHelper } = await load('../dist/index.js');
  const { LineBatches, LineBatch } = await load('../dist/batch.js');
  const { DebugLines, ArcLine } = await load('../dist/debug.js');
  const { EdgesHelper } = await load('../dist/edges.js');
  const { HiddenLine } = await load('../dist/hidden.js');
  const { Stroke } = await load('../dist/stroke.js');
  const { LineTexture, TexturedLine } = await load('../dist/texture.js');
  const { Trail } = await load('../dist/trail.js');
  const { FlowPath } = await load('../dist/flow.js');
  const { LinePicking } = await load('../dist/pick.js');
  const fill = (lines) => {
    const line = lines.add(new Line({ positions: strip(0), width: 3 }));
    lines.add(new HiddenLine(line));
    lines.add(new Stroke({ positions: strip(0.3), width: 4 }));
    const texture = new LineTexture(2, 2, new Uint8Array(16).fill(255));
    lines.add(new TexturedLine({ positions: strip(-0.3), width: 4, texture }));
    lines
      .add(new Trail({ lifetime: 1 }))
      .moveTo(0, 0, 0)
      .moveTo(0.2, 0.1, 0)
      .moveTo(0.4, 0, 0);
    new FlowPath(lines, { positions: strip(0.45) }).seek(1.25);
    lines.add(new EdgesHelper(quad, { stride: 3 }));
    lines.add(new GridHelper({ size: 1, divisions: 2 }));
    lines.add(new AxesHelper({ size: 0.5 }));
    lines.add(new ArcLine([0, 0, 0], [0.5, 0.5, 0]));
    return lines;
  };
  const batch = (plugin) =>
    plugin.add(new LineBatch({ positions: [0, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 0], color: '#fc0' }));
  const entries = [];
  const own = (name, make) =>
    entries.push({
      name,
      create({ engine }) {
        const plugin = make(engine);
        return { plugin, dispose: () => plugin.dispose() };
      },
    });
  own('Lines', () => fill(new Lines()));
  own('Lines.attach', (engine) => fill(Lines.attach(engine)));
  own('LineBatches', () => {
    const plugin = new LineBatches();
    batch(plugin);
    return plugin;
  });
  own('LineBatches.attach', (engine) => {
    const plugin = LineBatches.attach(engine);
    batch(plugin);
    return plugin;
  });
  own('DebugLines', () => new DebugLines().drawLine([0, 0, 0], [1, 1, 0]).drawArc([0, 0, 0], [1, 0, 0]));
  // LinePicking registers with Selection's Picking (a dependency the caller installs) and makes one stand-in mesh per
  // line. In a browser a real pick draws the lines into the pick tile, so its pick buffers and pipelines are made too.
  entries.push({
    name: 'LinePicking',
    create({ engine, scene, dependency }) {
      const picking = new Picking();
      dependency(() => scene.use(picking));
      const plugin = fill(Lines.attach(engine));
      const lines = LinePicking.attach(picking, plugin);
      return {
        plugin,
        dependencies: [picking],
        async check({ phase }) {
          if (phase === 'render' && globalThis.document && engine.backend === 'webgpu') await picking.pick(16, 16);
        },
        dispose: () => {
          lines.dispose();
          plugin.dispose();
        },
        cleanup: () => picking.dispose(),
      };
    },
  });
  return entries;
}

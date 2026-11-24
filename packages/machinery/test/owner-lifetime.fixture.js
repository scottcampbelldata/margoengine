// Owner/lifetime fixture for @margoengine/machinery. The measurement and geometry entries (metrology, clearance, anchors,
// the Rust kernel's pure queries) work on numbers and typed arrays and hold nothing. Every entry that takes something
// from an engine is here, each attached, run for a frame and disposed:
// - Kinematics: joint constraint bits in the transform store, released on dispose.
// - ExplodedView: positions it moved from their setup values.
// - SurfacePhysics and TelemetryChannel: a block of the Rust kernel's Wasm memory each; the channel also listens on a socket.
// - Dimensions: a Lines and a TextRenderer plugin (GPU buffers, text atlas) and its frame pass.
// - FeatureEdges and SectionPlanes: GPU buffers, pipelines and render passes (WebGPU only; the WebGL2 preview refuses them).
// - EngineeringAnnotations: an SVG overlay in the page.
// - AssemblyIndex and AssemblyBVH: engine-side indexes with no plugin of their own, so each is tied to a plugin
//   registration that releases it the way a scene or engine disposal does (ownedByEngine).
// The Wasm kernel's memory is the module's own and is not engine-owned.
import { box } from '../../core/dist/index.js';
import { ownedByEngine } from '../../../tests/support/owner-shell.js';
import { fixtureDocument } from '../../../tests/support/owner-dom.js';

const fillGaps = (Plugin) => {
  for (const hook of ['setup', 'onDeviceRestored']) {
    const original = Plugin.prototype[hook];
    if (!original) continue;
    Plugin.prototype[hook] = function (engine, ...rest) {
      globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
      globalThis.GPUTextureUsage ??= {
        COPY_SRC: 1,
        COPY_DST: 2,
        TEXTURE_BINDING: 4,
        STORAGE_BINDING: 8,
        RENDER_ATTACHMENT: 16,
      };
      if (engine.gpu) {
        engine.gpu.createPipelineLayout ??= () => ({});
        engine.gpu.queue.writeTexture ??= () => {};
        engine.gpu.limits.maxTextureDimension2D ??= 8192;
      }
      return original.call(this, engine, ...rest);
    };
  }
};
// A face that never finishes loading: texts are laid out but not rasterized (the node adapter has no rasterizer).
const face = {
  family: 'Owner',
  weight: 'normal',
  style: 'normal',
  status: 'loading',
  load: () => new Promise(() => {}),
};
// A WebSocket stand-in: an event target the channel listens on.
const socket = () => Object.assign(new EventTarget(), { binaryType: 'blob' });
const frame = (time, entries) => {
  const data = new ArrayBuffer(6 + entries.length * 6),
    view = new DataView(data);
  view.setUint32(0, time, true);
  view.setUint16(4, entries.length, true);
  entries.forEach(([id, value], i) => {
    view.setUint16(6 + i * 6, id, true);
    view.setFloat32(8 + i * 6, value, true);
  });
  return data;
};

export async function fixtures(load = (entry) => import(entry)) {
  const { Kinematics } = await load('../dist/kinematics.js');
  const { ExplodedView } = await load('../dist/exploded.js');
  const { SurfacePhysics } = await load('../dist/surface.js');
  const { TelemetryChannel } = await load('../dist/telemetry.js');
  const { Dimensions } = await load('../dist/dimensions.js');
  const { FeatureEdges } = await load('../dist/edges.js');
  const { SectionPlanes } = await load('../dist/section.js');
  const { EngineeringAnnotations } = await load('../dist/overlays.js');
  const { AssemblyIndex } = await load('../dist/assembly.js');
  const { AssemblyBVH } = await load('../dist/spatial.js');
  const { Font } = await load('../../text/dist/index.js');
  fillGaps(Dimensions);
  const font = new Font({ face });
  const part = (scene) => scene.createMesh().setGeometry(box(1, 1, 1));
  const joint = (node) => ({ node, axis: 'z', min: -1, max: 1 });
  const own = (name, make) => ({
    name,
    async create({ engine, scene, dependency }) {
      const made = await make(engine, scene, dependency);
      return made.plugin ? made : { plugin: made, dispose: () => made.dispose() };
    },
  });
  const document = await fixtureDocument();
  return [
    own('Kinematics.attach', (engine, scene, dependency) => {
      const nodes = dependency(() => [part(scene), part(scene)]);
      const kinematics = Kinematics.attach(engine, nodes.map(joint), { gears: [{ source: 0, target: 1, ratio: 2 }] });
      kinematics.setValue(0, 0.5);
      return {
        plugin: kinematics,
        dispose: () => kinematics.dispose(),
        cleanup: () => nodes.forEach((n) => n.dispose()),
      };
    }),
    own('ExplodedView.attach', (engine, scene, dependency) => {
      const node = dependency(() => part(scene));
      const view = ExplodedView.attach(engine, [{ node, offset: [1, 0, 0] }]);
      view.amount = 0.5;
      return { plugin: view, dispose: () => view.dispose(), cleanup: () => node.dispose() };
    }),
    own('SurfacePhysics.attach', async (engine, scene, dependency) => {
      const [roller, box1] = dependency(() => [part(scene), part(scene)]);
      const physics = await SurfacePhysics.attach(
        engine,
        [{ node: box1, carrier: 0, lane: 0, axis: [1, 0, 0], halfLength: 0.2 }],
        [{ node: roller, velocity: [1, 0, 0] }],
      );
      return {
        plugin: physics,
        dispose: () => physics.dispose(),
        cleanup: () => [roller, box1].forEach((n) => n.dispose()),
      };
    }),
    own('TelemetryChannel.attach', async (engine, scene, dependency) => {
      const node = dependency(() => part(scene));
      const kinematics = Kinematics.attach(engine, [joint(node)]);
      const channel = await TelemetryChannel.attach(engine, kinematics, { delay: 0 });
      const link = socket();
      channel.connect(link);
      channel.push(frame(0, [[0, 0.25]]));
      return {
        plugin: channel,
        dispose: () => {
          channel.dispose();
          kinematics.dispose();
        },
        cleanup: () => node.dispose(),
      };
    }),
    own('Dimensions.attach', (engine, scene, dependency) => {
      const [a, b] = dependency(() => [part(scene), part(scene)]);
      const dimensions = Dimensions.attach(engine, { font });
      dimensions.add({ a: { point: [0, 0, 0], node: a }, b: { point: [1, 0, 0], node: b } });
      dimensions.add({ kind: 'radius', center: { point: [0, 0, 0] }, a: { point: [0, 1, 0] } });
      return {
        plugin: dimensions,
        dispose: () => dimensions.dispose(),
        cleanup: () => [a, b].forEach((n) => n.dispose()),
      };
    }),
    own('FeatureEdges.attach', (engine, scene, dependency) => {
      const node = dependency(() => part(scene));
      const edges = FeatureEdges.attach(engine);
      return { plugin: edges, dispose: () => edges.dispose(), cleanup: () => node.dispose() };
    }),
    own('SectionPlanes.attach', (engine, scene, dependency) => {
      const node = dependency(() => part(scene));
      const section = SectionPlanes.attach(engine, {
        planes: [[1, 0, 0, 0]],
        // Solid caps (stencil and mask textures, three more passes) wherever the device has the format.
        cap: engine.gpu.features?.has?.('depth32float-stencil8') ?? false,
      });
      return { plugin: section, dispose: () => section.dispose(), cleanup: () => node.dispose() };
    }),
    {
      name: 'EngineeringAnnotations.attach',
      create({ engine, scene, dependency }) {
        const node = dependency(() => part(scene));
        const previous = globalThis.document;
        // The page's own document in a browser; jsdom's on the CPU, where the plugin reads the global.
        if (!previous) globalThis.document = document.root.ownerDocument;
        const overlay = EngineeringAnnotations.attach(engine, {
          dimensions: [{ a: { point: [0, 0, 0], node }, b: { point: [1, 0, 0] } }],
          callouts: [{ anchor: { point: [0, 1, 0] }, label: 'bore' }],
        });
        return {
          plugin: overlay,
          dispose: () => overlay.dispose(),
          cleanup() {
            node.dispose();
            if (previous) return;
            delete globalThis.document;
          },
        };
      },
    },
    {
      name: 'AssemblyIndex',
      create({ engine, scene, dependency }) {
        const node = dependency(() => part(scene));
        const index = AssemblyIndex.attach(engine);
        index.tag(node, 'frame');
        return { ...ownedByEngine(scene, 'AssemblyIndex', () => index.dispose()), cleanup: () => node.dispose() };
      },
    },
    {
      name: 'AssemblyBVH',
      async create({ scene, dependency }) {
        const node = dependency(() => part(scene));
        const bvh = await AssemblyBVH.create([node]);
        return { ...ownedByEngine(scene, 'AssemblyBVH', () => bvh.dispose()), cleanup: () => node.dispose() };
      },
    },
  ];
}

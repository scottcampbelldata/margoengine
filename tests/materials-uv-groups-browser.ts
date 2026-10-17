import { Engine } from '../packages/core/dist/extension.js';
import { Material, Texture, createMesh, createInstancedMesh } from '../packages/materials/dist/index.js';
import type { MeshGeometry, MaterialMesh } from '../packages/materials/dist/index.js';
import { Picking } from '../packages/selection/dist/index.js';
import { SSAO } from '../packages/post/dist/index.js';

type AnyMaterialMesh = MaterialMesh<Material | readonly Material[]>;

const canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 3], target: [0, 0, 0] } }),
  errors: string[] = [],
  textures: Texture[] = [],
  models: AnyMaterialMesh[] = [];

// Exactly 80 backing pixels per world unit, independent of perspective and adapter.
engine.camera.project = (out) => {
  out[0] = 0.5;
  out[5] = 2 / 3;
  out[10] = 1 / 99.9;
  out[14] = 100 / 99.9;
  out[15] = 1;
};
engine.onError = (error) => errors.push(String(error));
let observed: GPUDevice | undefined;
function observe() {
  const device = engine.gpu!;
  if (device !== observed) {
    observed = device;
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  }
  return device;
}
observe();

function quad(left = -1.5, right = 1.5, bottom = -1, top = 1): MeshGeometry {
  return {
    positions: [left, bottom, 0, right, bottom, 0, right, top, 0, left, top, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0.25, 0.5, 0.25, 0.5, 0.25, 0.5, 0.25, 0.5],
    uvs1: [0.75, 0.5, 0.75, 0.5, 0.75, 0.5, 0.75, 0.5],
    indices: [0, 1, 2, 0, 2, 3],
  };
}
function split(halfWidth = 1.5, halfHeight = 1): MeshGeometry {
  const left = quad(-halfWidth, 0, -halfHeight, halfHeight),
    right = quad(0, halfWidth, -halfHeight, halfHeight);
  return {
    positions: [...Array.from(left.positions), ...Array.from(right.positions)],
    normals: [...Array.from(left.normals), ...Array.from(right.normals)],
    uvs: [...Array.from(left.uvs!), ...Array.from(right.uvs!)],
    uvs1: [...Array.from(left.uvs1!), ...Array.from(right.uvs1!)],
    indices: [...Array.from(left.indices!), ...Array.from(right.indices!, (i) => i + 4)],
    groups: [
      { start: 0, count: 6, materialIndex: 0 },
      { start: 6, count: 6, materialIndex: 1 },
    ],
  };
}
function texture(data: number[], width = 1) {
  const result = new Texture(
    { data: new Uint8Array(data), width, height: 1 },
    { minFilter: 'nearest', magFilter: 'nearest', mipmaps: false, wrapS: 'clamp', wrapT: 'clamp' },
  );
  textures.push(result);
  return result;
}
const redBlue = texture([255, 0, 0, 255, 0, 0, 255, 255], 2),
  green = texture([0, 255, 0, 255]),
  occlusion = texture([0, 0, 0, 255, 255, 255, 255, 255], 2),
  tiltedNormal = texture([128, 224, 224, 255]),
  orange = texture([255, 128, 0, 255]);
Picking.attach(engine, { capture: false });
function add<T extends AnyMaterialMesh>(model: T): T {
  models.push(model);
  return model;
}
function clear() {
  if (ssao) {
    engine.removePlugin(ssao.name);
    ssao = undefined;
  }
  for (const model of models.splice(0)) model.dispose();
}
async function frame() {
  const device = observe();
  device.pushErrorScope('validation');
  engine.render();
  await device.queue.onSubmittedWorkDone();
  const error = await device.popErrorScope();
  if (error) throw new Error(error.message);
  if (errors.length) throw new Error(errors.join('\n'));
}
let current: AnyMaterialMesh | undefined, selected: Material | undefined, ssao: SSAO | undefined;
const identity = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];

(window as any).uvGroups = {
  engine,
  errors,
  async uv(mode: 'uv0' | 'uv1' | 'fallback' | 'ao0' | 'ao1') {
    clear();
    const geometry = quad(),
      ao = mode.startsWith('ao');
    if (mode === 'fallback') delete geometry.uvs1;
    selected = new Material(ao ? { aoMap: occlusion, roughness: 1 } : { shading: 'basic', map: redBlue });
    selected.setUVTransform({ texCoord: mode === 'uv0' || mode === 'ao0' ? 0 : 1 }, ao ? 'aoMap' : 'map');
    engine.lighting.direction[3] = 0;
    engine.lighting.radiance[3] = 1;
    current = add(createMesh(engine, geometry, selected));
    await frame();
  },
  async grouped() {
    clear();
    const geometry = split();
    geometry.groups = [
      { start: 0, count: 6, materialIndex: 1 },
      { start: 6, count: 6, materialIndex: 0 },
    ];
    current = add(
      createMesh(engine, geometry, [
        new Material({ shading: 'normal' }),
        new Material({ shading: 'basic', map: green }),
      ]),
    );
    await frame();
    return {
      primitives: current.primitives.length,
      materials: Array.isArray(current.material) ? current.material.length : 1,
    };
  },
  async picks() {
    if (!current) throw new Error('No current model');
    const hits = [await engine.pick(80, 120), await engine.pick(240, 120)];
    return {
      hits: hits.map((hit) => hit === current!.primitives[0].node),
      sharedNode: current.primitives.every((primitive) => primitive.node === current!.primitives[0].node),
    };
  },
  async move() {
    current!.root.setPosition([0.5, 0, 0]);
    await frame();
  },
  async restore() {
    const previous = engine.gpu;
    await engine.rebootDevice();
    await frame();
    return { changedDevice: previous !== engine.gpu, primitives: current!.primitives.length };
  },
  async blending() {
    clear();
    // A grouped opaque primitive must not pull its BLEND sibling ahead of unrelated opaque draws.
    // Correct composition on the right: green background, far blue, near red (both at alpha .5).
    current = add(
      createMesh(engine, split(), [
        new Material({ shading: 'basic', color: [1, 1, 1] }),
        new Material({ shading: 'basic', color: [0, 0, 1], transparent: true, opacity: 0.5 }),
      ]),
    );
    add(createMesh(engine, quad(), new Material({ shading: 'basic', color: [0, 1, 0] }))).root.setPosition([
      0, 0, -0.4,
    ]);
    add(
      createMesh(
        engine,
        quad(0, 1.5),
        new Material({ shading: 'basic', color: [1, 0, 0], transparent: true, opacity: 0.5 }),
      ),
    ).root.setPosition([0, 0, 0.4]);
    await frame();
  },
  async instances(count = 2) {
    clear();
    const mapped = new Material({ shading: 'basic', map: redBlue });
    mapped.setUVTransform({ texCoord: 1 }, 'map');
    const model = add(
      createInstancedMesh(engine, split(0.5, 0.4), [new Material({ shading: 'basic', map: green }), mapped], 2),
    );
    model.instances.setMatrixAt(0, identity(-1));
    model.instances.setMatrixAt(1, identity(1));
    model.instances.count = count;
    current = model;
    await frame();
    return {
      sharedInstances: model.primitives.every((p) => p.instances === model.instances),
      primitives: model.primitives.length,
    };
  },
  async matcap(withSSAO: boolean) {
    clear();
    current = add(
      createMesh(engine, split(), [
        new Material({ shading: 'matcap', matcap: orange }),
        new Material({ shading: 'basic', map: green }),
      ]),
    );
    if (withSSAO) {
      ssao = SSAO.attach(engine, { radius: 0.2, samples: 8 });
      ssao.add(current);
    }
    await frame();
  },
  async normal(mode: 'zero' | 'uv0' | 'uv1') {
    clear();
    const geometry = quad();
    geometry.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
    geometry.uvs1 = [0, 1, 1, 1, 1, 0, 0, 0];
    geometry.tangents = [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1];
    const material = new Material({ shading: 'normal', normalMap: tiltedNormal, normalScale: mode === 'zero' ? 0 : 1 });
    material.setUVTransform({ texCoord: mode === 'uv1' ? 1 : 0 }, 'normalMap');
    current = add(createMesh(engine, geometry, material));
    await frame();
  },
  async disposal() {
    clear();
    await frame();
    const pickedAfterDispose = await engine.pick(80, 120);
    // Textures are caller-owned and must remain usable after grouped models release their resources.
    current = add(createMesh(engine, quad(), new Material({ shading: 'basic', map: green })));
    await frame();
    return { pickedAfterDispose: pickedAfterDispose === null };
  },
  dispose() {
    clear();
    for (const texture of textures) texture.dispose();
    engine.dispose();
  },
};

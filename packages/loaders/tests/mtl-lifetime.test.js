import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { headless } from '../../../tests/support/pbr-snapshot.js';

// KB-OWN-LOAD1: loadOBJ makes the MTL materials, their textures and (without `fallback`) a fallback material for its
// mesh. A scene that removed the mesh (removePlugin, scene or engine disposal) left all of them alive until the
// handle's own dispose(). The stand-in createMesh acts as materials' does: the mesh is a model plugin in the active
// scene, disposed when its scene removes it, with onDispose for what goes with it. Run with --experimental-test-module-mocks.
const made = [];
class Material {
  disposed = 0;
  constructor() {
    made.push(this);
  }
  dispose() {
    this.disposed++;
  }
}
class Texture {
  disposed = 0;
  dispose() {
    this.disposed++;
  }
}
let count = 0;
mock.module('@margoengine/materials', {
  namedExports: {
    CubeTexture: class CubeTexture {
      dispose() {}
    },
    Material,
    Texture,
    loadTexture: async () => {
      throw new Error('pass loadTexture');
    },
    createMesh(engine) {
      const callbacks = new Set(),
        node = engine.createMesh(),
        model = {
          name: `obj-model-${++count}`,
          node,
          setup() {},
          onDispose(callback) {
            callbacks.add(callback);
            return () => callbacks.delete(callback);
          },
          dispose() {
            for (const callback of [...callbacks]) {
              callbacks.delete(callback);
              callback();
            }
            node.dispose();
          },
          destroy() {
            const scene = engine.sceneOf(model);
            if (scene) scene.removePlugin(model.name);
            else model.dispose();
          },
        };
      engine.use(model);
      return model;
    },
  },
});
const { loadOBJ } = await import('../dist/mtl.js');
const files = {
  '/models/quad.obj':
    'mtllib quad.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl Painted\nf 1/1 2/2 3/3\n',
  '/models/quad.mtl': 'newmtl Painted\nKd 0.8 0.6 0.4\nmap_Kd paint.png\n',
};
const fetch = async (input) => new Response(files[new URL(String(input)).pathname]);
const textures = [];
const loadTexture = async () => {
  const texture = new Texture();
  textures.push(texture);
  return texture;
};

for (const [how, remove] of [
  ['removePlugin', (engine, loaded) => engine.sceneOf(loaded.mesh).removePlugin(loaded.mesh.name)],
  ['scene disposal', (engine, loaded) => engine.sceneOf(loaded.mesh).dispose()],
]) {
  test(`loadOBJ releases its materials and textures when its scene removes the mesh (${how})`, async () => {
    const engine = await headless();
    made.length = textures.length = 0;
    try {
      const scene = engine.createScene('b');
      let started;
      scene.use({
        name: 'loader',
        setup: () => (started = loadOBJ(engine, 'https://assets.example/models/quad.obj', { fetch, loadTexture })),
      });
      scene.removePlugin('loader');
      const loaded = await started;
      assert.equal(made.length, 2, 'one MTL material and the fallback');
      assert.equal(textures.length, 1);
      remove(engine, loaded);
      assert.deepEqual(
        made.map((m) => m.disposed),
        [1, 1],
        'the materials loadOBJ made are disposed',
      );
      assert.deepEqual(
        textures.map((t) => t.disposed),
        [1],
        'the texture loadOBJ loaded is disposed',
      );
      loaded.dispose();
      assert.deepEqual(
        made.map((m) => m.disposed),
        [1, 1],
        'a later dispose() releases nothing twice',
      );
      assert.deepEqual(
        textures.map((t) => t.disposed),
        [1],
      );
    } finally {
      engine.dispose();
    }
  });
}

test('loadOBJ leaves a fallback material the app passed alone', async () => {
  const engine = await headless();
  made.length = textures.length = 0;
  try {
    const fallback = new Material(),
      loaded = await loadOBJ(engine, 'https://assets.example/models/quad.obj', { fetch, loadTexture, fallback });
    engine.removePlugin(loaded.mesh.name);
    assert.equal(fallback.disposed, 0);
    loaded.dispose();
    assert.equal(fallback.disposed, 0);
  } finally {
    engine.dispose();
  }
});

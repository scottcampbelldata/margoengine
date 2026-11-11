// Pay only for what you import: `Material` (@margoengine/materials) and `Animation` (@margoengine/animation) name
// gltf-pro's model module, but an app that imports only one of them must not bundle the glTF model class or its file
// reading (the accessor reader and the meshopt decoder). A mesh drawn with a Material does bundle them: gltf-pro's
// PBRModel is the renderer that draws it, so the third case checks the markers find that code when it is there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';

// A message only PBRModel's constructor holds, and one only GLTFAsset's accessor reader holds.
const MODEL = 'give each node one parent and valid child indices';
const ASSET = /gltf-pro\/dist\/asset-[\w-]+\.js$|decoders\/dist\/meshopt\.js$/;

async function bundled(code) {
  const out = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: { write: false, target: 'es2022', minify: true, rollupOptions: { input: 'app' } },
    plugins: [{ name: 'app', resolveId: (id) => (id === 'app' ? id : null), load: (id) => (id === 'app' ? code : null) }],
  });
  const chunks = out.output.filter((file) => file.type === 'chunk' && file.isEntry);
  return {
    code: chunks.map((chunk) => chunk.code).join('\n'),
    modules: chunks.flatMap((chunk) => Object.keys(chunk.modules).map((id) => id.replaceAll('\\', '/'))),
  };
}

for (const [name, code] of [
  ['materials', "import { Material } from '@margoengine/materials'; console.log(Material);"],
  ['animation', "import { Animation } from '@margoengine/animation'; console.log(Animation);"],
])
  test(`a build that imports only ${name} holds no glTF model class or file reader`, { timeout: 120000 }, async () => {
    const app = await bundled(code);
    assert.ok(!app.code.includes(MODEL), 'PBRModel was bundled');
    assert.deepEqual(app.modules.filter((id) => ASSET.test(id)), []);
  });

test('a mesh drawn with a Material bundles the PBR renderer, so the markers above are live', { timeout: 120000 }, async () => {
  const app = await bundled(
    "import { Material, createMesh } from '@margoengine/materials'; console.log(Material, createMesh);",
  );
  assert.ok(app.code.includes(MODEL), 'PBRModel is in the build');
  assert.ok(app.modules.some((id) => ASSET.test(id)), 'the accessor reader is in the build');
});

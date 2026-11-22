// Pay only for what you import: shadow casters cut by materials alphaHash()'s noise (shared/alpha-hash.js hashedDepth),
// but the material hands that caster edit to the shadow passes through its record's castHashed. An app with shadow maps,
// local and contact shadows and materials, and no alphaHash, must not bundle the hash WGSL or the caster edit; the
// second case imports alphaHash and checks the markers find that code when it is there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';

// The hash function's WGSL name, and a message only the hashed caster edit holds.
const HASH = 'fn margoAlphaHash(',
  EDIT = 'Hashed shadow casters need a depth shader with an alpha cut-out';

async function bundled(code) {
  const out = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: { write: false, target: 'es2022', minify: true, rollupOptions: { input: 'app' } },
    plugins: [
      { name: 'app', resolveId: (id) => (id === 'app' ? id : null), load: (id) => (id === 'app' ? code : null) },
    ],
  });
  // Every chunk counts, lazy ones included: the cost is what the app downloads at all.
  return out.output
    .filter((file) => file.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n');
}

const shadows = `import { Shadows } from '@margoengine/shadows';
import { VirtualShadows } from '@margoengine/shadows/virtual';
import { Clustered } from '@margoengine/clustered';
import { LocalShadows } from '@margoengine/clustered/shadows';
import { ContactShadows } from '@margoengine/studio';
import { PbrMaterial, createMesh } from '@margoengine/materials';
console.log(Shadows, VirtualShadows, Clustered, LocalShadows, ContactShadows, PbrMaterial, createMesh);`;

test('shadows, local and contact shadows and materials without alphaHash bundle no alpha hash', {
  timeout: 180000,
}, async () => {
  const code = await bundled(shadows);
  assert.ok(!code.includes(HASH), 'the alpha hash WGSL was bundled');
  assert.ok(!code.includes(EDIT), 'the hashed caster edit was bundled');
});

test('importing alphaHash bundles the hash and its caster edit, so the markers above are live', {
  timeout: 180000,
}, async () => {
  const code = await bundled(
    `${shadows}\nimport { alphaHash } from '@margoengine/materials/alpha-hash';\nconsole.log(alphaHash);`,
  );
  assert.ok(code.includes(HASH), 'the alpha hash WGSL is in the build');
  assert.ok(code.includes(EDIT), 'the hashed caster edit is in the build');
});

// Test-only renderer reference. Keep it outside the workspace dependency graph and
// bundle the cached sources so benchmark payloads still use our local gzip server.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const THREE_REFERENCE_VERSION = '0.186.1';
export const THREE_REFERENCE_CDN = `https://cdn.jsdelivr.net/npm/three@${THREE_REFERENCE_VERSION}`;
const repository = fileURLToPath(new URL('..', import.meta.url));
const cachePath = `test-results/three-reference/${THREE_REFERENCE_VERSION}`;
const files = {
  'build/three.module.js': '9052042d676cb0fdc1ddfefe193053f34b7ac0513a616fdac4535d49987812ea',
  'build/three.core.js': '9edde002b066a9a05676a6127f67735b62baf399bdea529f2f7e31657da769e6',
  'examples/jsm/postprocessing/EffectComposer.js': '4e079a5886152d7e529a59aef644e968ab4d32c6a33ce016b36bf29b2eac26f7',
  'examples/jsm/postprocessing/RenderPass.js': '817f6c3cdcd0fd41515d112359ea0532568eefb5aabd3b33903957ebca1b8a6a',
  'examples/jsm/postprocessing/OutputPass.js': '02e4a261af34de71338185e9e87f0cbe5cba9115608d984363e1269dec1d2272',
  'examples/jsm/postprocessing/ShaderPass.js': 'e2500a5913b26bbf5148ceaae644c6edcff06a18b01494ee37bf856353d2ab9d',
  'examples/jsm/postprocessing/MaskPass.js': '7cd08eee9d5d6f5578beaddbdcbe9c384f6873810af27f22ab7db3ceeb127aa3',
  'examples/jsm/postprocessing/Pass.js': '444b409c235ead986893c472e720da1b779a56985c7d10b279c7944b52bd61c5',
  'examples/jsm/shaders/CopyShader.js': 'a33057d5ac91c43304c186ac0e8816e62bb2ed471d3a00ff3018dfd5c0389718',
  'examples/jsm/shaders/OutputShader.js': '353479f77a8d7e2629d49ccac9fc2f5dbfdda5442e0adf867b00377a2fcb0cb2',
  LICENSE: '8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc',
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function prepareThreeReference() {
  const root = resolve(repository, cachePath);
  await Promise.all(
    Object.entries(files).map(async ([path, expected]) => {
      const destination = resolve(root, path);
      let bytes;
      try {
        bytes = await readFile(destination);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (bytes && digest(bytes) === expected) return;
      const response = await fetch(`${THREE_REFERENCE_CDN}/${path}`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Three.js reference download failed: ${path} (${response.status})`);
      bytes = new Uint8Array(await response.arrayBuffer());
      if (digest(bytes) !== expected) throw new Error(`Three.js reference integrity mismatch: ${path}`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }),
  );
  return {
    moduleUrl: `/${cachePath}/build/three.module.js`,
    aliases: [
      { find: THREE_REFERENCE_CDN, replacement: root },
      { find: 'three', replacement: resolve(root, 'build/three.module.js') },
    ],
  };
}

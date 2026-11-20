import type { FBXExtension } from './extension.js';
import { importLimits, type FBXImportLimits } from './limits.js';
export type { FBXImportLimits } from './limits.js';
const MiB = 1024 * 1024;
/**
 * Large-file caps: 512 MiB input, 2 GiB decoded/scene, 512 MiB arrays/morphs/output/texture files, 8 million vertices,
 * 24 million corners, 1 million nodes, 16 million properties, 2 billion parse/scene steps, 320 million geometry steps
 * and 268,435,456 decoded texture pixels (1 GiB of RGBA8, half the decoded cap: sixteen 4096 x 4096 maps; a Character
 * Creator man with his 1024 to 4096 maps decodes about 61 million). Every field may be overridden.
 */
export function largeFBX(limits: Partial<FBXImportLimits> = {}): FBXExtension {
  const caps = importLimits([
    {
      limits: {
        inputBytes: 512 * MiB,
        decodedBytes: 2048 * MiB,
        arrayBytes: 512 * MiB,
        nodes: 1_000_000,
        properties: 16_000_000,
        parseWork: 2_000_000_000,
        sceneBytes: 2048 * MiB,
        sceneWork: 2_000_000_000,
        morphBytes: 512 * MiB,
        vertices: 8_000_000,
        corners: 24_000_000,
        geometryWork: 320_000_000,
        outputBytes: 512 * MiB,
        textureBytes: 512 * MiB,
        texturePixels: 268_435_456,
        ...limits,
      },
    },
  ]);
  return Object.freeze({ name: 'large', limits: Object.freeze(caps) });
}

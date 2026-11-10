// Worker script for @margoengine/fbx/worker (bundled to dist/workers/fbx.js): fetch, FBX -> GLB, then gltf-pro's
// prepare step (JSON, accessors, packed vertices, decoded textures), all off the main thread.
import { defaultLimits, type FBXImportLimits } from './limits.js';
import { prepareGLTF } from '@margoengine/gltf-pro/prepare';
import { readResponse } from '../../shared/loading.js';
import { serve } from '../../shared/worker.js';
import { convertFBX } from './index.js';
import type { FBXExtension } from './extension.js';
import { animationLayers } from './layers.js';
import { nurbsCurves } from './curves.js';
import { deformers } from './deformers.js';
import { pbrMaterials } from './pbr.js';
import { legacyFBX } from './legacy.js';
import { textures } from './textures.js';
import { sceneExtras } from './scene-extras.js';

// Functions cannot cross to a worker, so the page sends names and the worker holds every entry.
const known: readonly FBXExtension[] = [
  legacyFBX,
  sceneExtras,
  animationLayers,
  pbrMaterials,
  nurbsCurves,
  deformers,
  textures,
];
type FBXJob = {
  url?: string;
  input?: ArrayBuffer;
  resourcePath?: string;
  allowedURLs?: readonly string[];
  extensions?: readonly string[];
  layers?: boolean;
  limits?: Readonly<FBXImportLimits>;
};
serve(async ({ url, input, resourcePath, allowedURLs, extensions, layers, limits = defaultLimits }: FBXJob) => {
  if (url) {
    const response = await fetch(url);
    input = (await readResponse(response, { maxBytes: limits.inputBytes, label: 'FBX' })).buffer;
    resourcePath ??= new URL('.', response.url || url).href;
  }
  const prepared = await prepareGLTF(
    undefined,
    await convertFBX(input!, {
      resourcePath,
      allowedURLs,
      extensions: [...known.filter((extension) => extensions?.includes(extension.name)), { name: 'large', limits }],
      layers,
    }),
    undefined,
    limits === defaultLimits ? undefined : limits.outputBytes,
    limits.nodes,
  );
  // parseFBX's texture budget (all textures together), checked after decoding as it does.
  if (
    prepared.images.reduce((sum, image) => sum + (image ? image.width * image.height : 0), 0) > limits.texturePixels
  ) {
    for (const image of prepared.images) if (image && 'close' in image) image.close();
    throw new RangeError(
      'FBX texture pixel budget exceeded; simplify or split the scene, the import limits are listed in the README',
    );
  }
  return prepared;
});

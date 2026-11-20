// Owner/lifetime fixture for @margoengine/usdz: what an app attaches to an engine from a USD file. A model from
// `USDAsset.create`, the same with the `/preview-surface` extension (which adds a plugin holding GPU resources for
// USD opacity and primvars), and a `ValueClipPlayer` that owns the model of its current cache frame and listens to the
// request's signal. The stages are inline so the browser leaves read no files.
import { ownedByEngine } from '../../../tests/support/owner-shell.js';

const triangle = `#usda 1.0
(
    metersPerUnit = 1
    upAxis = "Y"
)
def Mesh "Tri" (
    prepend apiSchemas = ["MaterialBindingAPI"]
)
{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(-1, -1, 0), (1, -1, 0), (0, 1, 0)]
    uniform token subdivisionScheme = "none"
    rel material:binding = </Mat>
}
def Material "Mat"
{
    token outputs:surface.connect = </Mat/Surface.outputs:surface>
    def Shader "Surface"
    {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor = (0.8, 0.2, 0.2)
        float inputs:opacity = 0.5
        token outputs:surface
    }
}
`;
// A cache whose topology changes between frames (the clip fixture `topology.usda`, inline).
const clipLayers = {
  'cache.usda': `#usda 1.0
(metersPerUnit=1
upAxis="Y")
def Mesh "Cache" (clips={dictionary default={asset[] assetPaths=[@a.usda@,@b.usda@]
asset manifestAssetPath=@manifest.usda@
string primPath="/Geometry"
double2[] active=[(0,0),(1,1)]
}
}) {int[] faceVertexCounts
int[] faceVertexIndices
point3f[] points
}
`,
  'a.usda': `#usda 1.0
over "Geometry" {int[] faceVertexCounts.timeSamples={0:[3]
}
int[] faceVertexIndices.timeSamples={0:[0,1,2]
}
point3f[] points.timeSamples={0:[(-1,-1,0),(1,-1,0),(0,1,0)]
}
}
`,
  'b.usda': `#usda 1.0
over "Geometry" {int[] faceVertexCounts.timeSamples={1:[4]
}
int[] faceVertexIndices.timeSamples={1:[0,1,2,3]
}
point3f[] points.timeSamples={1:[(-1,-1,0),(1,-1,0),(1,1,0),(-1,1,0)]
}
}
`,
  'manifest.usda': `#usda 1.0
over "Geometry" {int[] faceVertexCounts
int[] faceVertexIndices
point3f[] points
}
`,
};
const encoder = new TextEncoder();
const readClip = (id) => (id in clipLayers ? encoder.encode(clipLayers[id]) : undefined);
// Clip work runs in the first render check, as an app steps a cache from its own frame loop.
const once = (work) => {
  let done = false;
  return async ({ phase }) => {
    if (phase === 'render' && !done) {
      done = true;
      await work();
    }
  };
};

export async function fixtures(load = (entry) => import(entry)) {
  const { parseUSDA } = await load('../dist/index.js');
  const { previewSurface } = await load('../dist/preview-surface.js');
  const { ValueClipPlayer } = await load('../dist/clips.js');
  const model = (name, options) => ({
    name,
    async create({ engine }) {
      const plugin = await parseUSDA(triangle, options).create(engine);
      return { plugin, dispose: () => plugin.dispose() };
    },
  });
  return [
    model('USDAsset.create', {}),
    model('USDAsset.create.previewSurface', { extensions: [previewSurface()] }),
    {
      name: 'ValueClipPlayer',
      create({ engine, scene }) {
        // The signal is the app's own and outlives the player: its abort listener must go with each request.
        const controller = new AbortController(),
          player = ValueClipPlayer.attach(engine, 'cache.usda', readClip, { signal: controller.signal });
        return ownedByEngine(scene, 'ValueClipPlayer', () => player.dispose(), {
          check: once(async () => {
            await player.setTimeCode(0);
            await player.setTimeCode(1);
          }),
        });
      },
    },
  ];
}

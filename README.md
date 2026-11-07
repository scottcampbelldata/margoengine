# Margo Engine

A small WebGPU engine for the web, with a Rust/Wasm core.

[![CI](https://github.com/scottcampbelldata/margoengine/actions/workflows/ci.yml/badge.svg)](https://github.com/scottcampbelldata/margoengine/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/margoengine.svg)](https://www.npmjs.com/package/margoengine)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

![A textured crate and a ball with shadows on a checkered floor, rendered by Margo Engine](docs/images/quickstart.webp)

**[Quickstart: a textured, lit scene with shadows and picking in five minutes](#quickstart)** ·
[Start here: guides by goal](docs/start-here.md) · [Live demos](https://margoengine.com) ·
[Coming from three.js](docs/from-threejs.md)

The core and the stage together are 23,013 bytes gzip, Wasm kernel and WebGPU backend included. Everything else
(glTF, shadows, physics, post effects) is a separate package you import only if you use it.

## Install

Margo needs WebGPU (see [Browser support](#browser-support)). End users: Node 22.12 or newer (tested on 22.12 and the
latest 22.x, 24.18 and 26). Contributors: Node 24.18 or newer.

**The packages are not on npm yet.** `npm install margoengine` gets only a name placeholder (0.0.1, no engine) today;
1.0.0 is the first planned release.
Two routes work now. Both start from a clone. The quickstart does not need the [Git LFS](https://git-lfs.com) test
assets (about 270 MB), so skip them: if Git LFS is installed, set `GIT_LFS_SKIP_SMUDGE=1` for the clone (in PowerShell,
`$env:GIT_LFS_SKIP_SMUDGE=1`). You need the assets only to run the tests, see [Build from source](#build-from-source).

```sh
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/scottcampbelldata/margoengine.git
cd margoengine
npm ci
```

**Route 1: run the quickstart inside the clone.** Nothing to install in a project of your own.

```sh
npm run build:packages
npm run dev:examples
```

Open <http://127.0.0.1:5173/examples/quickstart/>. That page is the quickstart below, saved as
[examples/quickstart/](examples/quickstart).

**Route 2: use the packages in your own project from local tarballs.** `npm run pack:packages` builds every package and
writes one `.tgz` file each to `test-results/`. Install them all, plus Vite, in a new folder (shown for a shell that
expands `*.tgz`, such as Git Bash, macOS or Linux; in PowerShell list the files or use `Get-ChildItem`):

```sh
npm run pack:packages
mkdir ../my-scene && cd ../my-scene
npm init -y
npm install ../margoengine/test-results/*.tgz vite
```

On the machine used to write this page, `npm ci` took 15 seconds, packing 35 and the install 8; from the first command
to a rendered, verified page took 76 seconds (`npm run check:quickstart` repeats the whole run and fails above 300).
Then follow the Quickstart steps 2 to 4 below in `my-scene`.

**After 1.0.0 is published,** `npm install margoengine vite` in a new folder replaces Route 2 and nothing else changes.

## Quickstart

You will build a floor, a crate and a ball with a texture, sun light, soft shadows, orbit controls and click-to-select.
It takes four steps in a new folder (or skip them and use the page from the clone above).

1. Install the packages as in Route 2 above (or use Route 1 and skip to step 4).
2. Save this as `index.html`:

```html index.html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="data:," />
    <title>Margo Engine quickstart</title>
    <style>
      body { margin: 0; font: 16px system-ui, sans-serif }
      #scene { height: 100vh }
      #status { position: fixed; top: 8px; left: 12px; margin: 0; padding: 4px 8px; background: #fffa; border-radius: 4px }
    </style>
  </head>
  <body>
    <div id="scene"></div>
    <p id="status">Drag to orbit, scroll to zoom.</p>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

3. Save this as `main.ts`:

```ts main.ts
import { createStage } from 'margoengine';
import { boxGeometry, planeGeometry, sphereGeometry } from 'margoengine/geometry';
import { PbrMaterial, Texture, createMesh } from 'margoengine/materials';
import { Picking, Selection } from 'margoengine/selection';
import { Shadows } from 'margoengine/shadows';

const status = document.querySelector('#status')!;
if (!('gpu' in navigator)) {
  status.textContent = 'This browser has no WebGPU, which this scene needs. See "Browser support" in the README.';
  throw new Error('WebGPU unavailable');
}

// A 64 x 64 checkerboard painted in code, so the example needs no image file.
const pixels = new Uint8Array(64 * 64 * 4);
for (let y = 0; y < 64; y++)
  for (let x = 0; x < 64; x++) {
    const light = ((x >> 3) + (y >> 3)) % 2 === 0;
    pixels.set(light ? [235, 235, 225, 255] : [70, 90, 110, 255], (y * 64 + x) * 4);
  }
const checker = new Texture({ data: pixels, width: 64, height: 64 }, { wrapS: 'repeat', wrapT: 'repeat' });

// The stage mounts a canvas in #scene, adds orbit/pan/zoom with the mouse and starts the render loop.
const stage = await createStage('#scene', { camera: { position: [4, 3, 6], target: [0, 0.6, 0] } }).catch((error: Error) => {
  status.textContent = `Margo could not start: ${error.message}. See "Browser support" in the README.`;
  throw error;
});
const engine = stage.engine;

// Aim the sun from the left and above, so the shadows fall to the right, where the camera can see them.
engine.scene.lighting.direction.set([-4, 4, 2, 3]); // x, y, z point toward the light; the last number is its strength

// Three lit, textured meshes.
const floor = new PbrMaterial({ map: checker });
floor.setUVTransform({ scale: [6, 6] }); // repeat the texture 6 times across the floor
const ground = createMesh(engine, planeGeometry(12, 12), floor);
ground.root.setRotation([-Math.PI / 2, 0, 0]); // planes face +z; lay it flat
const crate = createMesh(engine, boxGeometry(1, 1, 1), new PbrMaterial({ map: checker, roughness: 0.6 }));
crate.root.setPosition([-1, 0.5, 0]);
const ball = createMesh(engine, sphereGeometry(0.6, 48, 24), new PbrMaterial({ color: '#84d6bd', roughness: 0.25 }));
ball.root.setPosition([1, 0.6, 0]);

// Shadows: tell the shadow package which meshes cast and receive.
const shadows = Shadows.attach(engine, { resolution: 2048 });
for (const mesh of [ground, crate, ball]) shadows.add(mesh);

// Click a mesh to outline it; click empty space to clear.
const picking = Picking.attach(engine);
const outline = Selection.attach(engine, { color: [1, 0.6, 0] });
const names = new Map<unknown, string>([
  [crate, 'crate'],
  [ball, 'ball'],
]);
let pressed = [0, 0];
let busy = false; // one pick can wait at a time
engine.canvas.addEventListener('pointerdown', (event) => {
  pressed = [event.clientX, event.clientY];
});
engine.canvas.addEventListener('click', async (event) => {
  const moved = Math.hypot(event.clientX - pressed[0], event.clientY - pressed[1]);
  if (busy || moved > 4) return; // ignore the end of an orbit drag
  busy = true;
  const hit = await picking.pick(event.offsetX, event.offsetY);
  busy = false;
  const name = hit?.model ? names.get(hit.model) : undefined;
  outline.set(name && hit ? [hit.mesh] : []);
  status.textContent = name ? `Picked the ${name}.` : 'Click the crate or the ball.';
});

stage.onTick((delta) => {
  crate.root.rotation.y += delta * 0.5;
});
window.addEventListener('pagehide', () => stage.dispose(), { once: true });
```

4. Run `npx vite` and open the address it prints. Drag to orbit, scroll to zoom, right-drag to pan, click the crate.

If the page is blank or shows an error:

- Vite says `Failed to resolve import "margoengine"`: step 1 did not run in this folder. Run the `npm install` line from
  Route 2 again in the folder that holds `index.html` (and use `npx vite` there, not in the clone).
- The status line says `This browser has no WebGPU` or `Margo could not start`: use desktop Chrome or Edge, or see
  [Browser support](#browser-support).

The scene is about 60 lines. Three things to know about it:

- `createStage` mounts the canvas in `#scene`, adds mouse and touch camera controls and starts the render loop.
- `createMesh` (from `margoengine/materials`) draws a geometry with a `PbrMaterial`. That is how a mesh gets a
  texture. `stage.box()` and `stage.sphere()` make plain-colour meshes with no texture.
- Shadows, picking and outlines are separate packages. You import them when you want them and pay nothing when you do not.

**WebGPU and the fallback.** This scene needs WebGPU. Chrome and Edge on desktop are the browsers the engine is tested
in. Without WebGPU the page shows a message and stops. The site's demos run on WebGL2 without WebGPU through the optional
[`@margoengine/webgl2-compat`](packages/webgl2-compat/README.md) layer. The small [`@margoengine/webgl`](packages/webgl/README.md)
preview renders plain meshes with flat shading on WebGL2, with no textures, shadows or effects, so it cannot run this
quickstart. Details are under [Browser support](#browser-support).

Next: [Start here](docs/start-here.md) lists a guide for each goal: [textures and materials](docs/guides/textures-and-materials.md),
[lights and shadows](docs/guides/lights-and-shadows.md), [camera and controls](docs/guides/camera-and-controls.md),
[interaction](docs/guides/interaction.md), [loading glTF](docs/guides/loading-gltf.md) and
[animation](docs/guides/animation.md).

## Demos

| | | |
| --- | --- | --- |
| ![Night Citadel](site/images/night-citadel.jpg) | ![Flight Helmet](site/images/flight-helmet.jpg) | ![Gameplay sandbox](site/images/gameplay-sandbox.jpg) |
| [Night Citadel](apps/showcase-night-citadel/README.md) | [glTF PBR](examples/flight-helmet.html) | [Gameplay sandbox](examples/gameplay-sandbox/README.md) |

![Tokyo corner diorama rendered by Margo Engine](site/images/tokyo-diorama.jpg)

## Build from source

You need Node.js 24.18+ (the repository's tests need it; the packages you build run on Node 22.12+) and
[Git LFS](https://git-lfs.com) for the test assets.

```sh
git clone https://github.com/scottcampbelldata/margoengine.git
cd margoengine
git lfs install
git lfs pull
npm ci
npm test
```

`npm test` builds every package from the checked-in Wasm and runs the unit tests. You don't need Rust unless you
change the kernel.

```sh
npm run dev               # Night Citadel showcase
npm run dev:examples      # every page in examples/, e.g. /examples/flight-helmet.html
npm run lint              # Biome
npm run typecheck         # strict TypeScript for all packages
npm run test:all          # every Node test in the repo
npm run test:kernel       # Rust kernel tests (toolchain pinned in rust-toolchain.toml)
npm run measure:size      # core + stage size check
```

## Features

- WebGPU renderer with PBR, image-based lighting, cascaded shadows, clustered lights, SSAO, bloom, TAA and depth of
  field. Each one is its own package.
- Rust/Wasm transform kernel with GPU culling and instancing.
- Loaders for glTF/GLB (Draco, Meshopt, KTX2), FBX, USDZ, OBJ, STL, PLY, 3MF, COLLADA and more.
- Camera controls with CAD-style mouse presets, a view cube, GPU picking and selection outlines.
- Skinning, morph targets, blend trees and IK.
- Physics on Rapier, navmesh, ECS, input and audio.
- Terrain, water, sky, procedural scenery, voxels and a progressive voxel path tracer.
- React 18 and 19 components (`@margoengine/react`).
- Optional WebGL2 fallback: the compatibility layer runs the site's demos, the small preview draws basic scenes.

More examples are in [examples/](examples/README.md).

## Browser support

Margo Engine needs WebGPU. Without it, the optional `@margoengine/webgl2-compat` layer runs the WebGPU code of core and the
packages on WebGL2 (every site demo loads it; [docs/webgl2-compat-demos.md](docs/webgl2-compat-demos.md) lists how each one compares with native).
Or pass the `@margoengine/webgl` fallback to get a basic WebGL2 preview of plain meshes (no textures or effects; picking is its optional `/pick` entry),
which stays for v1.0.

| Browser | Status |
| --- | --- |
| Chrome and Edge (desktop) | Tested. The browser suites run in Chromium on a real GPU (Intel Arc 140V) and on SwiftShader in the manual browser workflow. |
| Safari on iPhone | Demos run, checked by hand only. |
| Safari on macOS | Draws five real models as Edge does, checked by hand. No test suite runs there. |
| Firefox | Not tested. |
| Android | Not tested. |

[docs/limits.md](docs/limits.md) lists the hardware these results come from and what has not been checked.

## Size

| Bundle | gzip | raw |
| --- | --- | --- |
| core + stage (`import { createStage } from 'margoengine'`) | 23,013 B | 57,071 B |

Recorded in [entry-sizes.json](examples/package-benchmarks/results/entry-sizes.json), along with
the size of every other package entry. `npm run measure:size` bundles the entry with Vite, minified the same way as
the package build, gzips it at the default level and prints the figure for your checkout. The build fails if
core + stage reaches 25,000 B gzip.

`npm run bench` runs the render, load, assembly, physics and memory suites with medians, p95 and machine checks. See
[docs/benchmarking.md](docs/benchmarking.md). No comparisons with other engines are published here yet.

## Architecture

```
your app
  margoengine            createStage: canvas, camera, controls, loading
  @margoengine/core      Engine, Scene, Mesh, Geometry, PbrMaterial; WebGPU renderer
    kernel (Rust/Wasm)   transforms, bounds and culling in one flat buffer
  @margoengine/*         optional packages, attached through core's extension hooks
```

Core is frozen: packages add render passes, materials and loaders through `@margoengine/core/extension` instead of
changing the base, so the base stays small and an app only pays for what it imports. The Rust source is in
`packages/kernel`; the compiled Wasm is checked in, so building the JavaScript never needs Rust.

[MODERN-ENGINE.md](MODERN-ENGINE.md) covers the architecture, lifecycle rules and limits in detail.
[docs/api-overview.md](docs/api-overview.md) is a short tour of the API. AI coding tools can read
[margoengine.com/llms.txt](https://margoengine.com/llms.txt) or run the `@margoengine/mcp` server
([docs/ai-tools.md](docs/ai-tools.md)).

## Packages

<!-- package-list: generated from docs/catalog.json by scripts/build-catalog.js; do not edit -->

99 packages in 12 layers, the same as the [catalog](https://margoengine.com/catalog/).

### Start here (3)

| Package | What it is |
| --- | --- |
| [`margoengine`](packages/margoengine/README.md) | Margo Engine in one install: the stage and every package as margoengine/<name> (margoengine/gltf, margoengine/shadows, margoengine/physics, margoengine/react). |
| [`@margoengine/stage`](packages/stage/README.md) | The stage: createStage mounts a canvas, camera controls and rendering in five lines. Re-exported by margoengine. |
| [`@margoengine/core`](packages/core/README.md) | WebGPU rendering and a Wasm transform kernel. WebGL2 is the optional @margoengine/webgl package. |

### Setup and diagnostics (7)

| Package | What it is |
| --- | --- |
| [`@margoengine/math`](packages/math/README.md) | Vector, quaternion, matrix, Euler, color, bounds, ray, plane and frustum math, one module per type. |
| [`@margoengine/quality`](packages/quality/README.md) | Measured quality tiers: start light, time the GPU, remember full 4x quality only where it has headroom. |
| [`@margoengine/webgl`](packages/webgl/README.md) | WebGL2 fallback renderer for browsers without WebGPU: flat-shaded PBR core meshes, opt in with Engine.create(canvas, {fallback: webglRenderer}). |
| [`@margoengine/webgl2-compat`](packages/webgl2-compat/README.md) | The WebGL2 compatibility layer for browsers without WebGPU (milestones M0 to M8 done); the site's demos run on it there. install() gives core a WebGPU-shaped device on WebGL2 that translates WGSL to GLSL ES 3.00; render shaders, texture views, readbacks of every copyable format, occlusion queries, render bundles, external textures, gather and storage-buffer reads run, compute pipelines run as fragment draws, point draws or on the CPU, whichever the shader allows, and DOF, splats and culling take routes of their own there. XR runs through the /xr entry; the voxel path tracer refuses it. |
| [`@margoengine/worker`](packages/worker/README.md) | Runs Margo Engine in a Web Worker on an OffscreenCanvas: canvas transfer, resize, pixel ratio and input forwarding, so heavy scenes never block the page. |
| [`@margoengine/stats`](packages/stats/README.md) | Allocation-free frame samples, DOM performance overlay, optional WebGPU timestamp profiling, pipeline compile tracking, a CPU phase breakdown, leak alerts and field telemetry. |
| [`@margoengine/inspector`](packages/inspector/README.md) | Entity hierarchy, live properties, WebGPU wireframe, normal and bounding-box overlays, and a frame debugger. |

### Loading and formats (11)

| Package | What it is |
| --- | --- |
| [`@margoengine/gltf`](packages/gltf/README.md) | Lazy static glTF/GLB loading for Margo Engine. |
| [`@margoengine/gltf-pro`](packages/gltf-pro/README.md) | Opt-in glTF 2.0 metallic-roughness rendering for Margo Engine WebGPU. |
| [`@margoengine/loaders`](packages/loaders/README.md) | PLY, STL, 3MF, PCD, OFF, XYZ, OBJ/MTL, COLLADA, Tiled TMX, VTK, NRRD, LDraw, Rhino 3DM, 3DS, LWO, AMF, MD2, PDB, KMZ, NURBS, LAS, OpenVDB, MaterialX, Lottie, static USDA/USDZ, SVG and TrueType font loaders for Margo Engine. |
| [`@margoengine/decoders`](packages/decoders/README.md) | Worker-pooled Draco geometry and KTX2/Basis texture decoding, and synchronous PNG, TGA, TIFF, DDS and KTX reading, for Margo Engine. |
| [`@margoengine/fbx`](packages/fbx/README.md) | Binary and ASCII FBX conversion into the optional Margo glTF animation pipeline. |
| [`@margoengine/usdz`](packages/usdz/README.md) | Optional static USDA, USDC and USDZ ingestion through Margo glTF PBR. |
| [`@margoengine/exporters`](packages/exporters/README.md) | glTF/GLB, STL, OBJ, PLY, USDZ, COLLADA and 3MF exporters for Margo Engine scenes and geometry data. |
| [`@margoengine/blender`](packages/blender/README.md) | Optional offline Blender .margo assets using Margo's WebGPU PBR renderer. |
| [`@margoengine/cache`](packages/cache/README.md) | Opt-in offline asset cache: a fetch-compatible IndexedDB cache for GLB, .bin and texture files with ETag/Last-Modified revalidation, app versioning, range requests, a byte budget with LRU eviction and network fallback. |
| [`@margoengine/splats`](packages/splats/README.md) | Optional Gaussian splats with GPU covariance projection and stable compute radix sorting. |
| [`@margoengine/tiles`](packages/tiles/README.md) | Streaming OGC 3D Tiles 1.1: implicit and explicit tilesets, screen-space-error selection, a fetch queue, a memory budget and glTF tiles drawn through gltf-pro. |

### Rendering and lighting (24)

| Package | What it is |
| --- | --- |
| [`@margoengine/materials`](packages/materials/README.md) | Optional glTF PBR material lobes, transmission, volume, parallax occlusion, triplanar and subsurface scattering, and typed node graphs through an isolated extension slot. |
| [`@margoengine/shader`](packages/shader/README.md) | Typed shader nodes that compile to readable WGSL: node materials, node post effects and node compute passes, with a visual node editor. |
| [`@margoengine/environment`](packages/environment/README.md) | HDR/EXR/UltraHDR loading, EXR writing, image-based lighting (prefiltered specular, SH irradiance, BRDF LUT), environment backgrounds and scene fog for Margo Engine on WebGPU. |
| [`@margoengine/clustered`](packages/clustered/README.md) | WebGPU clustered forward point and spot lighting with optional local shadows. |
| [`@margoengine/shadows`](packages/shadows/README.md) | Four-cascade cached directional shadows with PCSS. |
| [`@margoengine/lightmap`](packages/lightmap/README.md) | CPU lightmap atlases with native albedo, emission, normal and ORM textures; optional area lights, emissive surfaces, bounces and glass (./global) and caustics (./refracted). |
| [`@margoengine/sky`](packages/sky/README.md) | Procedural atmospheric skies, clouds, sun, moon, stars and weather (rain, snow, lightning). |
| [`@margoengine/weather`](packages/weather/README.md) | Weather over time: a state machine with presets that blends rain, snow, hail, wind and lightning; a deterministic wind field; wet and snowy surface hooks in JavaScript and WGSL; helpers for the sky's Weather; and bouncing GPU hail. |
| [`@margoengine/toon`](packages/toon/README.md) | Stepped diffuse shading and inverted-hull outlines. |
| [`@margoengine/oit`](packages/oit/README.md) | Order-independent transparency for gltf-pro BLEND primitives and materials transparent meshes: weighted blending, moment-based blending, or exact per-pixel layer lists, with no popping between overlapping transparent parts. |
| [`@margoengine/lod`](packages/lod/README.md) | Level of detail with hysteresis and screen-size switching for thousands of instances, plus GPU-baked octahedral imposters drawn in one instanced call per atlas. |
| [`@margoengine/culling`](packages/culling/README.md) | GPU-driven static instances: frustum and Hi-Z occlusion culling in compute, order-preserving compaction and indirect draws, no per-part CPU work per frame. |
| [`@margoengine/points`](packages/points/README.md) | Large point clouds (PointCloud, PointsMaterial) and instanced sprites (SpriteBatch, SpriteMaterial) for Margo Engine, WebGPU. |
| [`@margoengine/sprites`](packages/sprites/README.md) | 2D sprites at exact pixels: one instanced draw per layer, atlas rectangles, pivot, flip, rotation, tint, z and y sorting, integer pixel snapping and an optional normal map target. |
| [`@margoengine/lines`](packages/lines/README.md) | Fat lines (Line, LineMaterial) and debug helpers for Margo Engine, WebGPU. |
| [`@margoengine/text`](packages/text/README.md) | GPU signed distance field text for Margo Engine: runtime glyph atlases from any browser font, wrapping, alignment, outlines and shadows, WebGPU. |
| [`@margoengine/pixel`](packages/pixel/README.md) | Pixel art rendering: a pixel camera with integer zoom and parallax, and a layer compositor that scales low-res layers by whole numbers and turns them with every output pixel one source pixel. |
| [`@margoengine/lighting2d`](packages/lighting2d/README.md) | 2D lights for Margo Engine: point, spot and directional lights with normal-mapped shading and hard shadows from occluder edges, for pixel layers. |
| [`@margoengine/labels`](packages/labels/README.md) | HTML labels and CSS 3D objects positioned over a Margo Engine canvas. |
| [`@margoengine/html`](packages/html/README.md) | World-space DOM anchors, CSS3D placement and scene-depth occlusion. |
| [`@margoengine/video`](packages/video/README.md) | WebGPU external video textures and optional Web Audio sampling. |
| [`@margoengine/xr`](packages/xr/README.md) | Optional WebGPU WebXR sessions, input poses and stereo rendering for Margo Engine. |
| [`@margoengine/headless`](packages/headless/README.md) | Render without a browser page: a stand-in canvas for core, GPU globals from the WebGPU binding you pass in, and readback to RGBA pixels or PNG bytes. |
| [`@margoengine/staging`](packages/staging/README.md) | Product-shot staging: soft ground contact shadows (shadow-catcher plane) for core meshes and glTF models. |

### Post-processing (5)

| Package | What it is |
| --- | --- |
| [`@margoengine/post`](packages/post/README.md) | HDR bloom, frame-graph SSAO, GTAO, SSGI and SSR, motion blur, lens flare, SMAA and FXAA, glitch and afterimage, and post-effect stacks for Margo Engine WebGPU. |
| [`@margoengine/tonemap`](packages/tonemap/README.md) | Optional color grading: Khronos PBR Neutral (the engine default), AgX and ACES fitted curves, 2-65 cube LUTs. |
| [`@margoengine/dof`](packages/dof/README.md) | Optional two-pass WebGPU depth of field with circular bokeh. |
| [`@margoengine/taa`](packages/taa/README.md) | Optional temporal anti-aliasing with motion vectors and YCoCg history clamping. |
| [`@margoengine/transitions`](packages/transitions/README.md) | WebGPU scene wipes, noise dissolves and chromatic displacement. |

### World and effects (15)

| Package | What it is |
| --- | --- |
| [`@margoengine/terrain`](packages/terrain/README.md) | Geometry clipmaps and triplanar terrain layers. |
| [`@margoengine/biomes`](packages/biomes/README.md) | Biome maps from a heightmap and a few climate settings: integer fixed-point climate fields, biome classification with smooth ecotones, presets, terrain ground weights and editor hooks, byte-identical on every platform. |
| [`@margoengine/voxel`](packages/voxel/README.md) | Voxel worlds: a block-type registry, 32-cubed palette chunks with light bytes, and a chunked world with dirty tracking and change events. |
| [`@margoengine/voxel-pathtracer`](packages/voxel-pathtracer/README.md) | Progressive WebGPU path tracer for instanced voxel models: diffuse, plastic, metal, glass, emissive, blended and volumetric materials, sun, sky, HDR environment and area lights, depth of field, motion blur, a denoiser and PNG capture. |
| [`@margoengine/voxel-edit`](packages/voxel-edit/README.md) | Editing voxel models for editors and tools: dense and sparse grids, modeling operations, brushes and selections, picking, export meshing, .vox scene editing and frame animation. |
| [`@margoengine/water`](packages/water/README.md) | Gerstner water surfaces, terrain-coupled shallow-water flow, foam and spray. |
| [`@margoengine/scenery`](packages/scenery/README.md) | Procedural moonlit skies and scenery passes for Margo Engine. |
| [`@margoengine/scatter`](packages/scatter/README.md) | Seeded instancing, distance-based LOD and procedural wind. |
| [`@margoengine/road`](packages/road/README.md) | Arc-length spline road surfaces, raised curbs and tiled UVs. |
| [`@margoengine/tilemap`](packages/tilemap/README.md) | 2D tile maps for Margo Engine: the TileMapData format (tilesets, animated tiles, collision shapes, tile and object layers, parallax), a chunked renderer at exact pixels, auto-tiling and the Tiled and LDtk importers. |
| [`@margoengine/vfx`](packages/vfx/README.md) | GPU particle simulation and indirect billboards, with curves over life and sphere, cone and mesh-surface emitters. |
| [`@margoengine/creative`](packages/creative/README.md) | WebGPU particles, atmosphere, toon shading and post-processing for Margo Engine. |
| [`@margoengine/procedural`](packages/procedural/README.md) | Procedural cabins, foliage, grass, humanoids, Marching Cubes surfaces, seeded 2D/3D/4D noise, L-systems, Voronoi fracture and a bounded voxel expression language. |
| [`@margoengine/wfc`](packages/wfc/README.md) | Seeded wave function collapse: 3D tile adjacency and the 2D overlapping (sample-based) model with backtracking. |
| [`@margoengine/splines`](packages/splines/README.md) | 3D Catmull-Rom, Bezier, Hermite, B-spline and Kochanek-Bartels curves with arc-length lookup, closest point, stable frames and knot editing. |

### Animation and interaction (15)

| Package | What it is |
| --- | --- |
| [`@margoengine/animation`](packages/animation/README.md) | Storage-buffer skinning and compute morph targets for Margo Engine. |
| [`@margoengine/animator`](packages/animator/README.md) | Blend trees, additive layers, animation states, foot IK, CCD IK chains, root motion, and look-at and aim constraints. |
| [`@margoengine/kinematics-constraints`](packages/kinematics-constraints/README.md) | Standalone analytical capsule, sphere and convex hull constraints for IK target and arm clearance. |
| [`@margoengine/rigging`](packages/rigging/README.md) | Rigging and animation authoring: automatic skin weights, weight painting, skin checks, IK chains with poles, retarget presets, spring bones, VRM 1.0 avatars, geodesic voxel weights, corrective shapes, weight transfer, face tracking, automatic rigs from a bare mesh. |
| [`@margoengine/tween`](packages/tween/README.md) | Allocation-free numeric tween updates and easing timelines. |
| [`@margoengine/cinematic`](packages/cinematic/README.md) | Virtual cameras with priorities and blends, framing, dolly tracks, group framing, camera noise, confiners and focus tracking, on top of damped follow, look-at and shake. |
| [`@margoengine/cutscene`](packages/cutscene/README.md) | Cutscene timelines: camera, transform, property, animation, audio, subtitle and event tracks, nested timelines, scrubbing, a player that fires events in order, virtual camera shots with blends, rendering to a video file, a take recorder, dialogue with lip sync, and particle and activation tracks, and a timeline editor panel. |
| [`@margoengine/controls`](packages/controls/README.md) | Orbit, map, trackball, arcball, fly, first-person, pointer-lock and collision-aware walkthrough (/walk) camera controls, a transform gizmo and drag controls for Margo Engine. |
| [`@margoengine/cameras`](packages/cameras/README.md) | Orthographic projection and exactly vertical (top-down) views for the core camera, with matching culling and picking. |
| [`@margoengine/input`](packages/input/README.md) | Semantic keyboard, pointer, gamepad, touch, gyro and pen actions with haptics, tap, hold, slow tap and double press rules, local multiplayer, and recording and replay. |
| [`@margoengine/ui`](packages/ui/README.md) | Game UI drawn in the engine: menus, HUDs, health bars, inventories, dialogs and toasts with flex layout, theming, keyboard, gamepad and touch navigation, screen reader support and React components. |
| [`@margoengine/viewcube`](packages/viewcube/README.md) | CAD view cube: shows the camera orientation and animates to top, front, side and isometric views, with a perspective/orthographic toggle. |
| [`@margoengine/selection`](packages/selection/README.md) | GPU picking and visible mesh selection outlines. |
| [`@margoengine/audio`](packages/audio/README.md) | Web Audio listener, global and positional sounds and a frequency analyser for Margo Engine. |
| [`@margoengine/mixer`](packages/mixer/README.md) | Audio mixing and effects: buses with gain, mute, solo, sends and ducking; equaliser, filter, compressor, limiter, delay and reverb on Web Audio; positional emitters; deterministic offline rendering. |

### Simulation and games (11)

| Package | What it is |
| --- | --- |
| [`@margoengine/physics`](packages/physics/README.md) | Rigid-body physics for Margo Engine on Rapier: fixed-step engine plugin with interpolation, colliders, joints, queries, events and a character controller. |
| [`@margoengine/physics2d`](packages/physics2d/README.md) | 2D rigid-body physics for Margo Engine on Rapier: fixed-step plugin with interpolation, sprite-driven bodies, joints, queries, events, a character controller and tile map colliders. |
| [`@margoengine/ragdoll`](packages/ragdoll/README.md) | Ragdolls on Margo physics: capsule bodies from a skeleton, cone and hinge joint limits, kinematic hit boxes, going limp and blending back to the animation. |
| [`@margoengine/navmesh`](packages/navmesh/README.md) | Convex polygon navigation with A*, funnel paths and ORCA avoidance; navmesh generation from triangles (./build) tiled meshes that rebuild at run time (./tiles), baked files (./codec) and jump links (./links). |
| [`@margoengine/ecs`](packages/ecs/README.md) | Typed-array packed sparse-set entity component storage. |
| [`@margoengine/fsm`](packages/fsm/README.md) | Hierarchical state machines with history, delayed transitions, parallel regions, JSON documents, snapshots and traces. |
| [`@margoengine/behavior`](packages/behavior/README.md) | Game AI: behaviour trees with a typed blackboard and async tasks, utility-AI scoring, and steering and flocking behaviours. |
| [`@margoengine/save`](packages/save/README.md) | Save and load: versioned scene and world documents with stable ids, prefabs with overrides, migrations, all-or-nothing loading and storage adapters. |
| [`@margoengine/net`](packages/net/README.md) | Hermite and quaternion snapshot interpolation with bounded prediction. |
| [`@margoengine/netcode`](packages/netcode/README.md) | Game networking for any game: schema-first binary codec with delta snapshots, an authoritative fixed-timestep server, client prediction and reconciliation, interpolation and a loopback network for tests. |
| [`@margoengine/voxel-net`](packages/voxel-net/README.md) | Multiplayer voxel worlds: an authoritative Node server on a hand-written WebSocket, a browser client with prediction and correction, and headless bots for load tests. |

### Geometry and spatial (4)

| Package | What it is |
| --- | --- |
| [`@margoengine/bvh`](packages/bvh/README.md) | Triangle BVH, spatial queries and an engine Raycaster for Margo Engine. |
| [`@margoengine/geometry`](packages/geometry/README.md) | Pure-CPU, tree-shakable geometry for Margo Engine: primitives, curves, shapes, extrusion, triangulation and mesh utilities. |
| [`@margoengine/mesh-edit`](packages/mesh-edit/README.md) | Pure polygon editing with retained corner UVs, explicit topology provenance and conservative cleanup. |
| [`@margoengine/scene`](packages/scene/README.md) | Scene graph conveniences for core meshes: children, traverse, userData, lookAt and world position, rotation and scale, as functions or as mesh members. |

### Data and science (2)

| Package | What it is |
| --- | --- |
| [`@margoengine/compute`](packages/compute/README.md) | GPU compute without the WebGPU boilerplate, NumPy style: N-d arrays with views and broadcasting, fused expressions, reductions and statistics, scan, sort, selection, histograms, matmul, FFT, convolution, random numbers, streaming, neural networks, graph algorithms, and WGSL kernels bound by name. |
| [`@margoengine/sciviz`](packages/sciviz/README.md) | Scientific visualisation for Margo Engine: volume rendering with transfer functions, slices and GPU isosurfaces, million-point scatter plots, surface and line plots with axes, ticks, labels and colour bars, and perceptual colour maps. |

### AI tools (1)

| Package | What it is |
| --- | --- |
| [`@margoengine/mcp`](packages/mcp/README.md) | A Model Context Protocol server for Margo Engine: AI coding tools (Claude, Cursor, Copilot) search the docs and API, read a package, list the examples and type-check a snippet against the real package types. Plain stdio JSON-RPC, no dependencies. |

### Frameworks (1)

| Package | What it is |
| --- | --- |
| [`@margoengine/react`](packages/react/README.md) | React 18/19 components and stable mesh refs for Margo Engine. |

<!-- /package-list -->

## Roadmap

- Publish 1.0.0 to npm.
- The WebGL2 compatibility layer is an optional package that WebGPU users never load ([docs/webgl2-compat-roadmap.md](docs/webgl2-compat-roadmap.md)); the voxel path tracer refuses it. `@margoengine/webgl` is the small preview; in the React Canvas, `loadFallback` loads it and `fallbackContent` replaces the plain message.
- Testing on more hardware: Apple silicon, AMD, Android, Firefox and macOS Safari.
- Published benchmark comparisons with their method and raw results.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, tests and what a good pull
request looks like. Please follow the [code of conduct](CODE_OF_CONDUCT.md), and report security issues as described
in [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) (see also [NOTICE](NOTICE)). Third-party code and assets keep their own licenses; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Made by Scott Campbell. [margoengine.com](https://margoengine.com)

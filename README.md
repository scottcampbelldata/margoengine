# Margo Engine

A small Rust/Wasm engine for web apps, with WebGPU rendering, WebGL2 fallback, ordinary React components and optional domain packs.

Official website: [margoengine.com](https://margoengine.com). Built with precision, named with love. For Margie.

The implementation lives in `packages/`, with Vite and Next.js starters in `examples/`. Small internal helpers shared by the optional packs live in `packages/shared/`. Source is available in the public [Margo Engine repository](https://github.com/scottcampbelldata/margoengine). The renamed packages use `@margoengine/*`, with `margoengine` as the meta-package. Build from source or install local tarballs until the renamed packages are published.

## Use Margo Engine

For the high-level API built from this checkout, see [`margoengine`](packages/margoengine/README.md). It mounts the canvas, enables camera controls and starts rendering:

```ts
import {createStage} from 'margoengine';
const app = await createStage('#scene');
const orb = app.sphere({color: '#84d6bd', roughness: 0.25, scale: [1, 0.85, 1]});
app.onTick(delta => {orb.rotation.z += delta;});
window.addEventListener('pagehide', () => app.dispose(), {once: true});
```

Provide a container such as `<div id="scene" style="height:400px"></div>` and call `app.dispose()` on unmount. Models, machinery, creative effects and scenery load on demand through the same wrapper. The new facade package is available locally and has not been published yet. Run `npm run modern:dev` and open `/quickstart.html` to try it.

For a React application:

```sh
npm install @margoengine/core@0.1.0 @margoengine/react@0.1.0 react@^19 react-dom@^19
```

For plain TypeScript:

```sh
npm install @margoengine/core@0.1.0
```

Add optional packs as needed:

```sh
npm install @margoengine/gltf@0.1.0
npm install @margoengine/machinery@0.1.0
npm install @margoengine/creative@0.1.0
```

The optional packs and React adapter require core 0.1.0. The React adapter supports React 18 and 19; the command above selects React 19.

## Run from source

```sh
git clone https://github.com/scottcampbelldata/margoengine.git margoengine
cd margoengine
npm ci
npm run dev
```

Open the localhost URL printed by Vite for the standalone [Night Citadel showcase](apps/showcase-night-citadel/README.md): procedural architecture and cliffs, a moving moon, stars, shadows, atmospheric controls and live telemetry. `npm run modern:dev` opens the original starter, with nested rotating geometry, PBR controls, lazy glTF import, GPU leaves, CAD navigation, conveyor machinery, capped cutaways, dimensions, STL/OBJ upload, atmosphere/FX and device restoration. Its **Toggle moonlit scenery** button still loads the scenery package on demand. Consumers use the checked-in Wasm and need no Rust toolchain.

```sh
npm test                      # builds packages and runs modern unit checks
npm run build:packages        # builds workspace libraries with precompiled Wasm
npm run measure:size          # verifies the combined core + stage gzip ceiling
npm run build                 # builds packages, both starters and Night Citadel
npm run pack:packages         # rebuilds and writes npm tarballs to test-results/
npm run package:blender       # creates dist/margo-blender-addon-v1.0.0.zip (Python 3.11+)
npm run modern:test:browser   # after build: GPU checks and production starter flows
npm run modern:test:domains   # caps, sorting, FX and real GPU-loss recovery
npm run modern:test:sky       # scenery phases, stars, depth and plugin lifecycle on WebGPU
npm run modern:test:citadel   # showcase pixels, controls, pacing, resize and orbit heap profile
npm run modern:test:packages  # frozen exports/types and React 18 lifecycle
npm run modern:test:wrapper   # five-line setup, loading, lazy packs and teardown
npm run modern:test:finalization # picking, industrial depth and conveyor stress; dev server required
npm run modern:check:conveyor     # live UI, motor timing and 15s Chrome GC trace; dev server required
npm run modern:dev               # original Vite starter / machinery checks
npm run dev --workspace @margoengine/starter-next
```

## Packages

Libraries use the npm scope `@margoengine`; the stage facade is `margoengine`. The release contains 61 packages: most at `0.1.0`, with DOF and tonemapping at `1.0.0`. The [catalog](docs/README.md) lists every package, runtime export and npm publication status.

| Package | Includes |
| --- | --- |
| [`margoengine`](packages/margoengine/README.md) | Stage facade, canvas mounting, camera controls and lazy domain loading |
| [`@margoengine/core`](packages/core/README.md) | Wasm transform memory, hierarchy/culling, reversed float depth, uint picking, CAD camera controls, instanced PBR, backends and plugin/pass lifecycle |
| [`@margoengine/gltf`](packages/gltf/README.md) | Lazy static glTF/GLB loading, named nodes and shared primitive geometry |
| [`@margoengine/react`](packages/react/README.md) | `MargoCanvas` (`Canvas` alias), `useMargoStage`, stable `useFrame`, mesh components and SSR |
| [`@margoengine/xr`](packages/xr/README.md) | `XRManager`, `XRController`, inline input tracking and native WebGPU immersive stereo |
| [`@margoengine/usdz`](packages/usdz/README.md) | Static USDA/USDC hierarchies, stored/Deflate containers and gltf-pro PreviewSurface PBR |
| [`@margoengine/ifc`](packages/ifc/README.md) | IFC tessellation through web-ifc, world-space geometry, colors and BIM IDs |
| [`@margoengine/loaders`](packages/loaders/README.md) | PLY/3MF/PCD/OFF/XYZ/VTK and static USDA/USDZ import; USDC is unsupported |
| [`@margoengine/exporters`](packages/exporters/README.md) | glTF/GLB/STL/OBJ/PLY and static USDZ export for Quick Look |
| [`@margoengine/machinery`](packages/machinery/README.md) | Revolute/prismatic joints, gear/piston couplings, bounded IK, sections/caps, dimensions, welded STL/OBJ, assembly queries/visibility, metrology and industrial presets |
| [`@margoengine/creative`](packages/creative/README.md) | Textured/sorted GPU particles, wind obstacles, sky/fog/scattering, toon, HDR and compute post-processing |
| `@margoengine/scenery` | Independently loaded `SkyMoon` plugin and `SkyMoonPass`, procedural moonlit sky, lunar phases, stars and horizon haze |
| `@margoengine/gltf-pro` | Optional metallic-roughness PBR, all five texture maps, normal mapping, mipmaps and alpha modes |
| [`@margoengine/blender`](packages/blender/README.md) | Offline Blender `.margo` export and prepacked WebGPU PBR ingestion |
| `@margoengine/animation` | Optional storage-buffer skeletal skinning, compute morphs and glTF animation playback |
| `@margoengine/post` | Optional frame-graph SSAO, view-space normal/depth extraction and bilateral blur |
| [`@margoengine/shadows`](packages/shadows/README.md) | Four directional cascades, PCSS, cached static depth and dynamic casters |
| [`@margoengine/clustered`](packages/clustered/README.md) | Compute frustum clusters and forward PBR for up to 1,024 point/spot lights |
| [`@margoengine/vfx`](packages/vfx/README.md) | Up to 1,000,000 GPU particles, curl turbulence, collisions and indirect billboards |
| [`@margoengine/animator`](packages/animator/README.md) | Gameplay states, 1D/2D blending, additive masks and analytical foot IK |
| [`@margoengine/taa`](packages/taa/README.md) | Halton jitter, mesh/skinned velocity, depth-tested history and YCoCg clamping |
| [`@margoengine/splats`](packages/splats/README.md) | GPU radix sorting, covariance ellipses, degree-3 SH and binary Gaussian captures |
| [`@margoengine/terrain`](packages/terrain/README.md) | Fixed geometry clipmaps, GPU height/normal sampling and triplanar texture layers |

Core plus the stage facade measures **19,998 bytes gzip**, including embedded Wasm and both backends. The base is feature-frozen for v1.0.0; every push and pull request runs a CI build that rejects a combined size of **20,000 bytes gzip or above** and checks package isolation. Optional PBR, animation and SSAO packages use the existing extension hooks and do not enter the base bundle. The build also retains the 30 KiB combined core/static-glTF budget and 30 KiB raw Wasm budget. React/framework/application code is additional; domain packages have no 20 KiB ceiling.

The six requested game modules (shadows, clustered, animator, TAA, VFX and splats), plus terrain, use those hooks. Build with `npm run build:packages`; run `npm run modern:test:game` for their combined WebGPU rendering/culling/cache/IK/particle checks, temporal reprojection/clamping, skinned motion, stable radix sorting and ellipse blending. `npm run modern:test:game:packages` checks ten packed packages and seven standalone README TypeScript examples. The normal sort test covers 66,049 splats across hierarchical scan blocks; set `SPLAT_STRESS=1` for the additional three-million-splat capacity/sort check. Million-particle, three-million-splat and 1,024-light execution tests validate correctness separately from FPS claims. These source packages have not been published by this change.

```tsx
import { useRef } from 'react';
import { Canvas, Mesh, BoxGeometry, PbrMaterial, useFrame, type MeshRef } from '@margoengine/react';

function Cube() {
  const mesh = useRef<MeshRef>(null);
  useFrame((_, delta) => { if (mesh.current) mesh.current.rotation.y += delta; });
  return <Mesh ref={mesh}>
    <BoxGeometry />
    <PbrMaterial color="#84d6bd" roughness={0.3} />
  </Mesh>;
}
export default function App() {
  return <Canvas style={{ height: 400 }}><Cube /></Canvas>;
}
```

`EngineKernel`/`Engine`, Canvas callbacks and React mesh refs expose the frozen portable TypeScript API; raw Wasm/GPU state is available only through the explicit `@margoengine/core/extension` entry. Entity creation occurs in effects. Nested components register upward to support child-first commit order. Frame callbacks mutate stable refs without scheduling React renders.

[MODERN-ENGINE.md](MODERN-ENGINE.md) contains the architecture, API examples, lifecycle rules, size evidence, supported loader subset, verification and remaining domain features. Thirty-one JavaScript tests, four Rust checks and 32 browser check groups passed after the modern-only cleanup, including production Vite/Next rendering, actual particle storage readback, packed consumers and React 18/19 lifecycle checks. Chrome conveyor captures verify UI picking/orbit, instanced draws, coupled timing and 15-second GC/allocation traces; the observed collections do not establish zero-GC. AMD Radeon integrated graphics and NVIDIA baseline measurements are recorded in the [benchmark summary](benchmarks/README.md). Raw captures and recovery archives remain local. Firefox/Safari and mobile GPU hardware remain unverified.

Node.js 22.12+ or 24+ is required; TypeScript consumers need TypeScript 7+ with DOM types; Wasm initialization uses SIMD and DecompressionStream gzip. WebGPU uses HTTPS/localhost; basic scenes fall back to WebGL2. GPU particles, sections, creative and scenery rendering require WebGPU; solid caps also require depth32float-stencil8 support; CPU machinery/CAD/annotations work with either backend. The libraries are [MIT licensed](LICENSE). The workspace root and starter apps remain private.

`npm run build:packages` uses the checked-in Wasm, emits ESM and TypeScript declarations, removes stale distribution files, copies the root license into each package and enforces the existing size/isolation budgets. Each library's `prepack` hook runs that same workspace build before `npm pack` or `npm publish`. Tarballs contain only built files, package metadata, a package README and the MIT license. To try local changes, install a rebuilt tarball from `test-results/`; optional packs require the matching core tarball. Existing `modern:*` commands remain available, including `modern:build` for rebuilding the Rust kernel.

Import the scoped packages listed above. Native STEP/IGES solids and heavier renderer/physics features remain deferred; implemented domain features and their limits are documented in MODERN-ENGINE.md. The public repository contains the modern modular engine; the earlier renderer and recovery archives are excluded.

Run `npm run modern:dev:extensions`, then open `/examples/damaged-helmet.html` for PBR and the SSAO toggle or `/examples/robot-expressive.html` for clip playback and facial morph sliders. The demos download credited sample assets. The three extension packages are local workspace packages and have not been published. Their READMEs document supported glTF features and limits. `npm run modern:test:extensions` checks GPU deformation readback, a 1,001-joint skin, ambient-only SSAO, resize/device recovery, and both demos; `npm run modern:test:packages` checks standalone tarballs and TypeScript consumers.



## Package catalog and release

Run `npm run catalog` to preview the [searchable Margo catalog](docs/README.md). All 61 packages use their Margo names. `npm run catalog:build` refreshes the catalog from built runtime exports and checks exact-version availability on npm.

`npm run release:check` builds and tests the engine, enforces the 20,000-byte core + stage ceiling, and verifies every tarball's exports, TypeScript declarations and internal dependency versions. After signing into npm with access to the `@margoengine` scope, `npm run publish:packages` runs those checks and publishes the public library workspaces. Starter apps and showcases are private. Refresh the catalog after publishing and run `npm run build:site` to assemble the website.

[Committed SwiftShader results](benchmarks/README.md#swiftshader-runs-no-gpu) include repeat commands and the [historical conveyor picking failure](benchmarks/swiftshader/conveyor-check-picking-failure.txt). Software-renderer timings do not establish physical GPU performance.

# Vexel

A small Rust/Wasm engine for web apps, with WebGPU rendering, WebGL2 fallback, ordinary React components and optional domain packs.

The implementation lives in `packages/`, with Vite and Next.js starters in `examples/`. Small internal helpers shared by the optional packs live in `packages/shared/`. Source is available in the public [Vexel repository](https://github.com/scottcampbelldata/vexel). All five libraries are published on npm as version `0.1.0`; package links and install commands are below.

## Install from npm

For a React application:

```sh
npm install @scottcampbelldata/vexel-core@0.1.0 @scottcampbelldata/vexel-react@0.1.0 react@^19 react-dom@^19
```

For plain TypeScript:

```sh
npm install @scottcampbelldata/vexel-core@0.1.0
```

Add optional packs as needed:

```sh
npm install @scottcampbelldata/vexel-gltf@0.1.0
npm install @scottcampbelldata/vexel-machinery@0.1.0
npm install @scottcampbelldata/vexel-creative@0.1.0
```

The optional packs and React adapter require core 0.1.0. The React adapter supports React 18 and 19; the command above selects React 19.

## Run starters from source

```sh
git clone https://github.com/scottcampbelldata/vexel.git
cd vexel
npm ci
npm run dev
```

Open the localhost URL printed by Vite. The demo contains nested rotating geometry, a PBR material control, lazy glTF import, exploded views, GPU leaves, native CAD navigation and an optional procedural conveyor with 20–240 rollers, coupled motor RPM, covers, joints, box cuts, metrology and explode sliders, plus domain controls for capped cutaways, dimensions, STL/OBJ upload, atmosphere/FX, toon shading and device restoration. Default commands now build and test the new engine. Consumers use the checked-in Wasm and need no Rust toolchain.

```sh
npm test                      # builds packages and runs modern unit checks
npm run build:packages        # builds all five libraries with precompiled Wasm
npm run build                 # builds packages, Vite and Next.js starters
npm run pack:packages         # rebuilds and writes five npm tarballs to test-results/
npm run modern:test:browser   # after build: GPU checks and production starter flows
npm run modern:test:domains   # caps, sorting, FX and real GPU-loss recovery
npm run modern:test:packages  # frozen exports/types and React 18 lifecycle
npm run modern:test:finalization # picking, industrial depth and conveyor stress; dev server required
npm run modern:check:conveyor     # live UI, motor timing and 15s Chrome GC trace; dev server required
npm run dev --workspace @vexel/starter-next
```

## Packages

The five published libraries use the npm account scope `@scottcampbelldata` and are available at version `0.1.0`.

| Package | Includes |
| --- | --- |
| [`@scottcampbelldata/vexel-core`](https://www.npmjs.com/package/@scottcampbelldata/vexel-core) | Wasm transform memory, hierarchy/culling, reversed float depth, uint picking, CAD camera controls, instanced PBR, backends and plugin/pass lifecycle |
| [`@scottcampbelldata/vexel-gltf`](https://www.npmjs.com/package/@scottcampbelldata/vexel-gltf) | Lazy static glTF/GLB loading, named nodes and shared primitive geometry |
| [`@scottcampbelldata/vexel-react`](https://www.npmjs.com/package/@scottcampbelldata/vexel-react) | `Canvas`, `Mesh`, `BoxGeometry`, `GeometryResource`, `PbrMaterial`, `useFrame` |
| [`@scottcampbelldata/vexel-machinery`](https://www.npmjs.com/package/@scottcampbelldata/vexel-machinery) | Revolute/prismatic joints, gear/piston couplings, bounded IK, sections/caps, dimensions, welded STL/OBJ, assembly queries/visibility, metrology and industrial presets |
| [`@scottcampbelldata/vexel-creative`](https://www.npmjs.com/package/@scottcampbelldata/vexel-creative) | Textured/sorted GPU particles, wind obstacles, sky/fog/scattering, toon, HDR and compute post-processing |

Core measures **19.41 KiB gzip**, including embedded Wasm and both backends. Core plus glTF measures **24.28 KiB gzip**. The Wasm binary is **11.76 KiB raw**. React/framework/application code is additional. The build enforces 20/30 KiB gzip budgets and a 30 KiB raw Wasm budget.

```tsx
import { useRef } from 'react';
import { Canvas, Mesh, BoxGeometry, PbrMaterial, useFrame, type MeshRef } from '@scottcampbelldata/vexel-react';

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

`EngineKernel`/`Engine`, Canvas callbacks and React mesh refs expose the frozen portable TypeScript API; raw Wasm/GPU state is available only through the explicit `@scottcampbelldata/vexel-core/extension` entry. Entity creation occurs in effects. Nested components register upward to support child-first commit order. Frame callbacks mutate stable refs without scheduling React renders.

[MODERN-ENGINE.md](MODERN-ENGINE.md) contains the architecture, API examples, lifecycle rules, size evidence, supported loader subset, verification and remaining domain features. Thirty-one JavaScript tests, four Rust checks and 32 browser check groups passed after the modern-only cleanup, including production Vite/Next rendering, actual particle storage readback, packed consumers and React 18/19 lifecycle checks. Chrome conveyor captures verify UI picking/orbit, instanced draws, coupled timing and 15-second GC/allocation traces; the observed collections do not establish zero-GC. AMD Radeon integrated graphics and NVIDIA baseline measurements are recorded in the [benchmark summary](benchmarks/README.md). Raw captures and recovery archives remain local. Firefox/Safari and mobile GPU hardware remain unverified.

Node.js 22.12+ or 24+ is required; TypeScript consumers need TypeScript 7+ with DOM types; Wasm initialization uses SIMD and DecompressionStream gzip. WebGPU uses HTTPS/localhost; basic scenes fall back to WebGL2. GPU particles, sections and creative rendering require WebGPU; solid caps also require depth32float-stencil8 support; CPU machinery/CAD/annotations work with either backend. The five libraries are published on npm at version `0.1.0` and [MIT licensed](LICENSE). The workspace root and starter apps remain private.

`npm run build:packages` uses the checked-in Wasm, emits ESM and TypeScript declarations, removes stale distribution files, copies the root license into each package and enforces the existing size/isolation budgets. Each library's `prepack` hook runs that same workspace build before `npm pack` or `npm publish`. Tarballs contain only built files, package metadata, a package README and the MIT license. To try local changes, install a rebuilt tarball from `test-results/`; optional packs require the matching core tarball. Existing `modern:*` commands remain available, including `modern:build` for rebuilding the Rust kernel.

Import the scoped packages listed above. Native STEP/IGES solids and heavier renderer/physics features remain deferred; implemented domain features and their limits are documented in MODERN-ENGINE.md. The public repository contains the modern modular engine; the earlier renderer and recovery archives are excluded.



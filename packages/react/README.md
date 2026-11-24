# @margoengine/react

React 18 and 19 components and hooks for Margo Engine: a native canvas, pointer events, Suspense, stable mesh refs and
frame callbacks. There is no custom reconciler: `<Canvas>` creates one engine, and its children are ordinary React
components that edit it.

Import it as `margoengine/react` (from the `margoengine` package, the bindings in one import; `Model`, `Fbx`, `Animation`,
the `materials` components and physics come from `margoengine/react/gltf`, `/fbx`, `/animation`, `/materials` and
`/physics`, so a page without them builds without the Draco and Basis Wasm) or from this package
alone: `@margoengine/react` holds the bindings that need no optional package (`Canvas`, `Mesh`, geometry, materials,
hooks, views, `Sun`, `Center`), and a binding that needs `@margoengine/<name>` comes from `@margoengine/react/<name>`
(`OrbitControls` from `/controls` with `@margoengine/controls` installed, `Gltf` from `/gltf/pbr`, `Shadows` from
`/shadows`; the full list is in [SCENE.md](SCENE.md)). Optional parts load only when a component needs them, so an
unused feature costs nothing.

Start with the scene below, then add optional controls, models and materials as needed. Each binding lives
at the subpath named for its package; [SCENE.md](SCENE.md) lists the optional peers. For a textured,
shadowed scene with click-to-select, follow the [React first scene guide](../../docs/guides/react-first-scene.md).

## Install

Package name: `@margoengine/react`, version `1.0.0`. **It is not on npm yet**, so `npm install @margoengine/react` does
not work today. Two routes do. Both start from a clone of the repository (see [Install](../../README.md#install) in the
main README for Git LFS and Node.js: 22.12+ to use the package, 24.18+ to build it from the repository).

**Route 1: a Vite app of your own, from local tarballs.** In the clone:

```sh
npm ci
npm run pack:packages
```

`pack:packages` builds every package and writes one `.tgz` file each to `test-results/`. Then, in a new folder next to
the clone (shown for a shell that expands `*.tgz`, such as Git Bash, macOS or Linux):

```sh
mkdir my-react-app && cd my-react-app
npm init -y
npm pkg set type=module
npm install ../margoengine/test-results/*.tgz react react-dom vite @vitejs/plugin-react typescript @types/react @types/react-dom
```

Add an `index.html` with
`<div id="root"></div>` and `<script type="module" src="/src/main.tsx"></script>`, put the first scene below in
`src/main.tsx`, and run `npm exec -- vite`.

**Route 2: use the examples inside the clone.** `npm ci`, `npm run build:packages`, then
`npm run dev --workspace @margoengine/react-viewer` for the resizable Vite example.

**TypeScript with this package alone.** The types check under a strict `tsconfig.json` (`"skipLibCheck": false`)
without the optional peers; options typed by a peer you have not installed are `any` until you install it.

**After 1.0.0 is published**, `npm install margoengine react react-dom` replaces the tarballs and nothing else changes.
[SCENE.md](SCENE.md) lists the optional peers each component uses.

## First scene

A box lit by the default sun, with a click handler:

`Mesh` keeps the immutable React props for live pointer-handler lookup rather than copying a handler record on
every render. Replacing a callback still takes effect without re-registering the mesh. All transform effects run
as before. This removes prop-copy work; no measured speedup or comparison win is claimed.

```tsx
import { createRoot } from 'react-dom/client';
import { Canvas, Stage, Mesh, BoxGeometry, PbrMaterial } from 'margoengine/react';

export function App() {
  return (
    <Canvas style={{ height: 400 }}>
      <Stage camera={{ position: [0, 2, 5] }}>
        <Mesh position={[0, 1, 0]} onClick={event => console.log('Selected mesh', event.object)}>
          <BoxGeometry args={[1, 1, 1]} />
          <PbrMaterial color="#84d6bd" />
        </Mesh>
      </Stage>
    </Canvas>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
```

This first scene needs no model or texture files. For a reader moving from another renderer, `Mesh`,
`BoxGeometry`, `PbrMaterial` and the stage camera fill the familiar roles; Canvas owns the renderer and cleanup.

## Components

`Stage` configures the existing canvas stage and renders its children once that stage is available. Its `camera` prop updates the active camera; `shadows` uses the canvas's existing optional `@margoengine/shadows` lifecycle. Install that peer when enabling shadows. Canvas still creates and disposes the single engine and stage.

`Mesh` and `Model` accept `onClick`, `onPointerOver`, and `onPointerOut`. The canvas dispatches hits from its existing `engine.pick`; a click requires no more than three CSS pixels of total pointer movement, so OrbitControls drags do not click. Handlers receive `nativeEvent`, the hit mesh as `object`, `mesh`, and `target`, canvas-local `x`/`y` (CSS pixels from the canvas padding edge, inside any border, the same as `engine.pick` takes), and `clientX`/`clientY`.

`Group` is a geometry-free `Mesh` for parent transforms. Lowercase exports are aliases of the same hook-based components: `mesh === Mesh`, `group === Group`, `boxGeometry === BoxGeometry`, and `meshStandardMaterial === PbrMaterial`. Use a namespace in JSX:

```tsx
import * as Margo from 'margoengine/react';

<Margo.Canvas style={{ height: 400 }}>
  <Margo.Stage camera={{ position: [0, 2, 5] }}>
    <Margo.group position={[0, 1, 0]}>
      <Margo.mesh>
        <Margo.boxGeometry args={[1, 1, 1]} />
        <Margo.meshStandardMaterial color="#84d6bd" />
      </Margo.mesh>
    </Margo.group>
  </Margo.Stage>
</Margo.Canvas>;
```

React treats bare lowercase tags such as `<mesh>` and `<group>` as DOM elements, even when their names are imported. Namespace members such as `<Margo.mesh>` and `<Margo.group>` (or uppercase import bindings) invoke these components. All existing PascalCase exports remain available. To keep react-three-fiber's bare tags, compile with Margo's JSX runtime (next section).

### Lowercase tags and extend

Set `jsxImportSource` to `@margoengine/react` (or `margoengine/react`) and bare tags draw Margo components inside a
`<Canvas>`, so react-three-fiber code moves over without renames. Per file, put the pragma comment on top as below; for
the whole app, set `"jsxImportSource": "@margoengine/react"` in `tsconfig.json` (`compilerOptions`, with
`"jsx": "react-jsx"`) or in your bundler's JSX options. The runtime is React's own: every other element is exactly what
`react/jsx-runtime` makes, and nothing changes outside a Canvas, so an SVG `<line>` stays an SVG line.

```tsx
/** @jsxImportSource @margoengine/react */
import { Canvas, extend } from '@margoengine/react';
import { SphereGeometry } from '@margoengine/react/geometry';

// <sphereGeometry> from here on: each key, first letter lowercased, becomes a tag.
extend({ SphereGeometry });
declare module '@margoengine/react' {
  interface MargoElements {
    sphereGeometry: import('react').ComponentProps<typeof SphereGeometry>;
  }
}

export function App() {
  return (
    <Canvas style={{ height: 400 }}>
      <directionalLight position={[3, 5, 4]} intensity={3} />
      <group position={[0, 1, 0]}>
        <mesh rotation={[0, 0.5, 0]}>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#84d6bd" />
        </mesh>
        <mesh position={[2, 0, 0]}>
          <sphereGeometry args={[0.5, 32, 16]} />
          <meshStandardMaterial color="#e0a458" roughness={0.3} />
        </mesh>
      </group>
    </Canvas>
  );
}
```

| Tag | Margo component | Notes |
| --- | --- | --- |
| `<mesh>`, `<group>` | `Mesh`, `Group` | Same props, `ref` is the engine mesh. |
| `<boxGeometry args>` | `BoxGeometry` | |
| `<meshStandardMaterial>` | `PbrMaterial` | `color`, `roughness`, `metalness`. |
| `<directionalLight position>` | `Sun` | Shines from `position` towards the origin (default `[0, 1, 0]`); `intensity` defaults to 3, the `Sun` default. |
| anything else | `extend({ Name: Component })` | Values are React components, for example `SphereGeometry` and `PlaneGeometry` from `/geometry` or `AmbientLight` from `/environment`. |

`extend` takes React components, not engine classes as react-three-fiber's does: wrap an engine object in a component
(an effect that creates and disposes it) and extend with that. The tags are shared by the page, and a later `extend` of
the same tag replaces it. Add the prop types of your tags by augmenting `MargoElements`, as above. Under the
`react-server` condition (Next.js server components) the runtime is React's unchanged: write Margo tags in client
components, below the `<Canvas>`. A tag `extend` never named, such as `<pointLight>`, is still a DOM element and the
development hint below names the component to use.

### Which primitive style?

`Box`, `Sphere` and `Plane` are convenience components: one element gives a mesh with a standard material, and they take
the `Mesh` props plus `args`, `color`, `roughness` and `metalness`. `Mesh` with a geometry child and a material child is
the explicit form.

```tsx
import { BoxGeometry, Mesh } from '@margoengine/react';
import { Box } from '@margoengine/react/geometry';
import { MeshTransmissionMaterial } from '@margoengine/react/materials';

export function Both() {
  return (
    <>
      <Box args={[1, 1, 1]} color="#84d6bd" position={[-1, 0.5, 0]} />
      <Mesh position={[1, 0.5, 0]}>
        <BoxGeometry args={[1, 1, 1]} />
        <MeshTransmissionMaterial />
      </Mesh>
    </>
  );
}
```

Use `Box`, `Sphere` and `Plane` for floors, blocks and prototypes with a plain colour or one texture. Use `Mesh` with
children when you need a material component other than the standard one (as above).

### Every primitive

`@margoengine/react/geometry` has a one-element component and a geometry child for every builder in
`@margoengine/geometry`, under the names developers already search for: `Box`, `Sphere`, `Plane`,
`Cylinder`, `Cone`, `Capsule`, `Circle`, `Ring`, `Torus`, `TorusKnot`, `Tetrahedron`, `Octahedron`, `Icosahedron`,
`Dodecahedron`, `Polyhedron`, `Lathe`, `Tube`, `Shape`, `Extrude` and `RoundedBox`, and `CylinderGeometry`,
`TorusKnotGeometry`, `RoundedBoxGeometry` and the rest for a `<Mesh>` with its own material. `args` are the builder's
parameters in order, each with the builder's default (`Polyhedron`, `Tube`, `Shape` and `Extrude` need their first).
Numbers, arrays and plain objects in `args` count by value, so inline literals do not rebuild the geometry on every
render; a `Shape` or curve object counts by identity, so make it once (`useMemo`) and pass a new one to rebuild.

```tsx
import { useMemo } from 'react';
import { Mesh } from '@margoengine/react';
import { Cylinder, Extrude, Lathe, RoundedBox, TorusKnot, TorusKnotGeometry } from '@margoengine/react/geometry';
import { MeshTransmissionMaterial } from '@margoengine/react/materials';
import { Shape } from '@margoengine/geometry';

export function Primitives() {
  const star = useMemo(() => {
    const shape = new Shape();
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2,
        radius = i % 2 ? 0.2 : 0.5;
      if (i) shape.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
      else shape.moveTo(radius, 0);
    }
    return shape;
  }, []);
  return (
    <>
      <RoundedBox args={[1, 1, 1, 4, 0.15]} color="#84d6bd" position={[-3, 0.5, 0]} />
      <Cylinder args={[0.3, 0.5, 1, 32]} color="#e45630" position={[-1.5, 0.5, 0]} />
      <Lathe args={[[[0, 0], [0.4, 0.1], [0.3, 0.6], [0.1, 1]], 32]} color="#f2c14e" position={[0, 0, 0]} />
      <Extrude args={[star, { depth: 0.2 }]} color="#5b8def" position={[1.5, 0.5, 0]} />
      <TorusKnot args={[0.35, 0.1, 128, 16]} color="#c86bfa" position={[3, 0.5, 0]} />
      <Mesh position={[0, 0.5, -2]}>
        <TorusKnotGeometry args={[0.35, 0.1, 128, 16, 3, 5]} />
        <MeshTransmissionMaterial />
      </Mesh>
    </>
  );
}
```

### Extruded 3D text

`Text3D` from `@margoengine/react/text` extrudes its string children with a TTF or OTF font, as drei's Text3D does with a typeface JSON: `extrudeText` of `@margoengine/text/extrude` with `size`, `depth` (or drei's `height`), `curveSegments`, `bevelEnabled`, `bevelThickness`, `bevelSize`, `bevelOffset`, `bevelSegments`, `steps`, `letterSpacing`, `lineHeight`, `align` and font variations. `font` is a URL (fetched once per URL and shared by every Text3D using it), the font's bytes, parsed `FontOutlines` or a `FontLike`. Other children, such as a material, go inside the mesh; `color`, `roughness` and `metalness` are a shortcut for a plain one. `smooth` (drei's, a distance within which positions count as one) averages the normals around each position so the edges shade round, and `smoothAngle` (default 180) keeps faces further apart than that sharp. The geometry is rebuilt only when the text, the font or an option changes; `onBuild` gets its bounding box and a failed load goes to `onError`. Wrap it in `<Center>` to centre it.

```tsx
import { Canvas, PbrMaterial } from '@margoengine/react';
import { Text3D } from '@margoengine/react/text';

export function Title() {
  return (
    <Canvas>
      <Text3D font="/fonts/SourceSans3-Regular.ttf" size={0.6} height={0.15} bevelEnabled bevelSize={0.01} bevelThickness={0.01}>
        Margo
        <PbrMaterial color="#e0a96a" metalness={0.6} roughness={0.3} />
      </Text3D>
    </Canvas>
  );
}
```

### SVG drawings

`Svg` from `@margoengine/react/geometry` draws an SVG file as flat meshes, as drei's Svg: each path's fill and stroke is one mesh in a group, built by `parseSVG` of `@margoengine/loaders/svg` (install `@margoengine/loaders`), in the drawing's own units with y down (`flipY` turns it upright). `src` is a URL or SVG markup. Fills and strokes are unlit and transparent with their SVG colour and opacity, painted in document order; `fillMaterial` and `strokeMaterial` take any `@margoengine/materials` option over those defaults, `fillMeshProps` and `strokeMeshProps` go to every part's mesh, and `skipFill` and `skipStrokes` leave a kind out. `curveSegments` (default 12) and `strokeDivisions` (default 12) set how finely curves are cut. `onLoad` gets the parsed drawing with its viewBox and warnings; a failed load goes to `onError`. Gradients draw in their average colour and dashes solid. On the small WebGL2 preview (`backend: 'webgl2'`), which draws only core meshes with core's lit material, each part is a lit, opaque core mesh in its SVG colour (`color`, `roughness` and `metalness` of `fillMaterial` and `strokeMaterial` apply; opacity does not), and document order is kept by placing each later part a step nearer +z (1/1000 of the drawing's extent, the whole stack within 5% of it), so view it from +z there. On WebGPU and on the full WebGL2 compatibility layer it draws as described above.

```tsx
import { Canvas } from '@margoengine/react';
import { Svg } from '@margoengine/react/geometry';

const logo = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#e45630" stroke="#222222" stroke-width="6"/></svg>';

export function Logo() {
  return (
    <Canvas>
      <Svg src={logo} flipY scale={[0.02, 0.02, 0.02]} position={[-1, 1, 0]} />
    </Canvas>
  );
}
```

### Backdrop

`Backdrop` from `@margoengine/react/geometry` is drei's Backdrop: a studio cyclorama, a floor that bends up into a
wall with exact normals, built by `backdropGeometry` of `@margoengine/studio/backdrop` (install
`@margoengine/studio`). The floor's front edge is at +z and the wall at -z. Shape props, all optional: `width`
(default 8), `depth` (5), `height` (4), `radius` (the bend, 1; below depth and height) and `segments` (bend
subdivisions, 32). It receives shadows; `color` (default `'#b8b8b8'`) sets its matte default, and a material child
replaces that (UVs run across the width and along the sweep, so `TextureMaterial` maps fit it). Every Mesh prop applies.

```tsx
import { Canvas, PbrMaterial } from '@margoengine/react';
import { Backdrop, Sphere } from '@margoengine/react/geometry';
export function Studio() {
  return (
    <Canvas style={{ height: 400 }}>
      <Backdrop position={[0, -1, 0]} width={10} radius={1.5} segments={24}>
        <PbrMaterial color="#353540" roughness={0.9} />
      </Backdrop>
      <Sphere position={[0, 0, 0]} color="#d04040" />
    </Canvas>
  );
}
```

### MarchingCubes

`MarchingCubes`, `MarchingCube` and `MarchingPlane` from `@margoengine/react/marching-cubes` are drei's metaballs: a surface
of the `MarchingCube` balls and `MarchingPlane` planes inside, extracted by `marchingCubes` of
`@margoengine/procedural` (install it) over the mesh's -1..1 cube (scale the mesh to size it) and rebuilt only on
frames where a ball or plane changed. `MarchingCubes` takes the Mesh props plus `resolution` (grid samples per axis,
3..128, default 28), `isolation` (the surface's field value, default 80), `color` (its matte default, `'#ffffff'`,
which a material child replaces), `maxPolyCount` (most triangles kept, default 10000; the rest of an extraction is
dropped), `enableUvs` (default false: no uvs; true writes the vertex x and z mapped to 0..1) and `enableColors`
(default false: no vertex colours). These defaults are drei's. Each ball adds `strength / d^2 - subtract` where that is positive, `d` measured in
units of the cube's width: `position` (-1..1 on each axis, default the centre), `strength` (default 0.5) and
`subtract` (default 12), so a lone default ball has radius `2 * sqrt(0.5 / 92)`, about 0.15. `color` on a ball blends
into the vertex colours by field weight when `enableColors` is set (before 2026-11-16 they were always written when a
ball had a colour; add `enableColors` to keep them); a `TextureMaterial` child shows them. `MarchingPlane` adds the same field along
one low face: `planeType` `'x'` (default), `'y'` (a floor) or `'z'`. Refs are live handles: write `position`,
`strength`, `subtract` or `color` in place (in `useFrame`) and the surface follows. Normals are the field's exact gradient
at each vertex. Positions use the linear edge interpolation of marching cubes, so a ball spanning few cells comes out
larger than its exact radius (up to 7.3% for a lone default ball at resolution 28); raise `resolution` for a truer
shape. Sources: Lorensen and Cline, "Marching Cubes" (SIGGRAPH 1987); Wyvill, McPheeters and Wyvill, "Data
structure for soft objects" (The Visual Computer, 1986); drei's MarchingCubes docs. The falloff is drei's, not
Wyvill's zero-slope polynomial, so a ball's field ends with a kink in its slope ([limits](../../docs/limits.md)).

```tsx
import { useRef } from 'react';
import { Canvas, useFrame } from '@margoengine/react';
import { MarchingCube, MarchingCubes, MarchingPlane, type MarchingCubeHandle } from '@margoengine/react/marching-cubes';
import { TextureMaterial } from '@margoengine/react/textures';

function Blob() {
  const ball = useRef<MarchingCubeHandle>(null);
  useFrame(() => {
    if (ball.current) ball.current.position[0] = Math.sin((performance.now() / 1000) * 1.5) * 0.4;
  });
  return <MarchingCube ref={ball} strength={0.6} color="#e45630" />;
}
export function Lava() {
  return (
    <Canvas style={{ height: 400 }}>
      <MarchingCubes scale={[2, 2, 2]} resolution={40} enableColors>
        <Blob />
        <MarchingCube position={[0.2, 0.1, 0]} color="#f2c14e" />
        <MarchingPlane planeType="y" />
        <TextureMaterial color="#ffffff" roughness={0.4} />
      </MarchingCubes>
    </Canvas>
  );
}
```

### Caustics

`Caustics` from `@margoengine/react/caustics` is drei's: light focused through its transparent children onto a floor
beneath them, by the photon-traced catcher of `@margoengine/studio/caustics` (install `@margoengine/studio`). The
children's world triangles go into a GPU BVH; photons from the light refract in and out of them (`ior` 1.5,
`backsideIOR` = `ior`, `backside` true traces the exit and internal reflections, `maxEvents` 8) and land in a floor
map drawn on the floor. Floor: `floor` (its centre in world units, default the group's world position), `size` (4),
`height` of the emission plane above it (3). Light: `lightDirection` toward a distant source (default straight up,
`[0, 1, 0]`) or `lightPosition` for a point source. Quality: `photonSide` (128, squared photons per update),
`resolution` of the map (128), `frames` of updates (1; `Infinity` keeps tracing), `worldRadius`. Look: `intensity` (1)
and `color` (linear rgb, white). It re-traces when a child moves or changes, and an option change restarts the map.
`onReady` gets the native catcher (`readMap`, `stats`, `invalidate`). Every Mesh prop applies to the group. Needs
WebGPU or the WebGL2 compatibility layer.

```tsx
import { Canvas, Mesh } from '@margoengine/react';
import { Caustics } from '@margoengine/react/caustics';
import { SphereGeometry } from '@margoengine/react/geometry';
import { MeshTransmissionMaterial } from '@margoengine/react/materials';

export function Glass() {
  return (
    <Canvas style={{ height: 400 }}>
      <Caustics size={4} lightDirection={[0.3, 1, 0.2]} ior={1.5} intensity={1.5} frames={8}>
        <Mesh position={[0, 1, 0]}>
          <SphereGeometry args={[0.6, 48, 24]} />
          <MeshTransmissionMaterial />
        </Mesh>
      </Caustics>
    </Canvas>
  );
}
```

### AccumulativeShadows

`AccumulativeShadows` and `RandomizedLight` from `@margoengine/react/accumulative-shadows` are drei's: a ground plane
under the group that averages the shadows of every `castShadow` mesh and model in the Canvas (the binding adds them
itself, and follows them as they mount, unmount or are rebuilt) from its `RandomizedLight` children, so the shadows
get soft penumbrae from each light's disk plus sky occlusion. It is `AmbientShadows` of
`@margoengine/studio/accumulate-ambient` (install `@margoengine/studio`). The group's world position and up axis place
the plane. Props, with drei's defaults: `frames` (40; each frame takes every `amount` sample of every light, at most
1024 samples in all, then the plane holds; `Infinity` keeps sampling as a moving average over `blend` frames, 100, up
to `limit` frames, Infinity), `temporal` (false: every frame in the first rendered frame; true: one frame, every
light's `amount`, per rendered frame), `scale` (10, the plane side), `opacity` (1), `color` (black; hex, `[r, g, b]`
linear or `color(...)`), `colorBlend` (2, the scale of `color`), `toneMapped` (true: the plane colour is tone mapped
like a lit surface; false: clamped like unlit output), `alphaTest` (0.65: caster fragments with lower alpha, a glass
at opacity 0.3, cast nothing), `resolution` (1024). `RandomizedLight`: `position` (its direction from the group sets
the light, as drei's directional lights), `radius` (5, the jiggle at `position`), `amount` (8), `intensity` (1, the
weight against the other lights), `ambient` (0.5, the share of samples from the whole sky), `castShadow` (true) and
drei's shadow camera: `size` (10, half side of the window around the group; outside it the light casts nothing),
`mapSize` (512 texels across that window, filtered 2 x 2 as percentage-closer filtering), `near` (0.5) and `far` (500) from the light, and `bias` (0,
in normalized depth). The ref has drei's `getMesh()` (the group), `reset()` and `update(frames)` (restart for that
many frames), and `shadows` (the native catcher, also handed to `onReady`). Needs WebGPU or the WebGL2 compatibility layer.

```tsx
import { Canvas, Mesh, PbrMaterial } from '@margoengine/react';
import { SphereGeometry } from '@margoengine/react/geometry';
import { AccumulativeShadows, RandomizedLight } from '@margoengine/react/accumulative-shadows';

export function Product() {
  return (
    <Canvas style={{ height: 400 }}>
      <AccumulativeShadows temporal frames={100} scale={10} color="#316d39" colorBlend={0.5} opacity={0.8} alphaTest={0.9}>
        <RandomizedLight amount={8} radius={4} ambient={0.5} position={[5, 5, -10]} size={8} mapSize={1024} />
      </AccumulativeShadows>
      <Mesh castShadow position={[0, 0.5, 0]}>
        <SphereGeometry />
        <PbrMaterial color="#ffffff" />
      </Mesh>
    </Canvas>
  );
}
```

### Clouds

`Clouds` and `Cloud` from `@margoengine/react/clouds` are drei's: soft billboard clouds, every `<Cloud>` inside one
`<Clouds>` drawn back to front in a single instanced draw by `@margoengine/vfx/clouds` (install `@margoengine/vfx`).
`<Clouds>` takes `limit` (200 puffs), `range` (draw only the first ones), `texture` (a URL, fetched and decoded before
anything is drawn, pixels or an image; default a generated puff), `frustumCulled` (true), `material` (`'scatter'`,
the default, lights each puff by the light reaching it through the cloud; `'unlit'` draws the colour as it is),
`lightDirection`, `lightColor`, `ambient`, `density`, `fog` and `softness` (world units over which puffs fade into the
surfaces behind them; it adds the scene depth of `@margoengine/post/depth`). `<Cloud>` takes `seed`, `segments` (20),
`bounds` ([5, 1, 1]), `concentrate` (`'inside'`), `volume` (6), `smallestVolume` (0.25), `distribute`, `growth` (4),
`speed` (0), `fade` (10), `opacity` (1) and `color` (white). A Cloud with no seed keeps one shape for its place in the
tree; a Cloud outside any Clouds makes its own. Every Mesh prop (position, rotation, scale) applies to the group;
`onReady` on Clouds gets the native `Clouds`. Needs WebGPU or the WebGL2 compatibility layer.

```tsx
import { Canvas } from '@margoengine/react';
import { Cloud, Clouds } from '@margoengine/react/clouds';

export function Sky() {
  return (
    <Canvas style={{ height: 400 }} camera={{ position: [0, 2, 18], target: [0, 4, 0] }}>
      <Clouds limit={400} lightDirection={[0.4, 1, 0.3]}>
        <Cloud seed={1} segments={40} bounds={[10, 2, 2]} volume={8} position={[0, 5, -4]} speed={0.2} />
        <Cloud seed={2} segments={20} bounds={[6, 1, 1]} volume={5} color="#ffd9c4" position={[-6, 3, 0]} />
      </Clouds>
    </Canvas>
  );
}
```

### Outlines

`Outlines` from `@margoengine/react/outlines` is drei's: an inverted-hull outline around the enclosing mesh, drawn by
`MeshOutline` of `@margoengine/toon/outline` (install `@margoengine/toon`). Props, with drei's defaults: `color`
(`#rgb`/`#rrggbb` or linear rgb numbers, black), `thickness` (0.05 world units; drawing-buffer pixels with
`screenspace`), `screenspace` (false: the line keeps its pixel width at every distance and zoom), `opacity` (1, used
when `transparent`), `transparent` (false), `toneMapped` (true: the colour is tone mapped like a lit surface),
`polygonOffset` and `polygonOffsetFactor` (false, 0: push the hull's depth back by its slope), `renderOrder` (0, draw
order among outlines) and `angle` (the crease angle, pi: copies of a vertex whose normals differ by less are averaged,
so pi closes the hull over hard edges and 0 lets it part at every crease). It follows the mesh's transform, geometry
and visibility, and a mirrored scale. Inside `<Instances>` (drei's instancedMesh parent) every drawn instance gets its
own outline, following instances as they mount, unmount, hide or pass `limit`. `onReady` gets each native outline. Needs WebGPU or the WebGL2 compatibility
layer. Instanced and skinned parents are not outlined yet (docs/known-bugs.md); a loaded model takes
`ModelOutlines` of `@margoengine/toon/models`.

```tsx
import { Canvas } from '@margoengine/react';
import { Box } from '@margoengine/react/geometry';
import { Outlines } from '@margoengine/react/outlines';

export function Outlined() {
  return (
    <Canvas style={{ height: 400 }}>
      <Box args={[1, 1, 1]}>
        <Outlines thickness={4} screenspace color="#1d4ed8" />
      </Box>
    </Canvas>
  );
}
```

### Mask

`Mask` and `useMask` from `@margoengine/react/materials` are drei's: the `Mask`'s geometry child writes its `id` (an
integer 1..255) into the stencil buffer where it covers the screen, invisible by default (`colorWrite` and
`depthWrite` default to false), and draws before the other material meshes. `useMask(id)` returns the stencil options
that limit a `TextureMaterial` to the inside of that mask; `useMask(id, true)` limits it to the outside. The stencil
buffer of `@margoengine/materials` (install it) is attached while a `Mask` is mounted. WebGPU and the WebGL2
compatibility layer.

```tsx
import { Canvas, Mesh } from '@margoengine/react';
import { CircleGeometry, PlaneGeometry } from '@margoengine/react/geometry';
import { Mask, useMask } from '@margoengine/react/materials';
import { TextureMaterial } from '@margoengine/react/textures';

function Picture() {
  const stencil = useMask(1);
  return (
    <Mesh position={[0, 0, -0.5]}>
      <PlaneGeometry args={[4, 4]} />
      <TextureMaterial color="#e45630" {...stencil} />
    </Mesh>
  );
}
export function Porthole() {
  return (
    <Canvas style={{ height: 400 }}>
      <Mask id={1}>
        <CircleGeometry args={[1, 64]} />
      </Mask>
      <Picture />
    </Canvas>
  );
}
```

### Textured Box, Sphere and Plane

`map` gives `Box`, `Sphere` and `Plane` a base colour texture on the shape's own UVs: a URL, fetched through the Canvas
asset cache so `useProgress` counts it, or the PNG or JPEG bytes (`ArrayBuffer`, a typed array or a `Blob`). The map is
multiplied by `color`, which is white when a map is set. Install the optional peer `@margoengine/gltf` (npm i
@margoengine/gltf): the shape is built as a one-primitive glTF in memory and drawn by its `textured` entry, so it stays a
core mesh that moves, picks and casts shadows with the component.

```tsx
import { Canvas } from '@margoengine/react';
import { Box, Plane } from '@margoengine/react/geometry';

export function Crates() {
  return (
    <Canvas style={{ height: 400 }}>
      <Plane args={[10, 10]} rotation={[-Math.PI / 2, 0, 0]} map="/textures/floor.jpg" />
      <Box position={[0, 0.5, 0]} map="/textures/crate.png" roughness={0.8} onClick={() => console.log('crate')} />
    </Canvas>
  );
}
```

| Prop | Default | Effect |
| --- | --- | --- |
| `map` | none | PNG or JPEG: a URL or the bytes. A new value rebuilds the shape. |
| `color` | `'#ffffff'` with a map | Multiplies the map. |

For maps in a named `Scene`, wrap its meshes in `TextureProvider` from `/textures`, as below.
That path uses native materials on WebGPU and the WebGL2 compatibility device. Without that provider the
legacy convenience-shape path uses `@margoengine/gltf/textured`, requires WebGPU and the default Scene,
and accepts PNG/JPEG base colour only. Pointer `target` is the drawn child mesh and `currentTarget` the component mesh.

### Pointer events and picking

Pointer handlers on `Mesh`, `Model`, `Box`, `Sphere`, `Plane`, `RigidBody`, `TransformControls` and the XR
`Controller` come from GPU picking, not from the DOM: `onClick`, `onDoubleClick`, `onContextMenu`, `onPointerDown`,
`onPointerUp`, `onPointerMove`, `onPointerOver`, `onPointerOut`, `onPointerEnter`, `onPointerLeave`, `onWheel` and
`onPointerMissed`. The Canvas takes `onPointerMissed` too. These rules come from the code in `src/events.ts` and apply to
every handler:

- **Picking is asynchronous.** The pointer event asks the GPU which mesh is under the pixel, and the handler runs after
  the answer, a frame or two later. Code and tests that read the state your handler sets must wait for it. Presses,
  releases and clicks keep their order. A burst of moves, or of wheel turns, collapses to the latest one.
- **The mesh in front gets the event.** If two meshes overlap under the pointer, the one drawn nearest the camera is
  hit. A child that overlaps its parent wins over the parent. A mesh in front with no handlers still takes the hit, and
  the event bubbles from it.
- **Events bubble, as DOM events do.** The event goes to the hit mesh, then to each parent `Mesh`, `Group` or model
  with handlers, until a handler calls `event.stopPropagation()`. `target` is the hit mesh, `currentTarget` (also
  `eventObject`) the mesh whose handler runs; inside a model it is the model's root, and the model hears an event once.
  `onPointerOver` and `onPointerOut` bubble. `onPointerEnter` and `onPointerLeave` do not: they fire once on each mesh
  the pointer comes into or leaves, counting the meshes below it, so moving between two children of a group gives the
  group out and over, never leave and enter.
- **A click goes to what the press and the release both hit**: the nearest mesh both hit, or their nearest shared
  parent, with the release's hit as `target`. It needs the pointer to move no more than 3 CSS pixels between press and
  release (an orbit drag is not a click), and only the primary button counts. `onPointerMissed` on a mesh fires for a
  click that did not reach it; on the Canvas, for a click that hit no mesh.
- **Pointer capture.** `event.setPointerCapture()` in `onPointerDown` sends the pointer's later events to that mesh
  without picking, until the release or `event.releasePointerCapture()`, as for a drag handle.
- **On the WebGL2 fallback.** Handlers fire when the engine has `webglPicking`, and the plain way to give it that is
  `<Canvas loadFallback={() => import('margoengine/webgl2-compat/pick')}>`: that entry holds the renderer and the picking. With a
  `fallback` prop, attach it yourself in `onCreated`. Only core meshes are picked there. Without it no handler fires,
  and nothing counts as missed: in development the Canvas prints one `MargoError` (code `unsupported`) the first time a
  handler is registered, and nothing in a production build.
- **Handlers get** `type` (the DOM event name), `nativeEvent`, `object` (also `mesh` and `target`: the hit mesh),
  `currentTarget` and `eventObject`, `x` and `y` (canvas pixels), `clientX` and `clientY`, `delta` (CSS pixels moved
  since the press), `stopPropagation()`, `stopped`, and `setPointerCapture()`, `releasePointerCapture()` and
  `hasPointerCapture()`.

A group that hears the clicks of its parts, a part that keeps its own, and a click on empty space:

```tsx
import { useState } from 'react';
import { Canvas, Mesh } from '@margoengine/react';
import { Box, Sphere } from '@margoengine/react/geometry';

export function Bubbling() {
  const [log, setLog] = useState('nothing yet');
  return (
    <>
      <p>{log}</p>
      <Canvas style={{ height: 400 }} onPointerMissed={() => setLog('missed')}>
        <Mesh onClick={(event) => setLog(event.target === event.currentTarget ? "the group itself" : "group heard a click on a part")}>
          <Box position={[-1, 0, 0]} />
          <Sphere
            position={[1, 0, 0]}
            onClick={(event) => {
              event.stopPropagation();
              setLog('the sphere kept its click');
            }}
          />
        </Mesh>
      </Canvas>
    </>
  );
}
```

In a Playwright test, click and then wait for the state. This standalone Node test writes a small React app,
serves it on a free port and removes it afterwards. Install `vite` and `@playwright/test` as development dependencies
and install Playwright's Chromium browser first (`node node_modules/playwright/cli.js install chromium`).
Run it from your project folder, where `react`, `react-dom` and `@margoengine/react` are installed:
`BROWSER_CHANNEL`, `BROWSER_EXECUTABLE` and a JSON `BROWSER_ARGS` array can select your installed browser and GPU.

```ts
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const folder = mkdtempSync(join(process.cwd(), '.margo-picking-'));
writeFileSync(join(folder, 'index.html'), '<div id="root"></div><script type="module" src="/app.tsx"></script>');
writeFileSync(join(folder, 'app.tsx'), `
  import { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { Canvas, Mesh, BoxGeometry, PbrMaterial } from '@margoengine/react';
  function App() {
    const [selected, select] = useState('nothing yet');
    return <>
      <p id="selected">{selected}</p>
      <Canvas style={{width: 320, height: 240}} camera={{position: [0, 0, 5]}}
        onCreated={stage => {
          let frames = 0;
          stage.engine.onFrame(() => {
            if (++frames === 3) document.querySelector('canvas')!.dataset.ready = 'true';
          });
        }}>
        <Mesh onClick={() => select('crate')}>
          <BoxGeometry />
          <PbrMaterial color="#84d6bd" />
        </Mesh>
      </Canvas>
    </>;
  }
  createRoot(document.getElementById('root')!).render(<App />);
`);
const server = await createServer({
  root: folder, configFile: false, logLevel: 'error',
  oxc: {jsx: {runtime: 'automatic'}},
  optimizeDeps: {include: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']},
  server: {host: '127.0.0.1', port: 0},
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL,
    executablePath: process.env.BROWSER_EXECUTABLE,
    args: JSON.parse(process.env.BROWSER_ARGS ?? '["--enable-unsafe-webgpu"]'),
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0]);
  await page.waitForFunction(() => document.querySelector('canvas[data-ready="true"], [role="alert"]'));
  const alert = await page.evaluate(() => document.querySelector('[role="alert"]')?.textContent);
  if (alert) throw new Error(alert);
  await page.locator('canvas').click({position: {x: 160, y: 120}});
  await page.waitForFunction(() => document.querySelector('#selected')!.textContent === 'crate');
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser?.close();
  await server.close();
  rmSync(folder, {recursive: true, force: true});
}
```

## Models and environment

A model, its lighting and the orbit controls, directly under the canvas:

```tsx
'use client';
import { Suspense } from 'react';
import { MargoCanvas, Environment, OrbitControls, Shadows } from 'margoengine/react';
import { Model } from 'margoengine/react/gltf';

export default function App() {
  return <MargoCanvas backend="webgpu" camera={{ position: [0, 2, 5] }} style={{ height: 400 }}>
    <Shadows />
    <Suspense fallback={<span>Loading sceneâ€¦</span>}>
      <Model src="/model.glb" position={[0, 0, 0]} materials={{ Upper: { baseColor: [0.52, 0.84, 0.74] } }} castShadow receiveShadow />
      <Environment src="/studio.hdr" exposure={1} background />
    </Suspense>
    <OrbitControls enableDamping minDistance={1} maxDistance={20} />
  </MargoCanvas>;
}
```

`Model` loads glTF/GLB through `@margoengine/gltf/pbr`. Position, Euler rotation (radians), scale and named material overrides update the existing model; removing an override restores the loaded material. Supported shallow overrides are `baseColor` (linear RGB or RGBA), `roughness`, `metalness`, `emissive`, `normalScale`, `occlusionStrength`, `alphaCutoff` and `doubleSided`. `onLoad(mesh)` receives the model's root mesh after initial props have been applied. Only changing `src` selects another asset. Unmount unregisters lighting and shadows and disposes the instance's PBR plugin, meshes, textures and buffers.

Wrap `Model` and file-backed `Environment` components in React `Suspense` to show a fallback while loading. Loads begin after the first commit so unmount cleanup can abort an unfinished load. The canvas caches pending promises and resolved CPU source data by URL; concurrent mounts and remounts reuse that source while owning independent model transforms, materials and disposable GPU resources. The last pending consumer unmount aborts its request. Canvas teardown releases the cache. Load failures reach the component's optional `onError` and the canvas's `onError`/accessible alert.

`Model.preload(src)` (also `Gltf.preload`), `Fbx.preload(src)` and `Environment.preload(src)` warm the same cache on active canvases; each belongs to the component that loads that kind of file, so a page that preloads only models never reaches the FBX or environment loaders. Before a canvas is ready, the returned promise queues until an engine exists, since the optional glTF loader requires an engine. Render the canvas before awaiting a queued preload. A preloaded asset remains hidden until mounted.

`Environment` loads HDR/EXR through `@margoengine/environment` and attaches diffuse/specular IBL to sibling `Model` components, regardless of loading order. Exposure is a nonnegative linear lighting multiplier; it also controls HDR background intensity. `background` defaults to true and only affects an HDR background. Without `src` and without children, the component configures neutral studio directional and ambient lighting; teardown restores the previous lighting. Exposure and background changes do not reload the map. Use one `Environment` per canvas.

`Html` dynamically imports optional `@margoengine/html` and `react-dom` peers and projects React DOM children into a shared overlay. Nested inside a `Mesh` or `Group`, its `position` is a local offset; otherwise it is a world position. It accepts `className`, `style`, and an `occlude` boolean (true by default), and removes its label and overlay resources on unmount.

`<Shadows />` (`margoengine/react/shadows`, or `@margoengine/react/shadows` with `@margoengine/shadows` installed) turns the canvas shadows on; mesh and model casting and receiving are independently opt-in and draw nothing without it. PBR models, HDR IBL and shadows require WebGPU; legacy meshes and neutral studio lighting support the WebGL fallback.

Add `<BakeShadows />` from the same entry for a scene that does not move, as drei's: while it is mounted every caster
(meshes, shapes, models and batches with `castShadow`) is a static caster, drawn into the shadow map once instead of
every frame. A caster that moves later keeps its old shadow; the map still redraws when the cascades follow the camera
or the light turns. Unmount it to make the casters dynamic again.

```tsx
import {Canvas} from '@margoengine/react';
import {BakeShadows, Shadows} from '@margoengine/react/shadows';
import {Box, Plane} from '@margoengine/react/geometry';

export function StillLife() {
  return (
    <Canvas>
      <Shadows />
      <BakeShadows />
      <Box castShadow position={[0, 0.5, 0]} />
      <Plane rotation={[-Math.PI / 2, 0, 0]} scale={[10, 10, 1]} />
    </Canvas>
  );
}
```

### CubeCamera reflections

`<CubeCamera>` (from `@margoengine/react/environment`, with `@margoengine/environment` installed) renders the scene
around its position into a cube texture every frame, as drei's, and hands it to its children, a render function, for
a material's `envMap`. What the children draw is left out of the cube, so a mirror ball reflects the room and not its
own inside. `resolution` (default 256, a power of two from 8 to 2048), `near` (0.1), `far` (1000), `frames` (default
`Infinity`; `frames={1}` captures once for a still scene), `mips` (default false; a box-filtered mip chain for rough
materials), `layers` and the group props `position`, `rotation` and `scale` set it up. `PbrMaterial` and
`MappedPbrMaterial` take `envMap` (a six-layer GPUTexture such as this one, a cube Texture, an Environment or a cube
render target) and `envMapIntensity` (default 1); like the maps, `envMap` needs `TextureProvider` or
`MappedPbrMaterial`. WebGPU and the WebGL2 compatibility layer.

As in drei, `envMap` and `fog` change what the faces see while the main view keeps its own. `envMap` (an .hdr or .exr,
loaded through the Canvas cache like `<Environment src>`; default none) is drawn as the faces' background in place of
the scene's; the faces wait for it to load, so `frames={1}` never captures without it. `fog` (`<Fog>`'s options, each
left-out option at its `<Fog>` default, or `false` for no fog; default the scene's fog) replaces the scene's `<Fog>`
in the faces only; with no `<Fog>` in the scene the CubeCamera keeps a private fog that is off in the main view. An
Environment-only app does not pay for CubeCamera: with the package's `sideEffects: false`, importing `Environment`
alone bundles 2,304 B gzip against 5,507 B for the whole entry.

```tsx
import { Canvas, Mesh } from '@margoengine/react';
import { CubeCamera, Fog } from '@margoengine/react/environment';
import { SphereGeometry } from '@margoengine/react/geometry';
import { MappedPbrMaterial } from '@margoengine/react/textures';

export function ChromeInFog() {
  return (
    <Canvas backend="webgpu">
      <Fog color="#c0d0e0" near={5} far={30} />
      <CubeCamera envMap="/sky.hdr" fog={{ color: '#ffffff', near: 2, far: 10 }}>
        {(texture) => (
          <Mesh>
            <SphereGeometry args={[1, 64, 32]} />
            <MappedPbrMaterial metalness={1} roughness={0} envMap={texture} />
          </Mesh>
        )}
      </CubeCamera>
    </Canvas>
  );
}
```

```tsx
import { Canvas, Mesh } from '@margoengine/react';
import { CubeCamera } from '@margoengine/react/environment';
import { Box, SphereGeometry } from '@margoengine/react/geometry';
import { MappedPbrMaterial } from '@margoengine/react/textures';

export function MirrorBall() {
  return (
    <Canvas backend="webgpu">
      <Box position={[2, 0, 0]} />
      <CubeCamera resolution={256} position={[0, 1, 0]}>
        {(texture) => (
          <Mesh>
            <SphereGeometry args={[1, 64, 32]} />
            <MappedPbrMaterial metalness={1} roughness={0} envMap={texture} />
          </Mesh>
        )}
      </CubeCamera>
    </Canvas>
  );
}
```

### Lightformer and Environment children

As in drei, `<Environment>` takes children: they are drawn into a cube around the Environment's origin, over its `src`
environment (or black without one), and that cube becomes the environment the scene is lit by and shows as its
background; the children themselves are hidden in the main view. `resolution` (default 256, a power of two from 8 to
2048), `frames` (default 1, captured once; `Infinity` for every frame, a positive integer for that many), `near` (1)
and `far` (1000) set the capture. A capture waits until every `<Lightformer>` inside has attached, so `frames={1}`
never misses one; later captures refresh the environment in place. The capture code loads on demand, the first time
an `<Environment>` has children, so an app without them does not download it.

`<Lightformer>` (also from `@margoengine/react/environment`) is a studio light card: `form` (`'rect'` 1 x 1, the
default, `'circle'` 1 across, `'ring'` 1 across with its inner half open, or `'box'` 1 x 1 x 1), `intensity` (default
1; it emits `color x intensity`, unlit), `color` (default white), `scale` (a number, `[width, height]` or `[x, y, z]`;
default 1), `position`, `rotation` and `target` (a point in the same space as `position` that the card's front turns
to face, up kept toward +Y; it replaces `rotation`). Outside an `<Environment>` it is drawn in the main view as a
bright unlit shape. WebGPU and the WebGL2 compatibility layer.

```tsx
import { Canvas, Mesh } from '@margoengine/react';
import { Environment, Lightformer } from '@margoengine/react/environment';
import { SphereGeometry } from '@margoengine/react/geometry';
import { MappedPbrMaterial } from '@margoengine/react/textures';

export function StudioBall() {
  return (
    <Canvas backend="webgpu">
      <Environment resolution={256}>
        <Lightformer form="rect" intensity={4} position={[0, 5, -2]} scale={[10, 2]} target={[0, 0, 0]} />
        <Lightformer form="ring" intensity={2} color="#ffd0a0" position={[-5, 1, 2]} scale={3} target={[0, 0, 0]} />
        <Lightformer form="circle" intensity={1} position={[5, 1, 2]} scale={2} target={[0, 0, 0]} />
      </Environment>
      <Mesh>
        <SphereGeometry />
        <MappedPbrMaterial color="#ffffff" roughness={0.15} metalness={1} />
      </Mesh>
    </Canvas>
  );
}
```

### MeshReflectorMaterial

`<MeshReflectorMaterial>` (from `@margoengine/react/materials`, with `@margoengine/environment` installed) is drei's
reflective floor: the mesh keeps its own lit `PbrMaterial` (it takes the same props: `color`, `roughness`,
`metalness`, the maps, `envMap`) and a planar reflection is drawn over it. The weight is the Fresnel reflectance of the
material (0.04 for a dielectric, its colour for a metal), raised toward 1 by `mirror` (0 to 1, default 0), times
`mixStrength` (default 1), clamped to 1. `blur` (one number or [x, y], in capture pixels; default 0) box-blurs the
reflection and `mixBlur` (default 1) times `roughness` sets how much of the blur shows. `depthScale` (default 0, off)
fades and blurs the reflection with a reflected point's distance from the plane, from `minDepthThreshold` (0.9) to
`maxDepthThreshold` (1), with `depthToBlurRatioBias` (0.25) of blur kept at the contact; depth is distance times
`depthScale` in world units, not drei's depth-buffer value. `mixContrast` (1), `reflectorOffset` (0, moves the mirror
plane along the normal), `distortion` (0.03, screen fraction per unit) with `distortionMap` (a normal map:
`(device) => GPUTexture`, made again after a device restore, a GPUTexture, dropped and reported once after a
restore, or RGBA8 pixels), `resolution` (capture pixels along the canvas's longer side, 8 to 4096, default 256) and `layers`
complete it. The geometry must be flat in the mesh's local XY plane, as `<PlaneGeometry>` is; turn the mesh to lay it
down. WebGPU and the WebGL2 compatibility layer.

```tsx
import { BoxGeometry, Canvas, Mesh } from '@margoengine/react';
import { PlaneGeometry } from '@margoengine/react/geometry';
import { MeshReflectorMaterial } from '@margoengine/react/materials';

export function ShinyFloor() {
  return (
    <Canvas backend="webgpu" camera={{ position: [0, 2, 6] }}>
      <Mesh position={[0, 0.5, 0]}>
        <BoxGeometry />
      </Mesh>
      <Mesh rotation={[-Math.PI / 2, 0, 0]}>
        <PlaneGeometry args={[20, 20]} />
        <MeshReflectorMaterial color="#202020" roughness={1} resolution={1024} blur={[300, 100]} mixStrength={2} depthScale={1} />
      </Mesh>
    </Canvas>
  );
}
```

## Batching, views, lights and voxels

`<BatchedMesh maxItems maxVertices>` draws many different geometries in one draw call per pass; put a `<BatchedItem geometry position rotation scale color visible>` (or `matrix`) per object inside. Moving, tinting or hiding an item updates the batch in place with no React render of the batch; capacity and `material` are fixed. `<DepthTexture>` and `<SceneTargets outputs={{ albedo: 'albedo', normal: 'normal' }}>` render the scene's depth or several targets in one pass for your own shaders; their ref is the live plugin (`depth.texture`, `targets.texture('normal')`), and the Canvas's PBR models are added for you. All three need WebGPU.

```tsx
import { Canvas } from '@margoengine/react';
import { BatchedMesh, BatchedItem } from '@margoengine/react/materials';
import { boxGeometry } from '@margoengine/geometry';

const cube = boxGeometry();
export function Crates({ count }: { count: number }) {
  return (
    <Canvas>
      <BatchedMesh maxItems={count} maxVertices={count * 24}>
        {Array.from({ length: count }, (_, i) => (
          <BatchedItem key={i} geometry={cube} position={[i * 1.5, 0, 0]} color={i % 2 ? '#84d6bd' : '#e45630'} />
        ))}
      </BatchedMesh>
    </Canvas>
  );
}
```

`<RenderView>` draws the Canvas through a camera into part of it (split screen, a four-view layout, a minimap) or into a texture: `camera` (a core `Camera`; default the Canvas camera), `viewport` (fractions from the top left), `scissor`, `clear`, `layers`, `target`, `id` and `order`. With one or more views the Canvas draws only those; picking follows the view under the pointer. `<Scene name>` holds meshes drawn only by the views that name it (`<RenderView scene="hud">`), such as a HUD overlay or an item preview; `background={null}` keeps what is below. `<Mesh layers={mask}>` (a `layerMask(...)` from `@margoengine/cameras/layers`) limits which views draw a mesh. Views and scenes work on WebGPU and WebGL2.

```tsx
import { Camera } from '@margoengine/core';
import { Canvas, RenderView, Scene } from '@margoengine/react';
import { Box } from '@margoengine/react/geometry';

const top = new Camera({ position: [0, 20, 0.01], target: [0, 0, 0] });
export function SplitScreen() {
  return (
    <Canvas>
      <RenderView viewport={[0, 0, 0.5, 1]} />
      <RenderView viewport={[0.5, 0, 0.5, 1]} camera={top} />
      <RenderView viewport={[0.75, 0.75, 0.25, 0.25]} scene="hud" order={1} clear={{ color: false }} />
      <Box castShadow />
      <Scene name="hud" background={null}>
        <Box color="#e45630" />
      </Scene>
    </Canvas>
  );
}
```

Lights: `<Sun direction color intensity>` sets the directional sun light every mesh, model and shadow uses (any backend; inside a `<Scene>`, that scene's). `<AmbientLight color intensity>` and `<HemisphereLight sky ground intensity>` light core meshes and models from every direction, and `<Fog color near far density heightFalloff height>` fogs them in their shaders, transparent models included; all three come from `@margoengine/environment`, take live props and need WebGPU. Inside a `<Scene>` they light and fog that scene's meshes only. `<Environment>` also takes `rotation` (radians about +Y, lighting and background together) and `blur` (background, 0 to 1). `<Html>` takes the label options `anchor`, `distanceScale`, `sort`, `frustumCulling`, `followVisibility`, `visible` and `pointerEvents`, all live.

```tsx
import { Canvas, Sun } from '@margoengine/react';
import { HemisphereLight, Fog } from '@margoengine/react/environment';
import { Model } from '@margoengine/react/gltf';

export function Valley() {
  return (
    <Canvas>
      <Sun direction={[1, 2, 1]} color="#fff4e0" intensity={3} />
      <HemisphereLight sky="#bcd8ff" ground="#5a4a3a" intensity={0.6} />
      <Fog color="#bcd8ff" near={20} far={120} />
      <Model src="/valley.glb" />
    </Canvas>
  );
}
```

`<Voxels world textures>` draws a `VoxelWorld` from `@margoengine/voxel`: chunks are meshed in workers and lit by `@margoengine/voxel/light` (on by default, updated from the Canvas frame loop). Edit the world with `world.setBlock` and the change shows two frames later with no React render; `daylight`, `blockLightColor` and `lightmap` are live. `useBlockTextures(urls)` loads the block textures, one layer per URL, and suspends until they are ready. Needs WebGPU and Web Workers.

```tsx
import { Suspense, useMemo } from 'react';
import { BlockTypes, VoxelWorld } from '@margoengine/voxel';
import { Canvas } from '@margoengine/react';
import { Voxels, useBlockTextures } from '@margoengine/react/voxel';

function Island() {
  const textures = useBlockTextures(['/stone.png', '/grass-top.png']);
  const world = useMemo(() => {
    const blocks = new BlockTypes(),
      stone = blocks.define('stone'),
      island = new VoxelWorld({ blocks });
    for (let x = -8; x < 8; x++) for (let z = -8; z < 8; z++) island.setBlock(x, 64, z, stone);
    return island;
  }, []);
  return <Voxels world={world} textures={textures} daylight={0.8} />;
}
export function Game() {
  return (
    <Canvas camera={{ position: [12, 72, 12], target: [0, 64, 0] }}>
      <Suspense fallback={null}>
        <Island />
      </Suspense>
    </Canvas>
  );
}
```

## Hooks

`Canvas` remains an alias for `MargoCanvas`; existing geometry components and mesh refs remain available. `useMargo()` returns `{ stage, ready, canvas, camera, size, gl, clock, invalidate }`. `camera` and `gl` are the stage's camera and engine; `size` reads the canvas client width and height; `clock` is elapsed frame time in seconds as a number. `onCreated(stage)` receives the existing `Stage` facade from `margoengine` after sizing and camera setup, before rendering starts.

With `<Canvas frameloop="demand">`, the engine does not start an animation loop. Each `invalidate()` call advances `useFrame` and OrbitControls and renders exactly one frame. The default `frameloop="always"` renders continuously. Read `clock` from the hook value when needed; its getter advances without causing React renders.

`useMargoStage()` retains its existing portable `EngineKernel` return value (`createMesh`, `camera`, frame callbacks and plugins). Children mount after asynchronous stage creation. Hooks outside the provider throw. Use an effect to create imperative objects and return their disposal function:

```tsx
import { useEffect } from 'react';
import { box, PbrMaterial as Material } from 'margoengine/core';
import { useMargoStage } from 'margoengine/react';

function ImperativeCube() {
  const engine = useMargoStage();
  useEffect(() => {
    const mesh = engine.createMesh();
    mesh.setGeometry(box()).setMaterial(new Material({ color: '#84d6bd' }));
    return () => mesh.dispose();
  }, [engine]);
  return null;
}
```

## UI, audio, 2D sprites and charts

`@margoengine/react/ui` binds four packages to the Canvas engine. Each loads its package when it mounts, so install
only the ones you use (`@margoengine/ui`, `@margoengine/audio`, `@margoengine/sprites`, `@margoengine/sciviz`).

- **`GameUi`** is `UiRoot` of `@margoengine/ui/react` with the Canvas engine filled in. Nest that package's widgets
  (`Panel`, `Label`, `Button`, `HealthBar`, `Inventory`, ...) inside; they draw on the canvas.
- **`Sound`** plays a URL or an `AudioBuffer` through one `AudioListener` per Canvas, which follows the camera. Inside a
  `<Mesh>` it is positional and moves with the mesh. `playing` (default true) plays and pauses; `volume`, `loop`,
  `playbackRate`, `refDistance`, `maxDistance`, `rolloffFactor` and `distanceModel` update in place. Browsers start
  audio after the first click or key press. The ref is the `Audio`.
- **`SpriteLayer`** and **`Sprite`** draw 2D sprites at exact pixels: the layer takes the `@margoengine/sprites`
  options (`atlas` swaps in place; `camera`, `snap` and `ySort` are live), each `Sprite` its fields (`x`, `y`, `rect`,
  `tint`, `flipX`, ...), updated in place.
- **`Figure`** with **`ScatterPlot`**, **`LinePlot`** and **`SurfacePlot`** draws a `@margoengine/sciviz` figure with
  the Canvas camera. Options are compared by value; a new `data` (or `z`) object rebuilds its layer, so keep it in
  `useMemo` or state. `onReady` fires once axes and labels are drawn. WebGPU only.

```tsx
import { useMemo } from 'react';
import { BoxGeometry, Canvas, Mesh } from '@margoengine/react';
import { Figure, GameUi, ScatterPlot, Sound, Sprite, SpriteLayer } from '@margoengine/react/ui';
import { HealthBar, Panel } from '@margoengine/ui/react';

const atlas = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]) };

export function Everything({ hp }: { hp: number }) {
  const points = useMemo(() => ({ x: [0, 1, 2], y: [2, 0, 1], z: [0, 1, 2] }), []);
  return (
    <Canvas style={{ height: 400 }}>
      <GameUi>
        <Panel anchor="top-left" margin={16} padding={8}>
          <HealthBar value={hp} max={100} width={200} />
        </Panel>
      </GameUi>
      <Mesh position={[2, 0, 0]}>
        <BoxGeometry />
        <Sound src="/sounds/engine.ogg" loop refDistance={2} />
      </Mesh>
      <SpriteLayer atlas={atlas}>
        <Sprite x={16} y={16} rect={[0, 0, 1, 1]} scaleX={32} scaleY={32} />
      </SpriteLayer>
      <Figure titles={{ x: 'x', y: 'y', z: 'z' }}>
        <ScatterPlot data={points} options={{ size: 4 }} />
      </Figure>
    </Canvas>
  );
}
```

`<SoftShadows />` from the same entry is drei's SoftShadows: percentage-closer soft shadows (Fernando 2005) whose
penumbrae are sharp where a caster touches the ground and widen with the distance between them. It turns the shadows on
as `<Shadows>` does, with the `'soft'` filter, and maps drei's props: `size` (default 25) is the light size, Shadows'
`lightSize` being `size / 1250` so 25 is Shadows' own 0.02; `samples` (default 10, 1 to 128) is both the comparison
taps and the blocker-search reads per lit pixel; `focus` (default 0) is the caster-to-receiver distance, world units,
at which the shadow is sharpest. Every prop is live, and unmounting restores the options it set.

```tsx
import {Canvas} from '@margoengine/react';
import {SoftShadows} from '@margoengine/react/shadows';
import {Box, Plane} from '@margoengine/react/geometry';

export function SoftScene() {
  return (
    <Canvas>
      <SoftShadows size={40} samples={16} focus={0.2} />
      <Box castShadow position={[0, 1, 0]} />
      <Plane rotation={[-Math.PI / 2, 0, 0]} scale={[10, 10, 1]} />
    </Canvas>
  );
}
```

A component outside its parent (`Sprite` outside `SpriteLayer`, a plot outside `Figure`, a positional `Sound` outside a
`Mesh`) throws a `MargoError` (code `state`) that names the parent to add.

## Controls

`OrbitControls`, `MapControls`, `CadControls`, `CameraControls` and `ArcballControls` bind the active camera and canvas, update from the Canvas frame loop (so `frameloop="demand"` and `invalidate()` move them too), and remove their listeners on unmount. Every public field of the controls is a prop (`enableDamping`, `dampingFactor`, `rotateSpeed`, `zoomToCursor`, `minDistance`, `maxPolarAngle`, ...); a prop removed again restores the controls' default. `target` sets the orbit point when it changes. `onChange`, `onStart` and `onEnd` receive the controls' events, and the ref is the live controls object. `CadControls` navigates like a CAD tool: `profile` is `'margo'` (default), `'solidworks'`, `'autocad'`, `'inventor'`, `'fusion'`, `'blender'`, `'maya'`, `'onshape'` or `'rhino'`, and keyboard shortcuts are on (`keyEvents={false}` turns them off). `OrbitControls` takes the same `profile` and `keyEvents` props.

```tsx
import { Canvas, Mesh, BoxGeometry, PbrMaterial } from '@margoengine/react';
import { CadControls } from '@margoengine/react/controls';
import { Shadows } from '@margoengine/react/shadows';

export function Part({ onViewChanged }: { onViewChanged: () => void }) {
  return (
    <Canvas>
      <CadControls profile="solidworks" enableDamping onEnd={onViewChanged} />
      <Shadows distance={60} filter="pcf" />
      <Mesh castShadow position={[0, 1, 0]}>
        <BoxGeometry />
        <PbrMaterial color="#84d6bd" />
      </Mesh>
    </Canvas>
  );
}
```

`FlyControls`, `FirstPersonControls` and `TrackballControls` load only their own entry of `@margoengine/controls` (`/fly`, `/first-person`, `/trackball`), update from the frame loop and take every live field as a prop in the same way (`movementSpeed`, `rollSpeed`, `enableRoll`, `dragToLook`; `lookSpeed`, `constrainVertical`, `verticalMin`; `rotateSpeed`, `staticMoving`, `dynamicDampingFactor`, `minDistance`, ...). Keys are read from the canvas's document unless you pass `keyTarget` (read once; changing it recreates the controls). The ref is the native controls object.

```tsx
import { Canvas, Mesh, BoxGeometry, PbrMaterial } from '@margoengine/react';
import { FlyControls } from '@margoengine/react/controls';

export function Flight() {
  return (
    <Canvas>
      <FlyControls movementSpeed={10} rollSpeed={0.5} dragToLook />
      <Mesh>
        <BoxGeometry />
        <PbrMaterial color="#e0b16a" />
      </Mesh>
    </Canvas>
  );
}
```

`DragControls` lets the pointer, mouse or touch drag its children as one group (`@margoengine/controls/drag`): on the plane facing the camera by default, on another `plane`, along `axisLock` (`'x'`, `'y'`, `'z'` or a direction), or turning them with `mode="rotate"`. `dragLimits` holds the group's position on each axis between a minimum and a maximum in its parent's space (`undefined` leaves an axis free). `onDragStart` gets the starting position, `onDrag` the position after the limits, and `onDragEnd` and `onHover` report the rest; the ref is the native `DragControls`. A press on the group stops canvas listeners added after it; turn camera controls added before it off in `onDragStart`.

```tsx
import { Canvas, Mesh, BoxGeometry, PbrMaterial } from '@margoengine/react';
import { DragControls } from '@margoengine/react/controls';

export function Slider() {
  return (
    <Canvas>
      <DragControls axisLock="x" dragLimits={[[-3, 3], undefined, undefined]} onDrag={([x]) => console.log(x)}>
        <Mesh>
          <BoxGeometry />
          <PbrMaterial color="#6aa7e0" />
        </Mesh>
      </DragControls>
    </Canvas>
  );
}
```

`PivotControls` moves, turns and scales its children as one group from one gizmo, as drei's does: move arrows, plane sliders, a free-move centre, rotation rings and scale handles together (the `all` mode of `@margoengine/controls/transform`, in the group's own axes unless `space="world"`). `matrix` places the group (column-major, applied when it changes); with `autoTransform={false}` the group stays at `matrix` and `onDrag(local, deltaLocal, world, deltaWorld)` says where it would go. `scale` sizes the gizmo, which keeps a constant size on screen. `activeAxes`, `disableAxes`, `disableSliders`, `disableRotations`, `disableScaling` and `disableCenter` leave handles out; `translationLimits`, `rotationLimits` (Euler radians) and `scaleLimits` hold the group per axis; `depthTest` hides the gizmo behind scene geometry; `onDragStart` gets the `component` (`Arrow`, `Slider`, `Rotator`, `Scale` or `Center`), `axis`, `origin` and `directions`. `anchor` puts the gizmo on the children's bounding box in the group's own space (each axis -1, 0 or 1, or between; it follows the box as children load or change), and `offset` moves it from there; moves, turns and scales then go about that point. `scale` is the gizmo's length in world units, as in drei; `fixed` keeps it a constant size on screen instead, `scale` then multiplying that size. `axisColors`, `hoveredColor` (`'#rgb'`, `'#rrggbb'`, `'#rrggbbaa'` or `[r, g, b(, a)]` in 0..1; default red, green, blue and yellow) and `lineWidth` (default 2.5 CSS pixels) style it. `annotations` shows a label at the gizmo during a drag with the distance moved along an arrow (or from the start for a slider or the centre), the degrees turned or the scale factor, styled by `annotationsClass`; it loads `<Html>` and `@margoengine/html` only when on. The ref is the native `TransformControls`. `TransformControls` itself also takes `mode="all"`, and its `pivot`, `flipAxes`, `showDelta`, `occlude`, `occluder`, `hide`, `offset`, `fixed`, `axisColors`, `hoveredColor` and `lineWidth` props follow every rerender.

```tsx
import { Canvas, Mesh, BoxGeometry, PbrMaterial } from '@margoengine/react';
import { PivotControls } from '@margoengine/react/controls';

export function Editor() {
  return (
    <Canvas>
      <PivotControls
        disableScaling
        anchor={[0, -1, 0]}
        annotations
        lineWidth={4}
        translationLimits={[[-2, 2], undefined, undefined]}
        onDragEnd={() => console.log('placed')}
      >
        <Mesh>
          <BoxGeometry />
          <PbrMaterial color="#e0a96a" />
        </Mesh>
      </PivotControls>
    </Canvas>
  );
}
```

`CameraControls` is `OrbitControls` with damping on by default and a ref that moves the camera from code, smoothly over `duration` seconds (default 0.6) or at once with `false` as the last argument: `setLookAt`, `setPosition`, `setTarget`, `rotate` and `rotateTo` (azimuth and polar in radians, within the angle limits), `dolly` and `dollyTo` (within `minDistance` and `maxDistance`), `truck` (slide along the screen), `fitToBox` and `fitToSphere` (a box, a sphere or a mesh, with its children and loaded models), `saveState`, `reset` and `cancel`. Each move starts from the view at the call and returns a promise: true when it arrives, false when a drag, a key, `cancel()` or a newer move interrupts it. `ref.current.controls` is the native controls object.

```tsx
import { useRef } from 'react';
import { Canvas, Mesh, BoxGeometry, PbrMaterial, type MeshRef } from '@margoengine/react';
import { CameraControls, type CameraControlsHandle } from '@margoengine/react/controls';

export function Viewer() {
  const camera = useRef<CameraControlsHandle>(null),
    part = useRef<MeshRef>(null);
  return (
    <>
      <button onClick={() => part.current && camera.current?.fitToBox(part.current)}>Frame part</button>
      <button onClick={() => camera.current?.rotate(Math.PI / 4, 0)}>Turn 45 degrees</button>
      <button onClick={() => camera.current?.reset()}>Reset</button>
      <Canvas>
        <CameraControls ref={camera} maxDistance={50} />
        <Mesh ref={part}>
          <BoxGeometry />
          <PbrMaterial color="#84d6bd" />
        </Mesh>
      </Canvas>
    </>
  );
}
```

`<Shadows>` turns on the Canvas's cascaded shadows while it is mounted and sets their live options (`resolution`, `distance`, `lambda`, `lightSize`, `samples`, `blockerSamples`, `focus`, `bias`, `normalBias`, `casterMargin`, `filter`, `bounds` or `frustum`); unmounting restores the options it set. `<Mesh castShadow>` (and `receiveShadow={false}`) adds a mesh to them, like `Box`, `Sphere`, `Plane` and `Model`.

Hooks: `useEngine()` returns the Canvas engine and `useCamera()` its camera. `useLoader(loader, url)` loads any file and suspends until it is ready: the loader is `(url, { engine, signal, fetch }) => Promise<T>`, each Canvas shares one load per loader and URL, and a failed load throws to the nearest error boundary (call `clearLoader(loader, url)` before retrying). `useProgress()` reports `{ active, loaded, total, progress, item, errors }` across `Model`, `Fbx`, `Environment` and `useLoader` loads for a loading bar; it needs the optional `@margoengine/cache`.

```tsx
import { load, parsePLY, type LoadedGeometry } from '@margoengine/loaders';
import { useLoader, useProgress, type Loader } from '@margoengine/react';

// Defined once, outside components: the loader is the cache key.
const ply: Loader<LoadedGeometry> = (url, { fetch, signal }) => load(url, parsePLY, { fetch, signal });
function ScanInfo() {
  const scan = useLoader(ply, '/scan.ply');
  return <p>{scan.positions.length / 3} points</p>;
}
function LoadingBar() {
  const { active, progress } = useProgress();
  return active ? <progress max={100} value={progress} /> : null;
}
```

## Physics

Physics is a separate entry, so an app without it never loads a solver. Import it from `@margoengine/react/physics`:
`Physics`, `RigidBody`, the colliders (`CuboidCollider`, `BallCollider`, `CapsuleCollider`, `CylinderCollider`,
`ConeCollider`, `ConvexHullCollider`, `TrimeshCollider`, `HeightfieldCollider`), `useJoint`, `usePhysics`,
`useBeforePhysicsStep` and `useAfterPhysicsStep`. `Physics` creates the world; each `RigidBody` owns the meshes inside
it. A complete example is in the [cookbook](../../docs/react-cookbook.md#physics). `usePhysics` works only inside
`<Physics>`.

## XR

`XR`, `Controller` and `useXR` come from `@margoengine/react/xr` (and `margoengine/react`). `useXR` works only inside
`<XR>`.

## Next.js

Both the App Router and the Pages Router work, with webpack and with Turbopack, and need no `transpilePackages`. Install
`margoengine` (`npm i margoengine react react-dom next` once it is published) and import from `margoengine/react`,
the one-install route; or install `@margoengine/react` alone with the packages its subpaths name
(`npm i @margoengine/react @margoengine/controls react react-dom next`) and import `OrbitControls` from
`@margoengine/react/controls`. Both build with webpack and Turbopack (the bundler matrix builds the cube page with
`@margoengine/react` alone, and with `/controls` added). Keep the page a server component and put the `Canvas` in a small client component:

```tsx
// app/scene.tsx
'use client';
import { Canvas, Box, OrbitControls } from 'margoengine/react';

export function Scene() {
  return (
    <Canvas style={{ height: '70vh' }} label="Product viewer">
      <Box color="#84d6bd" />
      <OrbitControls enableDamping />
    </Canvas>
  );
}
```

Import `Scene` from a server `page.tsx` behind `<Suspense fallback={...}>`. Next.js example: `examples/next`. More recipes are
in the [React cookbook](../../docs/react-cookbook.md); moving from react-three-fiber is in
[Coming from react-three-fiber](../../docs/react-from-r3f.md).

A Next.js page is larger than the Vite page: about 194 KB gzip of JavaScript. Its build output also holds the Basis and
Draco decoders; they are emitted but never requested at load or while orbiting.

SSR emits an accessible canvas without accessing GPU APIs. The ESM output preserves `use client` and includes TypeScript declarations. Peer ranges accept core `^1.0.0` and React 18 or 19.

## State vs the frame loop

Pick the home for each value by how often it changes. Motion that changes every frame belongs in the frame loop. Values
a person reads or edits belong in React state.

| Value | Where it lives | Why |
| --- | --- | --- |
| Initial position, rotation, colour (JSX props) | Props | React sets them once and when they change. |
| Running motion: spin, follow the mouse, a physics step | A ref written in `useFrame` | No React render per frame. |
| UI: selected item, a colour picker, a loading flag, inspector fields | `useState` or your store | The UI must re-render when they change. |
| Anything you save or send | A plain document in state (see the [scene document guide](../../docs/guides/react-scene-document.md)) | Engine objects cannot be serialised. |

The hooks for this are public: `useFrame((engine, deltaSeconds) => ...)` runs once per rendered frame and re-renders
nothing, `useEngine()` returns the engine, and a `ref` on `Mesh` is the live mesh (`MeshRef`) you move. The package also
uses internal helpers (`useLiveRef`, `useCommit`, `useResourceEffect`, `useMesh`) to keep refs and GPU objects correct
through StrictMode; they are not exported, so build on `useFrame`, `useEngine` and refs.

Bad: `setState` every frame. Good: a ref and `useFrame`.

```tsx
import { useRef, useState } from 'react';
import { BoxGeometry, Mesh, type MeshRef, PbrMaterial, useFrame } from '@margoengine/react';

function Bad() {
  const [angle, setAngle] = useState(0);
  useFrame((_, delta) => setAngle((a) => a + delta)); // React re-renders every frame
  return <Mesh rotation={[0, angle, 0]}><BoxGeometry /><PbrMaterial /></Mesh>;
}

function Good() {
  const mesh = useRef<MeshRef>(null);
  useFrame((_, delta) => { if (mesh.current) mesh.current.rotation.y += delta; }); // no render
  return <Mesh ref={mesh}><BoxGeometry /><PbrMaterial /></Mesh>;
}
```

The [state vs frame loop guide](../../docs/guides/react-state-vs-frame-loop.md) runs both in a browser and counts React
commits per second for each. The canvas serialises initialisation, disposes superseded engines and disconnects its
`ResizeObserver` on cleanup. It handles StrictMode, HMR effect replacement, late initialisation after unmount, and
`capacity` and `backend` changes. Camera changes update the existing engine. Errors reach `onError` and an accessible
alert.

## Browsers without WebGPU

`loadFallback` fetches the WebGL2 renderer only when the browser has no WebGPU, and `fallbackContent` is what the
canvas shows when no renderer is usable (like a Suspense fallback, it can be an SVG, a skeleton or a pre-rendered image).
WebGPU visitors never run the loader, so they download none of `@margoengine/webgl2-compat/preview`.

```tsx
import { Canvas } from '@margoengine/react';

export function Viewer() {
  return (
    <Canvas
      loadFallback={() => import('@margoengine/webgl2-compat/preview')}
      fallbackContent={<img src="/scene.png" alt="Pre-rendered view of the scene" />}
      onError={(error) => console.warn(error)}
    />
  );
}
```

| Prop | Default | Effect |
| --- | --- | --- |
| `loadFallback` | none | `(signal: AbortSignal) => Promise<factory \| { webglRenderer }>`. Called once per engine, only without WebGPU (or with `backend="webgl2"`); `signal` aborts on unmount. A rejection reaches `onError` as a `MargoError` with code `unsupported`. Ignored when `fallback` or `backend="webgpu"` is set. |
| `loadCompat` | none | `() => Promise<{ install() }>`, the WebGL2 compatibility layer. Installed before the engine is made, only without WebGPU, so packages the preview refuses still draw: one engine, one `onCreated`, and listeners stay on the canvas. If the browser's WebGL2 is too old to carry it, `loadFallback` runs, or `onError` gets the refusal. |
| `fallbackContent` | the plain "needs a browser with WebGPU" text | Shown in place of the text for the `unsupported` error; `onError` still receives it. |

A scene that uses more than plain meshes wants `loadCompat`: the preview draws core meshes only, and the layer carries the packages. It is a larger download, and only visitors without WebGPU fetch it.

```tsx
import { Canvas } from '@margoengine/react';

export function Viewer() {
  return <Canvas loadCompat={() => import('@margoengine/webgl2-compat')} loadFallback={() => import('@margoengine/webgl2-compat/preview')} />;
}
```

## Pixel ratio and GPU choice

`maxDpr` lowers the canvas pixel ratio below the engine's own cap of 2. Core has no per-canvas option, so the Canvas uses
the engine's light tier, the `globalThis.margoLow` pixel-ratio cap. That has three consequences: MSAA is off while it
applies, it covers every canvas on the page while a Canvas with `maxDpr` is mounted (the lowest value wins and the
previous setting returns after the last one unmounts), and a value of 2 or more changes nothing. A `margoLow` you set
yourself still counts. Changing `maxDpr` recreates the engine, and a value that is not a number above 0 reaches
`onError` as a `RangeError`. The default is no cap beyond the engine's: 2, with MSAA on desktop.

```tsx
import { Canvas } from '@margoengine/react';

export function LightViewer() {
  return <Canvas maxDpr={1} style={{ height: 400 }} />;
}
```

| Prop | Default | Effect |
| --- | --- | --- |
| `maxDpr` | none | Pixel ratio cap below 2, for example `1`. Page-wide while mounted; turns MSAA off. |

There is no `powerPreference` prop. The WebGPU renderer asks for its adapter inside core (high performance, except on
Windows where the browser chooses), and core takes no option for it, so a prop here would only pretend.

## Development hints

In development the Canvas prints each of these once as a `MargoError`. Development means your bundler or Node gives
`process.env.NODE_ENV` a value other than `'production'`; the page needs no global `process`, so the Vite dev server
counts. A production bundle contains none of them. Plain ES modules with no bundler print none either.

```tsx
import {Canvas} from '@margoengine/react';

// Under `vite dev` the console names the component to use instead of <mesh>.
export const App = () => (
  <Canvas>
    {/* @ts-expect-error: the wrong name on purpose, this is what the warning is for. */}
    <mesh />
  </Canvas>
);
```

- **A lowercase R3F tag** such as `<mesh>`, `<group>` or `<boxGeometry>` inside the Canvas. React renders it as an unknown
  DOM element, so nothing draws. The message names the Margo component to use (`<Mesh>`, `<Group>`, `<BoxGeometry>`,
  `<PbrMaterial>`, `<Sun>`) or the namespace form `<Margo.mesh>`.
- **Pointer handlers on the WebGL2 fallback**: see [Pointer events and picking](#pointer-events-and-picking).

## Build warnings

A production Vite build of the cube page prints no warnings; `npm run modern:test:bundlers` checks it from the installed packages on every merge check and fails on any warning. Only the generated `rsc/` entries carry `'use client'` (the
`react-server` export condition maps to them), so a server component can import `Canvas`. `sideEffects` is `false`, so
unused exports are dropped. Next.js builds with webpack and Turbopack run in `npm run modern:test:bundlers`.

## Choosing the GPU

On a laptop with an integrated and a discrete GPU, `powerPreference` picks one: `'low-power'` saves battery,
`'high-performance'` asks for the discrete GPU. The Canvas passes it to `Engine.create`, and the engine asks for the
same GPU again when the device is restored.

```tsx
import { Canvas } from '@margoengine/react';

export function BatteryFriendlyViewer() {
  return <Canvas powerPreference="low-power" style={{ height: 400 }} />;
}
```

| Prop | Default | Effect |
| --- | --- | --- |
| `powerPreference` | unset: `'high-performance'`, nothing on Windows | `'low-power'` or `'high-performance'`. Read when the engine is created; a new value applies to the next engine. |

Chrome and Edge on Windows ignore a set value and log a console warning; there, the GPU is chosen per browser in
Windows Settings > System > Display > Graphics.

## Testing and size

Run `npm run build:packages`, then `npm run modern:test:react` for the React Testing Library and JSDOM lifecycle tests:
the first-scene snippet, StrictMode events, Suspense, cancellation, cache reuse and demand rendering. `npm run typecheck`
and `npm run test:modules:packages` check the package types and imports. `npm run test:docs:browser` runs the React guides
in a real WebGPU browser. The adapter uses standard hooks, never `react-reconciler`. Frame dispatch forwards
`(engine, deltaSeconds)` without building per-frame state objects or callback arrays.

Measured entry sizes and page breakdowns, with their scope and reproduction commands, are recorded in
[docs/limits.md](../../docs/limits.md#react-page). Use `npm run measure:size` for the current build's entry sizes.

## Troubleshooting

- **The canvas is blank and has no height.** Give `<Canvas>` a height: `style={{ height: 400 }}`.
- **No WebGPU, graceful fallback.** `<Canvas loadFallback={() => import('margoengine/webgl2-compat/preview')} fallbackContent={<img src="/scene.png" alt="Scene preview" />}>`: the Canvas checks `navigator.gpu` and `requestAdapter()` itself before creating the engine and calls `loadFallback` only when WebGPU is missing, so WebGPU visitors download none of `@margoengine/webgl2-compat/preview` (it is a separate chunk). The loader gets an `AbortSignal` (aborted on unmount) and may resolve the renderer factory or a module with `webglRenderer`; a rejection reaches `onError` as a `MargoError` with code `unsupported`. When no renderer is usable, `fallbackContent` (an SVG, skeleton or image) replaces the default text, a bit like a Suspense fallback, and `onError` still gets the coded error. `fallback` (a factory you import yourself) works as before and wins over `loadFallback`.
- **"WebGPU unavailable".** The browser has no WebGPU. Pass an `onError` handler to show your own message.
- **A component does nothing.** React treats a bare lowercase `<mesh>` as a DOM element. Use `<Mesh>`, or the
  namespace form `<Margo.mesh>`. In development the Canvas prints a warning that names the component to use.
- **A hook throws a `state` error.** `useMargo`, `usePhysics` and `useXR` work only inside their provider (`<Canvas>`, `<Physics>`, `<XR>`).
- **The scene re-renders constantly.** Per-frame values belong in refs: see [State vs the frame loop](#state-vs-the-frame-loop).
- **A click handler never runs, or a test sees the old state.** Picking is asynchronous: see [Pointer events and picking](#pointer-events-and-picking). The WebGL2 fallback needs `webglPicking`.
- **Textures on `Box`, `Sphere` or `Plane`.** Pass `map` and install `@margoengine/gltf`: see [Textured Box, Sphere and Plane](#textured-box-sphere-and-plane). For more maps than base colour, use a glTF `Model`.
- **Next.js error about hooks in a server component.** Put the `Canvas` in a file that starts with `'use client'`.

Apache-2.0 licensed.

## Helpers and development panels

```tsx
import {Canvas, Mesh} from '@margoengine/react';
import {Billboard, Bounds, Float, useBounds} from '@margoengine/react/helpers';
import {Box} from '@margoengine/react/geometry';
import {Grid} from '@margoengine/react/lines';
import {DevTools} from '@margoengine/react/devtools';

function Part() {
  const bounds = useBounds();
  return <Box position={[2, 0, 0]} onClick={(event) => bounds.fit(event.object)} />;
}

export function App() {
  return (
    <Canvas>
      <DevTools />
      <Grid size={20} divisions={20} />
      <Bounds fit clip observe margin={1.3}>
        <Part />
        <Float speed={2} floatingRange={[0, 0.3]}>
          <Mesh position={[-2, 0, 0]} />
        </Float>
        <Billboard lockX position={[0, 2, 0]}>
          <Box args={[1, 1, 0.1]} />
        </Billboard>
      </Bounds>
    </Canvas>
  );
}
```

- `Bounds` frames its content when it first has geometry, keeping the viewing direction, and `useBounds().fit(mesh)` frames
  one mesh. `clip` also sets the camera's near and far. Defaults: margin 1.2, duration 0.3 s.
- `Billboard` keeps +Z towards the camera, whatever its parents do. `lockX` keeps it upright, `lockY` stops it turning sideways.
  It assumes parents without shear.
- `Float` adds its motion inside its own group, so `position` and `rotation` stay yours. It moves on frames, so it stands still
  with `frameloop="demand"` until something asks for a frame.
- `Grid` needs `@margoengine/lines`, and lets go of its plugin on unmount.
- `DevTools` needs `@margoengine/inspector` and `@margoengine/stats`, loaded only when it opens, and is off in a production
  build unless you pass `enabled`, including one with no global `process`, which is every browser build. In React 19 development builds a mesh without a `name` shows the components that made it,
  such as "Box in Part". Safari and other WebKit browsers drop a component that ends in `return <Mesh ... />` from that name, as
  their engine replaces the frame of a tail call: give the mesh a `name`, or assign the element first
  (`const mesh = <Mesh ... />; return mesh;`).

- `Stats` is the readout alone, the drop-in for a stats panel: `<Stats />` (from `@margoengine/react/devtools`) shows
  frame time and draw calls in every build because you placed it, and takes the `@margoengine/stats` options
  (`parent`, default document.body; `samples`, default 120; `profiling`) plus `enabled` (default true) and `onError`.

### Cursor, viewport, cover sizing and camera shake

```tsx
import {useRef, useState} from 'react';
import {Canvas} from '@margoengine/react';
import {CameraShake, useAspect, useCursor, useViewport, type CameraShakeRef} from '@margoengine/react/helpers';
import {Box, Plane} from '@margoengine/react/geometry';

function Backdrop() {
  // A 16:9 plane that covers the view at the camera target, like CSS background-size: cover.
  return <Plane scale={useAspect(16, 9)} position={[0, 0, -0.01]} />;
}

function Button({shake}: {shake: React.RefObject<CameraShakeRef | null>}) {
  const [hovered, setHovered] = useState(false);
  useCursor(hovered);
  const {width} = useViewport();
  return (
    <Box
      position={[width / 4, 0, 0]}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
      onClick={() => shake.current?.setIntensity(1)}
    />
  );
}

export function App() {
  const shake = useRef<CameraShakeRef>(null);
  return (
    <Canvas>
      <Backdrop />
      <Button shake={shake} />
      <CameraShake ref={shake} intensity={0} decay maxYaw={0.05} maxPitch={0.05} maxRoll={0.05} yawFrequency={4} pitchFrequency={4} rollFrequency={4} />
    </Canvas>
  );
}
```

- `useCursor(hovered, over = 'pointer', out = 'auto')` sets the canvas cursor, not the page's, so it never leaks past
  the canvas; it puts `out` back when `hovered` turns false or the component unmounts.
- `useViewport()` gives the view's `width` and `height` in world units at the camera target, `aspect`, `distance`,
  `factor` (CSS pixels per unit) and `size`; the component renders again when the canvas changes size, not when the
  camera moves (read `useEngine().camera` in `useFrame` for that). `viewportAt(camera, size, distance?)` is the same
  sum for any depth.
- `useAspect(width, height, factor = 1)` returns a `scale` that covers the view at the target with that aspect.
- `CameraShake` turns the view about the camera position with smooth noise, after controls and your frame callbacks
  have placed it, and puts the camera back on unmount. Defaults: `maxYaw`, `maxPitch` and `maxRoll` 0.1 rad, each
  frequency 0.1, `intensity` 1, `decay` false, `decayRate` 0.65 per second. Angles scale with intensity squared, so a
  decaying shake eases out. Each frame it restores the target and up it set unless something else changed them, so it
  works with every controls component. The ref has `getIntensity()` and `setIntensity(0..1)`.

### Visible in the view: useIntersect

```tsx
import {useRef} from 'react';
import {Canvas, useFrame} from '@margoengine/react';
import {useIntersect} from '@margoengine/react/helpers';
import {Box} from '@margoengine/react/geometry';

function Spinner({x}: {x: number}) {
  const inView = useRef(false);
  const angle = useRef(0);
  const ref = useIntersect((visible) => {
    inView.current = visible;
  });
  // Spins only while the camera sees it.
  useFrame((_, delta) => {
    if (!inView.current || !ref.current) return;
    angle.current += delta;
    ref.current.setRotation([0, angle.current, 0]);
  });
  return <Box ref={ref} position={[x, 0, 0]} />;
}

export function App() {
  return (
    <Canvas>
      {[-40, -2, 2, 40].map((x) => (
        <Spinner key={x} x={x} />
      ))}
    </Canvas>
  );
}
```

- `useIntersect(onChange)` returns a ref for a mesh or group and calls `onChange(true)` when it comes into the camera's
  view and `onChange(false)` when it leaves, by the engine's frustum culling of the last drawn frame. It starts as not
  visible. A group counts while any mesh with geometry, or loaded model, under it is in view; hidden meshes do not
  count. Like drei's, it does not test occlusion.

### Warm-up: Preload

```tsx
import {Canvas} from '@margoengine/react';
import {Preload} from '@margoengine/react/helpers';
import {Box} from '@margoengine/react/geometry';

export function App() {
  return (
    <Canvas>
      <Box position={[0, 0, -50]} />
      <Preload all />
    </Canvas>
  );
}
```

- `Preload` draws the whole scene once with frustum culling off when it mounts, and again on the next frame after
  loading settles with a new model in the Canvas, so pipelines compile and buffers and textures upload before the
  camera turns to them. `all` (default false) draws hidden meshes too and hides them again. Place it after the content.

### Copies: Clone

```tsx
import {useState} from 'react';
import {Canvas, Mesh, type MeshRef} from '@margoengine/react';
import {Clone} from '@margoengine/react/helpers';
import {Box, Sphere} from '@margoengine/react/geometry';

export function App() {
  const [tree, setTree] = useState<MeshRef | null>(null);
  return (
    <Canvas>
      <Mesh ref={setTree}>
        <Box />
        <Sphere position={[0, 1, 0]} />
      </Mesh>
      {[2, 4, 6].map((x) => (
        <Clone key={x} object={tree} position={[x, 0, 0]} />
      ))}
    </Canvas>
  );
}
```

- `Clone` copies a mesh, group or model root (`object`, a mesh or a ref) with everything under it into a group placed
  by its own `position`, `rotation`, `scale` and events. Plain meshes share the source's geometry and material, as
  drei's `<Clone>` does. Models under it (a `<Model>` root from `onLoad`) are independent copies through `cloneModel`
  of `@margoengine/animation` (install it), so each can play its own animation; they share the source's GPU buffers
  and textures and take its current material values.
- The copy starts at the source's local transforms, visibility and render layers at the time it is made and does not
  follow later changes; pass another `object` to copy again. A Clone inside the object it copies is an error.

Strict consumers can use `skipLibCheck: false` with optional engine peers absent.
Declaration packaging keeps parameter annotations while removing implementation
binding patterns; installing a peer restores its full option checking.

Camera-control bindings are tree-shakable independently: importing `OrbitControls`
emits its lazy orbit entry without ArcballControls, and importing `ArcballControls`
emits its lazy arcball entry without OrbitControls. Requested controls retain their
normal props, refs and event behavior.

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.

## Native package bindings

Import each binding from its own optional subpath. Install the native peer named in the table. These wrappers use
native package objects, including their validation, device recovery and disposal. Refs become null on unmount;
imports resolving after unmount create nothing. Line, Points, Outline, Splat, AmbientLight, HemisphereLight and Fog attach to the enclosing Scene.

| Entry | Component | Native peer | Defaults and updates |
| --- | --- | --- | --- |
| /lines | Line | @margoengine/lines | Connected strip, width 1 CSS px, white, solid; points accepts flat xyz or triples. lineWidth aliases width; segments draws pairs. All native LineOptions apply. Changed data/style rebuilds; ref supports native frame updates. |
| /points | Points | @margoengine/points | Native PointCloudOptions, including positions, colours, sizes, material, matrix and block size. Changed options rebuild; ref supports native dirty channels. |
| /selection | Outline | @margoengine/selection (installed with React) | Parent Mesh selected unless selection is given; refs resolved every frame. Width 3 px, orange, JFA, no xray. Native options apply; selection=[] clears. |
| /lod | Detailed | @margoengine/lod | One distance per child (first ignored); 1-8 children, increasing world-unit distances, hysteresis 0.1. Each child is a group and can contain nested meshes/models. Transform props default to identity. |
| /splats | Splat | @margoengine/splats | data is SplatData, or src is a .splat URL loaded through Suspense, cache, progress and AbortSignal. antialias=false; changing data/src rebuilds, antialias updates live. |
| /viewcube | GizmoHelper | @margoengine/viewcube | Native ViewCubeOptions: top-right, 80 CSS px, 0.4 s transitions, drag=true; optional roll, home, themes and projection toggle. Changed options recreate the widget. |
| /cameras | PerspectiveCamera, OrthographicCamera | @margoengine/cameras for orthographic | makeDefault=false. Perspective: position [0,2,5], target [0,0,0], up [0,1,0], fov 60 degrees, near 0.1, far 1000. Orthographic: native ProjectionOptions, resize-aware height, zoom 1. |

A default camera configures the engine's stable camera handle, so controls and useCamera see it too. Nested defaults
restore the latest underlying camera on unmount, even if an underlying mount disappears first. A non-default camera
has its own ref for RenderView. The engine handle's identity stays stable; this differs from Fiber's camera-store
replacement. Orthographic projections load lazily. Native attachment failures go to onError and the Canvas. A Suspense URL load
throws failures to the nearest React error boundary, as useLoader does.

The small component examples below go inside Canvas (the camera examples also work with RenderView). For the complete
runnable real-capture comparison, run the repository Vite server and open
/packages/react/tests/bindings-browser.html; its paired canvases compare the wrappers with the native package APIs.
The capture is the Niantic MIT sample excerpt documented in ../splats/test/fixtures/NOTICE.md, not generated art.

### Line binding

```tsx
import { Line } from '@margoengine/react/lines';
export function Route() {
  return <Line points={[[0,0,0],[1,1,0],[2,0,0]]} color="#60c0ff" lineWidth={3} dashed dashSize={0.2} />;
}
```

### Segments

`<Segments>` (also from `/lines`) is drei's Segments: every `<Segment start end color>` inside it is drawn by one
native, antialiased line in segment mode, so many segments cost one draw. Props are the `<Line>` material and
transform (`lineWidth`, `color`, `dashed`, `worldUnits`, `matrix`, `mesh`, ...) plus `limit` (default 1000: the most
segments drawn, in mount order). A `<Segment>`'s `color` defaults to white and multiplies the line colour. Its ref is
a live `{ start, end, color }` record (linear rgb): write it in place in `useFrame` and the batch redraws, uploading
only on frames where a value changed.

```tsx
import { useRef } from 'react';
import { useFrame } from '@margoengine/react';
import { Segments, Segment, type SegmentHandle } from '@margoengine/react/lines';
export function Spokes() {
  const tip = useRef<SegmentHandle>(null);
  useFrame(() => { if (tip.current) tip.current.end[1] = Math.sin(performance.now() / 500); });
  return <Segments lineWidth={2}>
    <Segment ref={tip} start={[0, 0, 0]} end={[1, 0, 0]} color="#ff4040" />
    <Segment start={[0, 0, 0]} end={[0, 1, 0]} color="#40ff40" />
    <Segment start={[0, 0, 0]} end={[0, 0, 1]} color="#4080ff" />
  </Segments>;
}
```

### Points binding

```tsx
import { Points } from '@margoengine/react/points';
const positions = new Float32Array([0,0,0, 1,0,0, 0,1,0]);
export function Markers() {
  return <Points positions={positions} material={{size: 8, color: '#60c0ff'}} />;
}
```

### Outline binding

```tsx
import { Mesh, BoxGeometry, PbrMaterial } from '@margoengine/react';
import { Outline } from '@margoengine/react/selection';
export function Selected() {
  return <Mesh><BoxGeometry/><PbrMaterial color="#ff3030"/><Outline color={[0,1,0]} width={4}/></Mesh>;
}
```

### Detailed binding

```tsx
import { Mesh, BoxGeometry, PbrMaterial } from '@margoengine/react';
import { Detailed } from '@margoengine/react/lod';
export function Levels() {
  return <Detailed distances={[0,10]}>
    <Mesh><BoxGeometry/><PbrMaterial color="#ff3030"/></Mesh>
    <Mesh><BoxGeometry/><PbrMaterial color="#30ff30"/></Mesh>
  </Detailed>;
}
```

### Splat binding

The URL here is the repository's real capture fixture; in your app, serve a .splat capture at your chosen URL.

```tsx
import { Suspense } from 'react';
import { Splat } from '@margoengine/react/splats';
export function Capture() {
  return <Suspense fallback={null}><Splat src="/packages/splats/test/fixtures/raccoon-v2.splat" antialias/></Suspense>;
}
```

### View cube binding

```tsx
import { GizmoHelper } from '@margoengine/react/viewcube';
export function Orientation() {
  return <GizmoHelper corner="bottom-right" roll home theme="auto" />;
}
```

### Camera bindings

```tsx
import { OrthographicCamera, PerspectiveCamera } from '@margoengine/react/cameras';
export function Cameras({plan = false}: {plan?: boolean}) {
  return plan ? <OrthographicCamera makeDefault height={12} position={[0,10,0]} target={[0,0,0]} up={[0,0,-1]}/>
    : <PerspectiveCamera makeDefault position={[0,2,5]}/>;
}
```

Native WebGPU requirements remain: line/point/splat/outline rendering needs WebGPU or the WebGL2 compatibility device,
not the preview fallback. Detailed mesh switching, camera projection and the DOM view cube also work on preview.
Splat clouds sort independently, and the native LOD limit is eight children. These bindings do not change those limits.


Optional binding entry gzip sizes (bare peers external): lines 1,502 B, points 1,204 B, lod 2,764 B, selection 1,156 B, splats 1,858 B, viewcube 1,032 B, cameras 1,821 B. Native peers load separately. Line and Points follow the enclosing Mesh unless an explicit matrix (or Line mesh) is supplied; SplatData uses world-space positions.

## XR mesh pointer events

Mount `XRPointerEvents` from `@margoengine/react/xr-pointer` inside `Canvas` and
`XR` to send XR ray/grab/touch events to the same Mesh handlers as desktop input.
It accepts a caller-owned `XRPointerPicker`, such as `SpatialPicking`, plus the
pointer options documented by `@margoengine/xr/pointer`. It bubbles click,
over/out, move and down/up through mesh parents, deduplicates model-root
handlers, respects `stopPropagation`, and lets a parent capture the pointer.
The event's `xr` field holds its input source, stable id, pointer type and hit;
XR has no canvas pixel coordinates, so the DOM coordinate fields are zero.

Copy `packages/exporters/tests/fixtures/Box.glb` to your app's
`public/xr-pointer-box.glb` before running this example. The README gate serves
that exact licensed fixture at the same URL.

```tsx
import { Suspense, useEffect, useState } from 'react';
import { Canvas, useEngine } from '@margoengine/react';
import { XR } from '@margoengine/react/xr';
import { Gltf } from '@margoengine/react/gltf';
import { XRPointerEvents } from '@margoengine/react/xr-pointer';
import { Picking } from '@margoengine/selection';
import { SpatialPicking } from '@margoengine/selection/spatial';

function Pointers() {
  const engine = useEngine();
  const [picker, setPicker] = useState<SpatialPicking | null>(null);
  useEffect(() => {
    const existing = Picking.forEngine(engine);
    const picking = existing ?? Picking.attach(engine);
    const spatial = new SpatialPicking(engine, picking);
    setPicker(spatial);
    return () => { spatial.dispose(); if (!existing) picking.dispose(); };
  }, [engine]);
  return picker ? <XRPointerEvents picker={picker} /> : null;
}
export function PointerScene() {
  return <Canvas><XR><Pointers /><Suspense fallback={null}><Gltf src="/xr-pointer-box.glb" onClick={event => console.log(event.mesh)} /></Suspense></XR></Canvas>;
}
```

This is the event binding; enter the session with `useXR().enter()` from a user
gesture as in the XR example. A Canvas with an existing Picking plugin should
pass a SpatialPicking around that picker instead of attaching a second one.
Unmount detaches the XR helper; picker ownership remains with the caller.

The example uses Cesium's Khronos Box (CC BY 4.0), as recorded in the
[exporter fixture notice](../exporters/tests/fixtures/NOTICE.md).

## Instances

Import `Instances` and `Instance` from `@margoengine/react/instances` (or `margoengine/react/instances`).
The geometry child is shared by every instance. Each instance is a native mesh with its own transform, material tint,
ref, visibility, children and pointer handlers. Native batching issues one draw per shared geometry per scene/pass on
WebGPU and WebGL2, including the preview renderer. Groups supply relative transforms; providers can nest.

```tsx
import { Canvas, BoxGeometry, PbrMaterial, Group } from '@margoengine/react';
import { Instances, Instance } from '@margoengine/react/instances';
export function InstancedBoxes() {
  return <Canvas style={{height: 300}} camera={{position: [0, 0, 5]}}>
    <Instances limit={1000}>
      <BoxGeometry />
      <PbrMaterial color="#ffffff" roughness={0.7} />
      <Instance position={[-1, 0, 0]} rotation={[0, 0.3, 0]} scale={[0.7, 1, 0.7]}
        color="#ff8040" onClick={event => console.log(event.object)} />
      <Group position={[1, 0, 0]}><Instance color="#40c080" /></Group>
    </Instances>
  </Canvas>;
}
```

`limit` defaults to 1000; `range` defaults to all mounted instances. Both are nonnegative safe integers. The first
`min(limit, range)` mounted instances draw; others keep their live refs and children. Removing an instance closes the
range gap. Each instance accepts every `Mesh` prop plus `color` (white multiplier by default) and `visible` (true).
Colours multiply the shared material in linear RGB. Shared material edits remain live. The container accepts Mesh
props plus optional caller-owned `geometry` and `material` objects instead of children, and its ref is a geometry-free
native mesh. Use one plain PBR material and one core geometry per provider; richer material and shader attributes use
the native materials instancing API. Named Scenes and RenderViews preserve scene ownership and pointer identity.
A shared geometry can merge with other same-geometry meshes in the same scene; the total draw count is still one.

### Sampler

`Sampler` and `useSurfaceSampler` from `@margoengine/react/sampler` are drei's: `count` random points (default 16) on the surface of
`mesh` (a ref to a `<Mesh>` or shape, a native mesh or a core geometry), by `MeshSurfaceSampler` of
`@margoengine/geometry/sample`: even over the area, or by `weights` (one density per vertex); `colors` (per vertex)
and `seed` (default 1, so the same mesh gives the same points) are optional. `Sampler` draws its geometry and material
children once per point as one `Instances` draw (every Instances prop but `limit` and `range`). Each instance sits at
its point, upright and scale 1, unless `transform(point)` returns its `position`, `rotation`, `scale` or `color`; the
point has `index`, `position`, `normal`, `uv`, `color` and `rotation`, the Euler angles that stand an instance's +Y on
the normal. The points are in the mesh's own space, so give the Sampler the mesh's transform. `useSurfaceSampler(mesh,
count, options)` returns the flat arrays (`positions`, `normals`, `uvs`, `colors`, `triangles`) or null until the
geometry is there; it follows a replaced geometry.

```tsx
import { useRef } from 'react';
import { Canvas, PbrMaterial, type MeshRef } from '@margoengine/react';
import { Sphere, ConeGeometry } from '@margoengine/react/geometry';
import { Sampler } from '@margoengine/react/sampler';

export function Spiky() {
  const ball = useRef<MeshRef>(null);
  return (
    <Canvas style={{ height: 400 }}>
      <Sphere ref={ball} args={[1, 32, 16]} color="#5b8def" />
      <Sampler
        mesh={ball}
        count={300}
        transform={({ position, rotation }) => ({ position, rotation, scale: [0.05, 0.2, 0.05] })}
      >
        <ConeGeometry />
        <PbrMaterial color="#f2c14e" />
      </Sampler>
    </Canvas>
  );
}
```

### Merged

`Merged`, also from `@margoengine/react/instances`, is drei's Merged: give it meshes (mounted native meshes, or
`{ geometry, material }`) and its children function receives one component per mesh; each rendered component is one
`<Instance>` of that mesh, so every mesh is one instanced draw however many copies you place. An array of meshes gives
the components as arguments in order, a record gives a record of components. `limit` and `range` apply to each mesh
(defaults 1000 and all). A mesh without a material draws in white PBR; the material is shared and stays live.

```tsx
import { Canvas } from '@margoengine/react';
import { Merged } from '@margoengine/react/instances';
import { box, PbrMaterial } from '@margoengine/core/extension';
import { sphereGeometry, toGeometry } from '@margoengine/geometry';
const cube = { geometry: box(), material: new PbrMaterial({ color: '#d0d0d0' }) };
const ball = { geometry: toGeometry(sphereGeometry(0.5)) };
export function MergedScene() {
  return <Canvas style={{height: 300}} camera={{position: [0, 2, 8]}}>
    <Merged meshes={{ Cube: cube, Ball: ball }}>
      {({ Cube, Ball }) => <>
        {[-2, 0, 2].map(x => <Cube key={x} position={[x, 0, 0]} color="#ff8040" />)}
        <Ball position={[0, 1.5, 0]} onClick={event => console.log(event.object)} />
      </>}
    </Merged>
  </Canvas>;
}
```

Optional entry byte counts (bare peers external): @margoengine/react/instances 0 -> 2672 B gzip, ceiling 2928 B; margoengine/react/instances 0 -> 62 B gzip, ceiling 318 B. The bytes retain native refs, per-instance lifecycle, tints, range control and existing Mesh pointer routing; splitting that lifecycle would require another shared context. Core + stage stays 24,797 B gzip.


## Frame priorities and adaptive resolution

`useFrame(callback, priority = 0)` calls `(engine, deltaSeconds)` in ascending finite numeric priority,
with registration order breaking ties. Negative priorities order updates without taking over drawing.
Any positive subscriber takes over drawing for that Canvas: call `engine.render()` from it.
Unmounting the last positive subscriber restores automatic drawing, including demand-mode `invalidate()`.
During an XR frame a manual full-scene draw uses the current eye views. Do not start another animation loop.

```tsx
import { Canvas, Mesh, BoxGeometry, PbrMaterial, useFrame } from '@margoengine/react';
import { PerformanceMonitor, AdaptiveDpr, AdaptiveEvents, usePerformanceMonitor } from '@margoengine/react/performance';

function Draw() {
  const { factor } = usePerformanceMonitor();
  useFrame(engine => engine.render(), 1);
  const size = 0.5 + factor * 0.5;
  return <Mesh scale={[size, size, size]}><BoxGeometry /><PbrMaterial /></Mesh>;
}
export function AdaptiveScene() {
  return <Canvas style={{ height: 400 }}>
    <PerformanceMonitor><AdaptiveDpr /><AdaptiveEvents /><Draw /></PerformanceMonitor>
  </Canvas>;
}
```

The monitor averages measured elapsed milliseconds, rather than instantaneous reciprocal FPS. Its
`refreshrate` is the highest observed window average, not a hardware display query. Hidden pages clear
incomplete windows. Demand mode skips idle intervals unless `sample` supplies measured durations; XR
frames still sample. `sample(engine, delta)` returns milliseconds or `null` to skip. It defaults to elapsed
frame time. This is a quality controller, not a benchmark or a GPU timestamp query.

| Monitor option | Default |
| --- | --- |
| `ms` | `250` milliseconds per averaging window |
| `iterations` | `10` windows per decision |
| `threshold` | `0.75` fraction of windows outside the deadband |
| `factor` | `1`, bounded to `[0, 1]` |
| `step` | `0.1` |
| `bounds(rate)` | `[50, 57]`, or `[50, 90]` when the observed rate exceeds 90 |
| `flipflops` | `Infinity` direction reversals before stable fallback |
| `fallbackFactor` | `0` |
| `onIncline`, `onDecline`, `onChange`, `onFallback` | No callback; each receives the current snapshot |

`usePerformanceMonitor(callbacks = {})` reads `fps`, `refreshrate`, `factor`, `frames`, `averages`,
`flips` and `fallback`, and can subscribe descendant callbacks. Outside React, `new PerformanceController(options)`
uses the same defaults: call `sample(milliseconds)`, read `state`, and release `subscribe`/`observe` subscriptions.
`clear()` drops incomplete measurements, `reset()` also resets quality and fallback, and `dispose()` or `using`
ends its lifetime.

`AdaptiveEvents` pauses hover picking (pointer over, out, enter, leave and move) while the monitor's `factor` is
below 1 and resumes it at 1, as drei's does; presses, clicks, double clicks and the wheel keep picking, so a click is
never lost. It creates a monitor if none encloses it.

`AdaptiveDpr` defaults to `min=0.5`, `max=1`, `pixelated=false` (linear presentation filtering).
It maps quality into that fraction of native Canvas resolution, lowers resolution on decline and restores it
on incline. It creates a monitor if none encloses it. Targets and picking dimensions belong to each Canvas;
CSS size stays fixed, demand mode still draws only when invalidated, and XR uses its eye targets. Unmounting
releases owned targets and restores presentation. Supply `0 < min <= max <= 1`.

## Texture and media ownership

Install the optional `@margoengine/materials` peer for `/textures`. `useTexture(input, options = {})`
accepts a URL, array of URLs or named record and returns the same shape of `Texture` values. It suspends;
wrap callers in `Suspense`. Loads share the Canvas asset cache and are released when Canvas is disposed.
`useKTX2` takes the same inputs and texture options plus `decoder` (default an owned, lazily loaded
`@margoengine/decoders` KTX2Decoder). A supplied decoder is caller owned.

```tsx
import { Suspense } from 'react';
import { Canvas, Scene, Mesh, BoxGeometry, PbrMaterial, RenderView } from '@margoengine/react';
import { TextureProvider, useTexture } from '@margoengine/react/textures';

function PaintedBox() {
  const map = useTexture('/textures/crate.png');
  return <Mesh><BoxGeometry /><PbrMaterial map={map} /></Mesh>;
}
export function TexturedScene() {
  return <Canvas style={{ height: 400 }}>
    <Scene name="paint"><TextureProvider><Suspense fallback={null}>
      <PaintedBox />
    </Suspense></TextureProvider></Scene>
    <RenderView scene="paint" />
  </Canvas>;
}
```

Provide `public/textures/crate.png`. `TextureProvider` enables the root `PbrMaterial` map props without
making the root entry import a material package. `MappedPbrMaterial` enables the same path directly.
Supported root slots are `map`, `normalMap`, `roughnessMap`, `emissiveMap` and `metalRoughnessMap`
(default none); mapped colour defaults to white. Roughness reads green independently of metalness.
`TextureMaterial` accepts native material options or `material` (default none, creating a native Material).
A supplied native material is cloned, so every native material class can be bound without taking ownership
of the caller's material or its textures. `geometry` defaults to the enclosing geometry's retained UV data;
provide it explicitly for custom core geometry without UVs. `roughnessMap` and `transmissionOptions`
default to absent. `onError` defaults to Canvas error reporting. Use one material owner per Mesh.
Named Scenes retain their own queues and cleanup on both WebGPU and the compatibility device.

Texture options default to slot-selected colour space (sRGB for colour slots), clamp wrapping in S/T,
linear min/mag filtering, anisotropy 1, 2D sampling, and flipped external-image Y.
Mipmaps default on for ordinary images, off for video/data; GPU and compressed sources retain their levels.
See [native texture options](../materials/README.md) for raw/GPU/compressed source conventions.
`useVideoTexture(urlOrStream, options = {})` adds `start=true`, `muted=true`, `loop=true`,
`playsInline=true`, `crossOrigin='anonymous'`, `unsuspend='loadedmetadata'` and no `onVideoFrame` callback.
The video is shared, pauses after its last playing consumer leaves, and its source is released with Canvas.
Caller-owned MediaStream tracks remain caller owned. Browser codec and autoplay rules still apply.

Cached model mounts keep independent retained-pixel copies; editing one mount's pixels does not mutate another.
Caller-owned inputs still need their own disposal. Texture hooks and providers do not create a global cache.

## Keyboard, scroll and product controls

`/controls-extra` exports `KeyboardControls`, `useKeyboardControls`, `ScrollControls`, `useScroll`,
`Scroll` and `PresentationControls`. Install `@margoengine/controls` and its optional `@margoengine/tween`
peer for scroll/presentation; keyboard alone needs neither.

```tsx
import { Canvas, Mesh, BoxGeometry, PbrMaterial } from '@margoengine/react';
import { KeyboardControls, useKeyboardControls, ScrollControls, Scroll, PresentationControls } from '@margoengine/react/controls-extra';

const keys = [{ name: 'forward', keys: ['KeyW', 'ArrowUp'] }];
function Product() {
  const forward = useKeyboardControls(state => state.forward);
  return <PresentationControls snap>
    <Mesh><BoxGeometry /><PbrMaterial color={forward ? '#ff8800' : '#84d6bd'} /></Mesh>
  </PresentationControls>;
}
export function ScrollScene() {
  return <KeyboardControls map={keys}><Canvas style={{ height: 400 }}>
    <ScrollControls pages={2}>
      <Scroll><Product /></Scroll>
      <Scroll html><p>Scroll to move through the scene. Hold W to change colour.</p></Scroll>
    </ScrollControls>
  </Canvas></KeyboardControls>;
}
```

Keyboard entries require `name` and `keys` (matching key or code). A one-character key matches in either
case, so `'w'` stays held while Shift or Caps Lock is down; name digits and symbols by code (`'Digit1'`), since
Shift turns `'1'` into `'!'` on most layouts. `up=true` clears on release,
`up=false` latches until focus loss. `domElement` defaults to window, `onChange` to absent.
The selector hook rerenders on changes; the no-argument hook returns `[subscribe, get]` for frame-loop reads.
`subscribe(selector, listener)` returns an unsubscribe function. Blur, hidden pages and unmount clear held keys.

| Scroll option | Default |
| --- | --- |
| `pages`, `distance` | `1`, `1` |
| `horizontal`, `infinite`, `prepend` | `false`, `false`, `false` |
| `damping`, `maxSpeed`, `eps` | `0.2` seconds, `Infinity`, `0.00001` |
| `enabled` | `true` |
| `style`, `onError` | No override; errors go to Canvas |

`ScrollControls` owns the DOM scroller and disposes it and its controller on unmount. `useScroll()` exposes
live `offset`, absolute `delta`, `el`, `fill`, `pages`, `horizontal`, and `range`, `curve`, `visible` helpers
(their optional margin defaults to 0). `Scroll` defaults to mesh translation (`html=false`); `html=true`
creates an owned DOM portal, with no style override by default. Helpers require the enclosing ScrollControls.

Presentation defaults are `enabled=true`, `cursor=true`, no rotation override, canvas event element
(`domElement` overrides native `element`), `polar=[-PI/2, PI/2]`, `azimuth=[-Infinity, Infinity]`,
`speed=1`, `snap=false`, `zoom=1`, `global=false`, and spring stiffness 170, damping 26, precision 0.000001.
No `onError` callback is installed by default. It rotates its child group, updates in the Canvas loop,
restores the cursor and removes controls/listeners on unmount.

### MotionPathControls

`MotionPathControls` and `useMotion` from `/controls-extra` are drei's: they move the Canvas camera (or the `<Mesh>` in
`object`) along `curves`, any 3D curves of `@margoengine/geometry` (`CatmullRomCurve3`, `CubicBezierCurve3`,
`LineCurve3`, ...) joined end to end, by arc length. It looks along the path, or at `focus` (a point or a `<Mesh>` ref),
eased by `focusDamping` (seconds, default 0.1); a mesh turns its +Z to the look-at point. Set `offset` (0..1) and
`current` eases there with the time constant `damping` (seconds, default 0.2; 0 jumps), or leave it out and write
`current` yourself through `useMotion()` or the ref (from a scroll position, in `useFrame`, ...). `loop` (default
true) wraps progress past 1 and eases the short way round. The state also has `point`, `tangent` and `focus` of this
frame. Needs no package beyond the curves.

```tsx
import { useMemo } from 'react';
import { Canvas, Mesh, BoxGeometry, useFrame } from '@margoengine/react';
import { MotionPathControls, useMotion } from '@margoengine/react/controls-extra';
import { CatmullRomCurve3 } from '@margoengine/geometry';

function Fly() {
  const motion = useMotion();
  useFrame((_, delta) => {
    motion.current += delta * 0.05;
  });
  return null;
}
export function Tour() {
  const curves = useMemo(
    () => [new CatmullRomCurve3([[6, 2, 6], [-6, 3, 6], [-6, 2, -6], [6, 3, -6]], true)],
    [],
  );
  return (
    <Canvas style={{ height: 400 }}>
      <Mesh><BoxGeometry /></Mesh>
      <MotionPathControls curves={curves} focus={[0, 0, 0]}>
        <Fly />
      </MotionPathControls>
    </Canvas>
  );
}
```

## Render textures and HUDs

`/portals` exports `RenderTexture` and `Hud`. RenderTexture requires the optional materials peer and
an engine with a WebGPU device, native or compatibility. The legacy WebGL2 renderer without a compatibility
device cannot create these targets. HUDs and render textures own isolated Scenes and cameras; children see
their local camera through hooks. A supplied `camera` is borrowed; otherwise `cameraOptions` defaults to
core Camera defaults. Existing explicit main views are retained.

```tsx
import { useState } from 'react';
import type { Texture } from '@margoengine/materials';
import { Canvas, Mesh, BoxGeometry } from '@margoengine/react';
import { TextureMaterial } from '@margoengine/react/textures';
import { RenderTexture, Hud } from '@margoengine/react/portals';

export function Monitor() {
  const [map, setMap] = useState<Texture | null>(null);
  return <Canvas style={{ height: 400 }}>
    <RenderTexture width={256} height={256} onTexture={setMap}>
      <Mesh><BoxGeometry /></Mesh>
    </RenderTexture>
    <Mesh><BoxGeometry /><TextureMaterial map={map} /></Mesh>
    <Hud><Mesh position={[1, 0, 0]}><BoxGeometry /></Mesh></Hud>
  </Canvas>;
}
```

RenderTexture width/height default to Canvas drawing-buffer dimensions, in physical texels; explicit values
must be positive integers within device limits. `background` defaults to black and `renderPriority=-1`
(must be negative), drawing targets before the main view. `onTexture` defaults to absent and receives the
new texture on creation, resize and device restoration, then null on cleanup. The ref exposes `texture`,
`target`, `scene` and `camera`; do not dispose these borrowed handles. `onError` defaults to Canvas reporting.
Hud defaults to `renderPriority=1` (must be positive), drawing after the main view with fresh depth and
without clearing its colour. React 18/19 StrictMode replay creates fresh owners and releases old targets,
views and Scenes; refs and callbacks refer to the current owner.

### useFBO

`useFBO(width?, height?, options?)` (or `useFBO(options)`), also from `/portals`, is drei's useFBO: a render target
the component owns, null until the materials peer has loaded. Draw into it with a `RenderView` whose `target` is
`fbo.target`, and sample `fbo.texture` in a material. Without `width` and `height` it has the Canvas's drawing-buffer
size and follows its resizes; it is recreated after device restoration and freed on unmount, and each new target is a
new object, so components using it re-render. Options: `format` (default `'rgba8unorm'`), `depth` (default false: a
depth texture in the scene's depth format and sample count, which views then draw into, as drei's `depthBuffer` with
a readable depth texture) and `onError` (default Canvas reporting). Like RenderTexture it needs a WebGPU device,
native or compatibility.

```tsx
import { Canvas, Scene, RenderView, Mesh, BoxGeometry } from '@margoengine/react';
import { TextureMaterial } from '@margoengine/react/textures';
import { useFBO } from '@margoengine/react/portals';

function Screen() {
  const fbo = useFBO(512, 512);
  return <>
    {fbo && <RenderView scene="inside" target={fbo.target} />}
    <Mesh><BoxGeometry /><TextureMaterial map={fbo?.texture ?? null} /></Mesh>
  </>;
}
export function FBOScreen() {
  return <Canvas style={{ height: 400 }}>
    <Scene name="inside" background="#204060"><Mesh><BoxGeometry /></Mesh></Scene>
    <Screen />
  </Canvas>;
}
```

### useDepthBuffer

`useDepthBuffer({ size, frames, onError })`, also from `/portals`, is drei's useDepthBuffer: the scene's depth seen
from the Canvas camera, drawn into a depth texture the component owns before the main view. `size` is its width and
height in texels (default 256); `frames` is how many frames it draws (default `Infinity`, every frame; 1 for a scene
that does not move, after which the texture keeps that depth); `onError` defaults to Canvas reporting. It returns the
`GPUTexture`, or null until it exists, in the scene's depth format and sample count (one sample on the light tier and
phones, else four); a new texture after a device restore. Bind it with `createView({ aspect: 'depth-only' })` as a
`texture_depth_2d` (`texture_depth_multisampled_2d` at four samples). Reverse-Z: 0 is the far clear value, nearer is
larger. Like useFBO it needs a WebGPU device, native or compatibility.

```tsx
import { Canvas, Mesh, BoxGeometry, useFrame } from '@margoengine/react';
import { useDepthBuffer } from '@margoengine/react/portals';

function DepthUser() {
  const depth = useDepthBuffer({ size: 256, frames: 1 });
  useFrame(() => {
    if (depth) console.log('depth texture', depth.width, depth.height, depth.format);
  });
  return null;
}
export function DepthScene() {
  return <Canvas style={{ height: 400 }}>
    <Mesh><BoxGeometry /></Mesh>
    <DepthUser />
  </Canvas>;
}
```

## Stars, sparkles, trails, edges and decals

`/effects-extra` loads native points, lines or geometry only when the corresponding component mounts.
Install `@margoengine/points` for fields, `@margoengine/lines` for trails/edges and
`@margoengine/geometry` plus `@margoengine/materials` for mapped decals.

```tsx
import { Canvas, Mesh, BoxGeometry, PbrMaterial } from '@margoengine/react';
import { Stars, Sparkles, Trail, Edges, Decal, Wireframe } from '@margoengine/react/effects-extra';

export function Effects() {
  return <Canvas style={{ height: 400 }}>
    <Stars count={100} seed={2} />
    <Sparkles count={20} scale={3} />
    <Trail><Mesh><BoxGeometry /><PbrMaterial />
      <Edges threshold={15} />
      <Decal position={[0, 0, 0.5]} scale={0.5} color="#ff8800" />
    </Mesh></Trail>
    <Mesh position={[2, 0, 0]}><BoxGeometry /><PbrMaterial color="#202020" />
      <Wireframe color="#40ff80" width={1.5} />
    </Mesh>
  </Canvas>;
}
```

| Field option | Stars default | Sparkles default |
| --- | --- | --- |
| `count`, `seed` | `5000`, `1` | `100`, `1` |
| `radius`, `depth`, `saturation` | `100`, `50`, `0` | Not exposed |
| Size | `factor=4` | `size=6` |
| `speed` | `1` | `1` |
| `fade` | Pulsing fade when omitted | Not exposed |
| `scale`, `noise` | Not exposed | `1`, `1` (scalar or xyz) |
| `opacity`, `color` | Derived star colours | `1`, white |

Sparkles size/speed/opacity accept one value or a Float32Array with count entries; colour accepts RGB triples
with count*3 entries, and noise accepts xyz or count*3 values. Equal seeds and inputs reproduce the field.
Fields accept at most 1,000,000 points; invalid sizes, arrays or nonfinite inputs reject. Replacing props
rebuilds the field. Both refs expose the native PointCloud and release it on unmount. `onError` is absent
by default for all effects, with Canvas error reporting retained.

Trail follows its first mesh child, or an explicit native `target`; `target={null}` selects manual
`ref.current.moveTo(x, y, z)` sampling. Its defaults are offset `[0,0,0]`, lifetime 1 second,
maxLength Infinity, maxPoints 256, minDistance 0.05, fade 1, white head, matching tail, tailWidth 1,
and no fixed normal (camera-facing). Inherited line styling and defaults are in the
[native lines guide](../lines/README.md). Unmount disposes the trail and its plugin.
Edges uses its enclosing mesh unless `mesh` is explicit, threshold 15 degrees and automatic welding tolerance;
it accepts the same native line styling. Replacing geometry refreshes extracted edges.
Wireframe draws every triangle edge of its enclosing (or `mesh`) mesh once, welding split-normal seams, with the
same line styling (`color`, `width`, `opacity`, dashes, `depthTest`); `simplify` leaves out the edges between flat
neighbours, such as quad diagonals. The mesh's own material is the fill (drei's `fill` and `fillOpacity`), and a
mesh with no visible fill shows the wireframe alone.

Decal projects in the target mesh's local coordinates, inheriting its parent transform. It defaults to
the enclosing mesh, retained source geometry, position/rotation `[0,0,0]`, scale 1, offset `min(scaleX, scaleY) / 1000` and `backfaces=false`. Supply `geometry` for an explicit UV-bearing source;
`mesh` selects an explicit target. Root PBR map props and material children use TextureProvider internally.
React 18/19 StrictMode replay reattaches to the current mesh and releases the old material owner.

### Full-screen shaders

`ScreenQuad` from `@margoengine/react/effects-extra` draws one triangle over the whole screen with a GLSL material, as drei's ScreenQuad: for backgrounds, shader art and overlays. Give it a `fragmentShader` (with `uniforms` and any other `ShaderMaterial` option of `@margoengine/shader/glsl-material`; install `@margoengine/shader`) and it builds the material with `screenQuadVertexShader`, which hands the fragment stage `vUv` from 0 to 1, or pass your own `material`, whose vertex stage reads `position` (x and y from -1 to 3) and `uv`. A uniform's value is copied in when the prop's value changes, and the ref's `material.uniforms` are live, so a clock advanced in `useFrame` is not put back by a later render; `renderOrder` and `visible` are live. Depth and blending are the material's. The ref is the RawMesh.

```tsx
import { useRef, type ComponentRef } from 'react';
import { Canvas, useFrame } from '@margoengine/react';
import { ScreenQuad } from '@margoengine/react/effects-extra';

const fragmentShader = `precision highp float;
uniform float time;
varying vec2 vUv;
void main() { gl_FragColor = vec4(vUv, 0.5 + 0.5 * sin(time), 1.0); }`;

function Background() {
  const quad = useRef<ComponentRef<typeof ScreenQuad>>(null);
  // The ref's uniforms are live: no render per frame.
  useFrame((_, delta) => {
    if (quad.current) (quad.current.material.uniforms.time.value as number) += delta;
  });
  return <ScreenQuad ref={quad} fragmentShader={fragmentShader} uniforms={{ time: { value: 0 } }} depthWrite={false} />;
}

export function ShaderArt() {
  return (
    <Canvas>
      <Background />
    </Canvas>
  );
}
```

## Component tests and offscreen scenes

`/test` requires a browser DOM or a caller-installed jsdom, and optional `@margoengine/headless`.
It installs no DOM globals itself. Mount children directly, without Canvas; by default it owns a GPU-free
null stage. This browser example needs no GPU:

```tsx
import { createElement } from 'react';
import { Mesh, BoxGeometry } from '@margoengine/react';
import { createTestRenderer } from '@margoengine/react/test';

const renderer = await createTestRenderer(createElement(Mesh, null, createElement(BoxGeometry)));
try {
  const [mesh] = renderer.findAll();
  await renderer.advanceFrames(2, 1 / 60);
  await renderer.fireEvent(mesh, 'pointerdown');
  await renderer.fireEvent(mesh, 'pointerup');
  await renderer.update(null);
} finally {
  await renderer.unmount();
}
```

For Node install jsdom, set `globalThis.window` and `globalThis.document` from a JSDOM instance,
and set `globalThis.IS_REACT_ACT_ENVIRONMENT=true` before mounting. Close that DOM afterwards.
`container` defaults to a new body div; `stage` defaults to an owned null stage. A supplied stage is
borrowed and survives unmount. Null-stage width/height default to 1, camera to core defaults,
capacity to 1024 (growing automatically), `signal` to absent and `onError` to core reporting. `findAll(predicate = () => true)` visits live meshes across Scenes;
`advanceFrames(count=1, delta=1/60)` advances hooks/ticks; `fireEvent(target, type, init={})` injects a live
mesh hit or null miss through normal bubbling/capture semantics. It does not test GPU picking pixels.
`update` commits and flushes effects; `unmount` or `await using` releases owned resources.

`/offscreen` keeps React and DOM overlays on the page. Only the required absolute `scene` URL's
`createScene(context)` executes in the worker or page. Install `@margoengine/worker`; use the shared
scene contract in its [README](../worker/README.md), returning a disposable scene owner and calling
`context.attach(engine)`. JSX children are page overlays, never transferred into the worker.
Defaults: `mode='auto'`, `backend='auto'`, width 300, height 150, timeout 30000 milliseconds,
label 'Margo scene', canvas display block and CSS width/height 100%. `data`, `signal`, `worker`,
`className` and callbacks default to absent; `transfer` defaults to no transfers. `style` overrides
canvas CSS, `onCreated` receives the AutoScene owner, and startup failures show a DOM alert and call
`onError` when supplied. Auto probes before transfer and falls back to the page when unsupported;
runtime scene failures are reported without replay. Changing startup props creates a fresh canvas;
unmount aborts and disposes the scene and its owned worker. Keep URL/data/transfer identities stable.

For a minimal offscreen setup, save these two files together and render `WorkerScene` in your page.
The scene module also runs on the page when auto selects fallback. `mode="page"` is useful when debugging.

```tsx
// worker-view.tsx
import { OffscreenCanvas } from '@margoengine/react/offscreen';
const scene = new URL('./shared-scene.ts', import.meta.url);
export function WorkerScene() {
  return <OffscreenCanvas scene={scene} style={{ width: 400, height: 300 }} />;
}
```

```ts
// shared-scene.ts
import { Engine, box, PbrMaterial } from '@margoengine/core';
import type { SceneContext } from '@margoengine/worker/auto';
export async function createScene(context: SceneContext) {
  context.signal.throwIfAborted();
  const engine = await Engine.create(context.canvas);
  if (context.signal.aborted) { engine.dispose(); context.signal.throwIfAborted(); }
  context.attach(engine);
  engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#84d6bd' }));
  engine.start();
  return { dispose() { engine.dispose(); } };
}
```

## Named-scene grids and integration

`Grid` from `/lines` works inside `Scene` with a matching RenderView. Defaults: size 10, divisions 10,
centerColor '#8f8f8f', color '#5e5e5e', position `[0,0,0]`, no onError override. Prop replacement rebuilds
its owned plugin; unmount detaches it from that Scene.

```tsx
import { Canvas, Scene, RenderView } from '@margoengine/react';
import { Grid } from '@margoengine/react/lines';

export function GridScene() {
  return <Canvas style={{ height: 400 }}>
    <Scene name="grid"><Grid size={20} divisions={20} /></Scene>
    <RenderView scene="grid" />
  </Canvas>;
}
```

Works with the [product viewer composition](../../docs/integration-product.md): public optional entries,
React Canvas mounting, device restoration and teardown are exercised together. The linked record gives
its exact reproduction command and measured scope.

## Contributor test setup

Run browser scripts from the repository root, for example
`node packages/react/scripts/test-bindings-browser.mjs`; workspace commands that need the root change
there explicitly. Packed-consumer checks need React, React DOM, jsdom, Testing Library and the declared
package peers installed. Contributor source-inventory tests in a copied consumer use
`MARGOENGINE_TEST_REPOSITORY` pointing to the actual checkout. Temporary subpath consumer files are
disposable generated test inputs, excluded from source inventories.

The build emits core version requirements and declarations with runtime attachment guards. Incompatible
core attachment rejects with a linked version error; rebuild/install matching release packages rather
than bypassing the guard. Material lifecycle proofs observe current plugin identities, including names
reused after StrictMode replay. Performance browser proofs wait for the requested factor, target dimensions
and pipeline readiness instead of assuming a fixed number of frames. The commands and assertions live in
`packages/react/tests` and `packages/react/scripts`.

For UI images, GameUi supplies the UiRoot; use `useUi()` from `@margoengine/ui/react` in a child and
add an imperative `Image` from `@margoengine/ui/image` to that UI in an effect. Remove the widget in the
effect cleanup. The pixel ImageTexture can be shared; it is separate from a 3D material Texture and has
no new React binding. See the [UI image guide](../ui/README.md) for fit, source rectangle, slice and tint defaults.


```tsx
import { useEffect } from 'react';
import { Canvas } from '@margoengine/react';
import { GameUi } from '@margoengine/react/ui';
import { useUi } from '@margoengine/ui/react';
import { Image, ImageTexture } from '@margoengine/ui/image';

const pixels = new ImageTexture(1, 1, new Uint8Array([132, 214, 189, 255]));
function Badge() {
  const ui = useUi();
  useEffect(() => {
    const badge = new Image({ texture: pixels, width: 64, height: 64 });
    ui.add(badge);
    return () => { ui.remove(badge); badge.dispose(); };
  }, [ui]);
  return null;
}
export function ImageScene() {
  return <Canvas style={{ height: 400 }}><GameUi><Badge /></GameUi></Canvas>;
}
```

This image uses the full source, contain fit, no slice, borderScale 1 and opaque white tint by default.
ImageTexture holds copied CPU pixels; the UiRenderer owns atlas residency and releases it with the UI.

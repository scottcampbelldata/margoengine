# React integration without touching the frozen engine

Date: 2026-10-16. Shipped in `@margoengine/react`. Core and the stage facade were not edited. Core plus stage measured 19,999 bytes gzip. The React suite reported 23 passing tests, and the package TypeScript check passed. No `react-reconciler` dependency was added. `sideEffects` stays `false`, and the optional peers stay optional.

`<Stage>` does not construct an engine. `Canvas` still does that, once. `<Stage>` applies the camera, turns shadows on through the canvas's existing shadows request, and renders its children only after that stage is ready. The `Stage` class from `margoengine` is still the object `useMargo()` returns.

## The snippet

PascalCase exports:

```tsx
import { Canvas, Stage, Mesh, BoxGeometry, PbrMaterial } from '@margoengine/react';

export function App() {
  return (
    <Canvas style={{ height: 400 }}>
      <Stage camera={{ position: [0, 2, 5] }} shadows>
        <Mesh position={[0, 1, 0]}>
          <BoxGeometry args={[1, 1, 1]} />
          <PbrMaterial color="#84d6bd" />
        </Mesh>
      </Stage>
    </Canvas>
  );
}
```

Lowercase aliases are namespace members. `mesh`, `boxGeometry`, and `meshStandardMaterial` are the same components. React treats a bare `<mesh>` as a DOM element, including when `mesh` is imported. The JSX that calls the alias is `<Margo.mesh>`:

```tsx
import * as Margo from '@margoengine/react';

<Margo.Canvas>
  <Margo.Stage camera={{ position: [0, 2, 5] }}>
    <Margo.mesh position={[0, 1, 0]}>
      <Margo.boxGeometry args={[1, 1, 1]} />
      <Margo.meshStandardMaterial color="#84d6bd" />
    </Margo.mesh>
  </Margo.Stage>
</Margo.Canvas>
```

Making a bare `<mesh>` work with no import takes a custom reconciler. That was not added.

## What stays put

| Rule | How this holds it |
| --- | --- |
| Core and the stage facade are frozen | No edits under `packages/core` or the `margoengine` stage package. `new Stage(engine)` stays where `MargoCanvas` already calls it. |
| 20,000-byte gzip gate | `@margoengine/react` is a separate package. `npm run measure:size` must still report core plus stage under the gate. |
| Optional and tree-shakable | `sideEffects` stays `false`. `gltf-pro`, `environment`, `controls`, and `shadows` stay optional peers. Shadows stay a dynamic `import()` inside the canvas, which is how it works now. |
| One scene graph | The JSX components call `engine.createMesh()`, `setParent`, `setGeometry`, and `setMaterial`. Unmount returns the dispose function. There is no second graph. |

A `react-reconciler`, the thing React Three Fiber uses, could also live only in `@margoengine/react` and still pass the size gate. It would be a second scene graph beside the one these hooks already dispose correctly under StrictMode. The package README already rules that out. The aliases give the public snippet the names without that second graph.

## Proof

`packages/react/tests/react.test.js` mounts the PascalCase snippet and the `<Margo.mesh>` tree under StrictMode, and it asserts the mesh is created and then disposed. The React README and the example use the same snippets. The reported run was 23 passing React tests, a passing TypeScript check, and core plus stage at 19,999 bytes gzip.

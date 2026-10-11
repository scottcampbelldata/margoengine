# @scottcampbelldata/vexel-react

React 18/19 components for Vexel, with stable mesh refs, nested transforms and frame callbacks.

```sh
npm install @scottcampbelldata/vexel-core @scottcampbelldata/vexel-react react react-dom
```

```tsx
'use client';
import { Canvas, Mesh, BoxGeometry, PbrMaterial } from '@scottcampbelldata/vexel-react';

export default function App() {
  return <Canvas style={{ height: 400 }}>
    <Mesh><BoxGeometry /><PbrMaterial color="#84d6bd" roughness={0.3} /></Mesh>
  </Canvas>;
}
```

Use `useFrame` to mutate mesh refs without scheduling React renders. `Canvas` owns engine setup and disposal. This ESM package preserves its `use client` directive and includes TypeScript declarations; it requires `@scottcampbelldata/vexel-core` 0.1.0 and React 18 or 19.

See the [React API and lifecycle guide](https://github.com/scottcampbelldata/vexel/blob/main/MODERN-ENGINE.md).

MIT licensed.

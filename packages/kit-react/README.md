# @margoengine/kit-react

This profile is retired. New apps install `@margoengine/web` and `@margoengine/react`. The package remains so existing imports keep working.

Install profile. React and Next.js web apps. Retired: install @margoengine/web and @margoengine/react..

It holds no code of its own and only re-exports its member packages: it installs only its declared domain members and forwards their original typed modules.
The root contains common exports; member subpaths expose the complete installed member APIs.
All packages release together at one version. Optional third-party peers remain app choices.

See the [kits guide](https://margoengine.com/llms/docs/guides/kits.md) for profile contents, independent installs,
model-loading entries and measured package counts.

With a `<div id="root"></div>` in the page:

```tsx
import {createRoot} from 'react-dom/client';
import {Canvas, Mesh, BoxGeometry, PbrMaterial} from '@margoengine/kit-react';

function App() {
  return (
    <Canvas style={{height: 400}}>
      <Mesh position={[0, 1, 0]}>
        <BoxGeometry args={[1, 1, 1]} />
        <PbrMaterial color="#84d6bd" />
      </Mesh>
    </Canvas>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
```

Model loading is a separate import: `import {loadGLTF} from '@margoengine/kit-react/gltf/pbr'`.

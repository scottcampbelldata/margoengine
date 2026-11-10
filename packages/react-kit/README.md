# @margoengine/react-kit

The web install profile with React bindings and sky.

This package installs only its declared domain members and forwards their original typed modules.
The root contains common exports; member subpaths expose the complete installed member APIs.
All packages release together at one version. Optional third-party peers remain app choices.

See the [kits guide](https://margoengine.com/llms/guides/kits.md) for profile contents, independent installs,
model-loading entries and measured package counts.

With a `<div id="viewport" style="height:400px"></div>` in the page and a `<div id="root"></div>` for React:

```tsx
import {createRoot} from 'react-dom/client';
import {Canvas, Mesh, BoxGeometry, PbrMaterial} from '@margoengine/react-kit';

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

Model loading is a separate import: `import {loadGLTF} from '@margoengine/react-kit/gltf-pro'`.

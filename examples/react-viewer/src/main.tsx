import React, { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { box, PbrMaterial, type Mesh } from '@margoengine/core';
import { MargoCanvas, Model, Environment, OrbitControls, useMargoStage, useFrame } from '@margoengine/react';
import './style.css';

function ImperativeCube() {
  const engine = useMargoStage(), mesh = useRef<Mesh | null>(null);
  useEffect(() => {
    const cube = engine.createMesh();
    cube.setGeometry(box()).setMaterial(new PbrMaterial({color: '#84d6bd', roughness: 0.3}));
    mesh.current = cube;
    return () => {mesh.current = null; cube.dispose();};
  }, [engine]);
  useFrame((_, delta) => {if (mesh.current) mesh.current.rotation.y += delta;});
  return null;
}
function App() {
  const [visible, setVisible] = useState(true), [mode, setMode] = useState('declarative'), [raised, setRaised] = useState(false);
  return <main>
    <h1>Margo React viewer</h1>
    <p>Choose JSX model loading or an imperative mesh built with useMargoStage(). Drag to orbit; resize using the bottom corner.</p>
    <label>Workflow <select value={mode} onChange={event => setMode(event.target.value)}>
      <option value="declarative">Declarative Model</option><option value="imperative">Imperative mesh</option>
    </select></label>
    <button onClick={() => setVisible(value => !value)}>{visible ? 'Unmount viewer' : 'Mount viewer'}</button>
    {mode === 'declarative' && <button onClick={() => setRaised(value => !value)}>{raised ? 'Reset model' : 'Move model without reloading'}</button>}
    <div className="viewer">{visible && <MargoCanvas camera={{position: [0, 1.5, 4], target: [0, 0, 0]}} backend={mode === 'declarative' ? 'webgpu' : 'auto'}>
      <Environment exposure={1} />
      <OrbitControls enableDamping minDistance={1} maxDistance={12} />
      {mode === 'declarative'
        ? <Model src="/triangle.gltf" position={[0, raised ? 0.5 : 0, 0]} materials={{Upper: {baseColor: [0.52, 0.84, 0.74], roughness: 0.3}}} />
        : <ImperativeCube />}
    </MargoCanvas>}</div>
  </main>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<StrictMode><App /></StrictMode>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());

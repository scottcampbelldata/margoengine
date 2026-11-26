// The usual React Three Fiber version of this task calls the glTF loader hook with a URL inside a component wrapped in
// Suspense, renders the loaded scene object through the primitive element, and reads the loading percentage from a
// progress hook for the fallback. In Margo the Model component takes the URL itself, suspends while it loads, is cached
// per Canvas and is disposed when it unmounts.
import { Suspense } from 'react';
import { Canvas, Sun, useProgress } from '@margoengine/react';
import { Model } from '@margoengine/react/gltf';

function Loading() {
  const { progress } = useProgress(); // 0 to 100
  return <span>Loading {Math.round(progress)}%</span>;
}

export function Helmet() {
  return (
    <>
      <Sun direction={[2, 4, 3]} intensity={3} />
      <Suspense fallback={<Loading />}>
        <Model
          src="/models/DamagedHelmet.glb"
          position={[0, 1, 0]}
          rotation={[0, Math.PI / 4, 0]}
          onLoad={(root) => console.log('loaded', root.name)}
        />
      </Suspense>
    </>
  );
}

export function App() {
  return (
    <Canvas style={{ height: 400 }} camera={{ position: [0, 1.5, 4], target: [0, 1, 0] }}>
      <Helmet />
    </Canvas>
  );
}

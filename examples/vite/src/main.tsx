import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, Mesh, BoxGeometry, PbrMaterial, useFrame, type MeshRef } from '@margoengine/react';
import { CADCameraControls } from 'margoengine';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';
import { meshRuntime } from '@margoengine/core/extension';
import type { Engine } from '@margoengine/core/extension';
import type { PostProcessing } from '@margoengine/creative';
import './style.css';

function Cube({ metalness, onMesh }: { metalness: number; onMesh: (mesh: MeshRef | null) => void }) {
  const cube = useRef<MeshRef>(null);
  useFrame((_, delta) => {
    if (cube.current) {
      cube.current.rotation.y += delta * 0.5;
      cube.current.rotation.x += delta * 0.2;
    }
  });
  return (
    <Mesh
      ref={(mesh) => {
        cube.current = mesh;
        onMesh(mesh);
      }}
    >
      <BoxGeometry args={[1.6, 1.6, 1.6]} />
      <PbrMaterial color="#84d6bd" roughness={0.3} metalness={metalness} />
      <Mesh position={[1.4, 0, 0]} scale={[0.35, 0.35, 0.35]}>
        <BoxGeometry />
        <PbrMaterial color="#ffa76c" roughness={0.55} />
      </Mesh>
    </Mesh>
  );
}
function App() {
  const engine = useRef<Engine | null>(null),
    model = useRef<{ dispose(): void } | null>(null);
  const post = useRef<PostProcessing | null>(null);
  const controls = useRef<CADCameraControls | null>(null);
  const [selection, setSelection] = useState('');
  const cube = useRef<MeshRef | null>(null);
  const pointerStart = useRef<readonly [number, number] | null>(null);
  const [backend, setBackend] = useState('Starting…'),
    [metalness, setMetalness] = useState(0.45),
    [status, setStatus] = useState('');
  const [scenery, setScenery] = useState(false),
    [sceneryLoading, setSceneryLoading] = useState(false);
  async function importModel() {
    if (!engine.current) return;
    setStatus('Loading model…');
    try {
      const { loadGLTF } = await import('@margoengine/gltf');
      const loaded = await loadGLTF(engine.current, '/triangle.gltf');
      model.current?.dispose();
      model.current = loaded;
      loaded.root.position.x = -2.2;
      setStatus('Static glTF loaded');
    } catch (error) {
      setStatus(String(error));
    }
  }
  async function toggleLeaves() {
    try {
      const { GPUParticles } = await import('@margoengine/creative'),
        e = engine.current;
      if (!e) return;
      if (e.backend !== 'webgpu') {
        setStatus('GPU particles need WebGPU');
        return;
      }
      if (e.hasPlugin('gpu-particles')) {
        e.removePlugin('gpu-particles');
        setStatus('Particles removed');
      } else {
        GPUParticles.attach(e, {
          count: 5000,
          sort: true,
          curl: 0.2,
          obstacles: [{ kind: 'sphere', center: [0, 0, 0], radius: 1 }],
        });
        setStatus('Creative: 5,000 GPU leaves');
      }
    } catch (error) {
      setStatus(String(error));
    }
  }
  async function toggleScenery() {
    const e = engine.current;
    if (!e) return;
    if (e.backend !== 'webgpu') {
      setStatus('Moonlit scenery needs WebGPU');
      return;
    }
    try {
      if (e.hasPlugin('sky-moon')) {
        e.removePlugin('sky-moon');
        setScenery(false);
        setStatus('Scenery removed');
      } else {
        setSceneryLoading(true);
        setStatus('Loading scenery…');
        const { SkyMoon } = await import('@margoengine/scenery');
        if (engine.current !== e || e.disposed) return;
        SkyMoon.attach(e, { moonDirection: [0.45, 0, -1] });
        setScenery(true);
        setStatus('Scenery: moonlit sky');
      }
      // Scenery supplies horizon haze; post fog would obscure its depth-0 backdrop.
      const atmosphere = post.current?.options.atmosphere;
      if (atmosphere) atmosphere.density = e.hasPlugin('sky-moon') ? 0 : 0.025;
    } catch (error) {
      setStatus(String(error));
    } finally {
      setSceneryLoading(false);
    }
  }
  async function toggleFX() {
    try {
      const [{ PostProcessing }, { Bloom }, { PostStack }] = await Promise.all([
          import('@margoengine/creative/post'),
          import('@margoengine/post/bloom'),
          import('@margoengine/post/stack'),
        ]),
        e = engine.current;
      if (!e) return;
      if (e.hasPlugin('post:stack')) {
        e.removePlugin('post:stack');
        post.current = null;
        setStatus('Effects removed');
      } else {
        const effect = new PostProcessing({
          focus: 5,
          aperture: 2,
          grain: 0.02,
          atmosphere: { density: e.hasPlugin('sky-moon') ? 0 : 0.025, heightFalloff: 0.1, godRays: 0.2 },
        });
        PostStack.attach(e, [new Bloom({ strength: 0.5, threshold: 0.4 }), effect]);
        post.current = effect;
        setStatus('Bloom, atmosphere and FX');
      }
    } catch (error) {
      setStatus(String(error));
    }
  }
  async function toggleToon() {
    try {
      const { ToonShading } = await import('@margoengine/creative'),
        e = engine.current;
      if (!e) return;
      if (e.hasPlugin('toon-shading')) {
        e.removePlugin('toon-shading');
        setStatus('Toon removed');
      } else {
        ToonShading.attach(e);
        setStatus('Creative: toon shading');
      }
    } catch (error) {
      setStatus(String(error));
    }
  }
  async function selectPart(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.altKey || event.shiftKey) return;
    const e = engine.current;
    if (!e) return;
    try {
      const rect = e.canvas.getBoundingClientRect(),
        mesh = await e.pick(event.clientX - rect.left, event.clientY - rect.top);
      setSelection(mesh?.name || 'No part selected');
      if (mesh && event.ctrlKey) {
        const m = meshRuntime(mesh).matrix;
        controls.current?.setPivot([m[12], m[13], m[14]]);
      }
    } catch (error) {
      setStatus(String(error));
    }
  }
  async function restoreDevice() {
    try {
      await engine.current?.rebootDevice();
      setStatus('GPU restored; scene retained');
    } catch (error) {
      setStatus(String(error));
    }
  }
  return (
    <main>
      <header>
        <span className="brand">
          MARGOENGINE <span>ENGINE</span>
        </span>
        <span className="badge">Rust / Wasm + {backend}</span>
      </header>
      <section>
        <div className="copy">
          <p className="eyebrow">A SMALLER FOUNDATION</p>
          <h1>
            Built for
            <br />
            the web.
          </h1>
          <p>Shared transform memory. Native GPU passes. React components that stay out of the frame loop.</p>
          <label htmlFor="metalness">
            Metalness <output>{metalness.toFixed(2)}</output>
          </label>
          <input
            id="metalness"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={metalness}
            onChange={(event) => setMetalness(Number(event.target.value))}
          />
          <button onClick={importModel}>Load glTF module</button>
          <button onClick={toggleLeaves}>Toggle GPU leaves</button>
          <button onClick={toggleScenery} aria-pressed={scenery} disabled={sceneryLoading}>
            Toggle moonlit scenery
          </button>
          <details>
            <summary>Domain tools</summary>
            <button onClick={toggleFX}>Toggle atmosphere and FX</button>
            <button onClick={toggleToon}>Toggle toon shading</button>
            <button onClick={restoreDevice}>Restore GPU device</button>
            <p aria-live="polite">{selection}</p>
            <p>Drag to orbit; Shift/right drag to pan; wheel to zoom. Ctrl-click sets the pivot.</p>
          </details>
          <p role="status" className="status">
            {status}
          </p>
        </div>
        <div
          className="scene"
          onPointerDown={(event) => {
            pointerStart.current = [event.clientX, event.clientY];
          }}
          onPointerUp={(event) => {
            const p = pointerStart.current;
            pointerStart.current = null;
            if (p && Math.hypot(event.clientX - p[0], event.clientY - p[1]) < 4) void selectPart(event);
          }}
        >
          <Canvas
            fallback={webglRenderer}
            label="Rotating mint cube with an orange child cube"
            onCreated={({ engine: value }) => {
              engine.current = value as unknown as Engine;
              controls.current?.dispose();
              controls.current = new CADCameraControls(value.camera, value.canvas);
              const current = controls.current;
              value.onFrame((_, delta) => current.update(delta));
              const dispose = value.dispose.bind(value);
              value.dispose = () => {
                if (engine.current === value) engine.current = null;
                current.dispose();
                dispose();
              };
              post.current = null;
              setScenery(false);
              setBackend(value.backend);
            }}
            onError={(error) => setStatus(String(error))}
          >
            <Cube
              metalness={metalness}
              onMesh={(mesh) => {
                cube.current = mesh;
              }}
            />
          </Canvas>
        </div>
      </section>
      <footer>
        <span>01 / THE MICRO-KERNEL</span>
        <span>Core · glTF · React · Domain packs</span>
      </footer>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

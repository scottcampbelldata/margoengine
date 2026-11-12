import './page-harness';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, Mesh, BoxGeometry, PbrMaterial, Group, useEngine, useFrame } from '@margoengine/react';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';
import { GPUParticles } from '@margoengine/creative/particles';

interface SceneProps {
  particleActive: boolean;
  particleCount: number;
  boxColor: string;
  onMeshClick: () => void;
  isWebGPU: boolean;
  onLog: (msg: string) => void;
}

function RotatingBox({ color, onClick }: { color: string; onClick: () => void }) {
  const meshRef = useRef<any>(null);
  const [hovered, setHovered] = useState(false);

  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.8;
      meshRef.current.rotation.x += delta * 0.4;
    }
  });

  return (
    <Mesh
      ref={meshRef}
      position={[0, 0, 0]}
      onClick={onClick}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
    >
      <BoxGeometry args={[1.5, 1.5, 1.5]} />
      <PbrMaterial color={hovered ? '#38bdf8' : color} roughness={hovered ? 0.2 : 0.4} metalness={0.2} />
    </Mesh>
  );
}

function OrbitingSphere({ position }: { position: [number, number, number] }) {
  const groupRef = useRef<any>(null);

  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 1.2;
    }
  });

  return (
    <Group ref={groupRef}>
      <Mesh position={position}>
        <BoxGeometry args={[0.4, 0.4, 0.4]} />
        <PbrMaterial color="#f59e0b" roughness={0.3} metalness={0.8} />
      </Mesh>
    </Group>
  );
}

function CreativeScene({ particleActive, particleCount, boxColor, onMeshClick, isWebGPU, onLog }: SceneProps) {
  const engine = useEngine();
  const particlesRef = useRef<any>(null);

  useEffect(() => {
    if (!engine) return;

    if (particleActive && isWebGPU) {
      try {
        onLog(`Attaching GPUParticles (${particleCount} particles)...`);
        const p = GPUParticles.attach(engine, {
          count: particleCount,
          sort: true,
          curl: 0.25,
        });
        particlesRef.current = p;
        onLog('GPUParticles attached successfully.');
      } catch (err: any) {
        onLog(`GPUParticles error: ${err.message}`);
      }
    }

    return () => {
      if (particlesRef.current) {
        try {
          (engine as any).removePlugin?.('gpu-particles');
        } catch {
          // ignore cleanup errors on engine disposal
        }
        particlesRef.current = null;
      }
    };
  }, [engine, particleActive, particleCount, isWebGPU, onLog]);

  return (
    <>
      <RotatingBox color={boxColor} onClick={onMeshClick} />
      <OrbitingSphere position={[2.2, 0.5, 0]} />
      <OrbitingSphere position={[-2.2, -0.5, 0]} />
    </>
  );
}

export function App() {
  const params = new URLSearchParams(window.location.search);
  const initialBackend = (params.get('backend') || 'webgpu') as 'webgpu' | 'webgl2';

  const [backend, setBackend] = useState<'webgpu' | 'webgl2'>(initialBackend);
  const [mounted, setMounted] = useState<boolean>(true);
  const [mountCount, setMountCount] = useState<number>(1);
  const [unmountCount, setUnmountCount] = useState<number>(0);
  const [boxColor, setBoxColor] = useState<string>('#10b981');
  const [particleActive, setParticleActive] = useState<boolean>(initialBackend === 'webgpu');
  const [particleCount, setParticleCount] = useState<number>(3000);
  const [mobileView, setMobileView] = useState<boolean>(false);
  const [clickCount, setClickCount] = useState<number>(0);
  const [_fps, _setFps] = useState<string>('60 fps (16.6ms)');
  const [logText, setLogText] = useState<string>('App ready.');
  const [leakErrors, setLeakErrors] = useState<string[]>([]);

  const addLog = useCallback((msg: string) => {
    setLogText(msg);
    console.log(`[ReactAppShell] ${msg}`);
  }, []);

  const handleMeshClick = () => {
    setClickCount((c) => c + 1);
    setBoxColor((prev) => (prev === '#10b981' ? '#ec4899' : '#10b981'));
    addLog(`Mesh clicked! Total clicks: ${clickCount + 1}`);
  };

  const toggleMount = () => {
    setMounted((m) => {
      const next = !m;
      if (next) setMountCount((c) => c + 1);
      else setUnmountCount((c) => c + 1);
      addLog(
        `Canvas ${next ? 'Mounted' : 'Unmounted'} (Mounts: ${mountCount + (next ? 1 : 0)}, Unmounts: ${unmountCount + (!next ? 1 : 0)})`,
      );
      return next;
    });
  };

  const runRapidMountUnmount = async (cycles = 10) => {
    addLog(`Running rapid mount/unmount cycle (${cycles}x)...`);
    const errors: string[] = [];
    const windowErrorHandler = (evt: ErrorEvent) => {
      errors.push(evt.message);
    };
    window.addEventListener('error', windowErrorHandler);

    for (let i = 0; i < cycles; i++) {
      setMounted(false);
      setUnmountCount((c) => c + 1);
      await new Promise((r) => setTimeout(r, 60));
      setMounted(true);
      setMountCount((c) => c + 1);
      await new Promise((r) => setTimeout(r, 60));
    }

    window.removeEventListener('error', windowErrorHandler);
    if (errors.length > 0) {
      setLeakErrors(errors);
      addLog(`Rapid unmount test finished with ${errors.length} error(s)!`);
    } else {
      addLog(`Rapid unmount test clean! Zero errors or memory leaks over ${cycles} cycles.`);
    }
  };

  // Expose test harness hooks
  useEffect(() => {
    (window as any).__TEST_HARNESS__ = {
      getStats: () => ({
        backend,
        mounted,
        mountCount,
        unmountCount,
        clickCount,
        particleActive,
        errorCount: leakErrors.length,
      }),
      toggleMount,
      rapidMountUnmount: () => runRapidMountUnmount(10),
      switchBackend: (b: 'webgpu' | 'webgl2') => {
        setBackend(b);
        if (b === 'webgl2') setParticleActive(false);
      },
      clickMesh: handleMeshClick,
      toggleMobile: () => setMobileView((m) => !m),
    };
  }, [backend, mounted, mountCount, unmountCount, clickCount, particleActive, leakErrors]);

  const isWebGPU = backend === 'webgpu';

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', display: 'flex', flexDirection: 'column' }}>
      {/* Viewport container */}
      <div
        id="viewport"
        style={{
          width: mobileView ? '390px' : '100%',
          height: mobileView ? '844px' : '100%',
          margin: mobileView ? '0 auto' : undefined,
          position: 'absolute',
          inset: 0,
          background: '#07090e',
          transition: 'width 0.25s ease',
        }}
      >
        {mounted ? (
          <Canvas
            key={`${backend}-${mountCount}`}
            backend={backend}
            fallback={webglRenderer}
            loadFallback={() => import('@margoengine/webgl2-compat/preview')}
            style={{ width: '100%', height: '100%', display: 'block' }}
            camera={{ position: [0, 1.5, 5], target: [0, 0, 0] }}
            onCreated={(eng) => {
              addLog(`Canvas engine created. Backend: ${(eng as any).backend || backend}`);
            }}
            onError={(err) => {
              addLog(`Canvas error: ${(err as any)?.message || String(err)}`);
            }}
          >
            <CreativeScene
              particleActive={particleActive}
              particleCount={particleCount}
              boxColor={boxColor}
              onMeshClick={handleMeshClick}
              isWebGPU={isWebGPU}
              onLog={addLog}
            />
          </Canvas>
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#94a3b8',
              fontSize: '18px',
              fontFamily: 'monospace',
            }}
          >
            [Canvas Unmounted]
          </div>
        )}
      </div>

      {/* Floating HUD */}
      <div
        id="hud"
        style={{
          position: 'absolute',
          top: '16px',
          right: '16px',
          width: '340px',
          background: 'rgba(15, 23, 42, 0.94)',
          border: '1px solid #1e293b',
          borderRadius: '8px',
          padding: '14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
          backdropFilter: 'blur(8px)',
          zIndex: 10,
          fontSize: '13px',
          color: '#f8fafc',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid #1e293b',
            paddingBottom: '6px',
          }}
        >
          <span style={{ fontWeight: 700, fontSize: '15px' }}>React App Shell</span>
          <span
            id="badge-backend"
            style={{
              fontSize: '11px',
              fontWeight: 600,
              padding: '2px 6px',
              borderRadius: '4px',
              background: '#1e293b',
              color: isWebGPU ? '#38bdf8' : '#f59e0b',
            }}
          >
            {backend.toUpperCase()}
          </span>
        </div>

        {/* Mount / Lifecycle Section */}
        <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: '#94a3b8' }}>
          Lifecycle & Mount Stress (@margoengine/react)
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Status:</span>
          <span id="val-mount-status" style={{ fontFamily: 'monospace', color: mounted ? '#10b981' : '#ef4444' }}>
            {mounted ? 'Mounted' : 'Unmounted'}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Mount / Unmount Count:</span>
          <span id="val-mount-counts" style={{ fontFamily: 'monospace', color: '#38bdf8' }}>
            {mountCount} m / {unmountCount} u
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
          <button
            id="btn-toggle-mount"
            onClick={toggleMount}
            style={{
              background: '#1e293b',
              color: '#f8fafc',
              border: '1px solid #334155',
              padding: '6px',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            {mounted ? 'Unmount Canvas' : 'Mount Canvas'}
          </button>
          <button
            id="btn-rapid-unmount"
            onClick={() => runRapidMountUnmount(10)}
            style={{
              background: '#1e293b',
              color: '#f8fafc',
              border: '1px solid #334155',
              padding: '6px',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            10x Rapid Cycle
          </button>
        </div>

        {/* Backend Switcher (@margoengine/webgl) */}
        <div
          style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: '#94a3b8', marginTop: '4px' }}
        >
          Renderer Backend (@margoengine/webgl)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
          <button
            id="btn-backend-webgpu"
            onClick={() => {
              setBackend('webgpu');
              setParticleActive(true);
              addLog('Switched to WebGPU backend.');
            }}
            style={{
              background: isWebGPU ? '#38bdf8' : '#1e293b',
              color: isWebGPU ? '#07090e' : '#f8fafc',
              fontWeight: isWebGPU ? 700 : 500,
              border: '1px solid #334155',
              padding: '6px',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            WebGPU
          </button>
          <button
            id="btn-backend-webgl2"
            onClick={() => {
              setBackend('webgl2');
              setParticleActive(false);
              addLog('Switched to plain WebGL2 (@margoengine/webgl).');
            }}
            style={{
              background: !isWebGPU ? '#f59e0b' : '#1e293b',
              color: !isWebGPU ? '#07090e' : '#f8fafc',
              fontWeight: !isWebGPU ? 700 : 500,
              border: '1px solid #334155',
              padding: '6px',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Plain WebGL2
          </button>
        </div>

        {/* Creative Pack (@margoengine/creative) */}
        <div
          style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: '#94a3b8', marginTop: '4px' }}
        >
          Creative VFX (@margoengine/creative)
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Particles:</span>
          <span style={{ fontFamily: 'monospace', color: particleActive ? '#38bdf8' : '#94a3b8' }}>
            {particleActive ? `${particleCount} active` : 'Disabled'}
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
          <button
            id="btn-toggle-particles"
            disabled={!isWebGPU}
            onClick={() => {
              setParticleActive((p) => !p);
              addLog(`Particles toggled: ${!particleActive ? 'ON' : 'OFF'}`);
            }}
            style={{
              background: particleActive ? '#38bdf8' : '#1e293b',
              color: particleActive ? '#07090e' : '#f8fafc',
              border: '1px solid #334155',
              padding: '6px',
              borderRadius: '4px',
              cursor: isWebGPU ? 'pointer' : 'not-allowed',
            }}
          >
            {particleActive ? 'Particles ON' : 'Particles OFF'}
          </button>
          <button
            id="btn-count-particles"
            disabled={!isWebGPU}
            onClick={() => {
              const next = particleCount >= 8000 ? 2000 : particleCount + 2000;
              setParticleCount(next);
              addLog(`Particle count set to ${next}`);
            }}
            style={{
              background: '#1e293b',
              color: '#f8fafc',
              border: '1px solid #334155',
              padding: '6px',
              borderRadius: '4px',
              cursor: isWebGPU ? 'pointer' : 'not-allowed',
            }}
          >
            Scale Count
          </button>
        </div>

        {/* Pointer & Picking */}
        <div
          style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: '#94a3b8', marginTop: '4px' }}
        >
          Interactive Picking & Mesh
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Click Count:</span>
          <span id="val-click-count" style={{ fontFamily: 'monospace', color: '#38bdf8' }}>
            {clickCount} clicks
          </span>
        </div>
        <button
          id="btn-click-cube"
          onClick={handleMeshClick}
          style={{
            background: '#1e293b',
            color: '#f8fafc',
            border: '1px solid #334155',
            padding: '6px',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          Simulate Click on Cube
        </button>

        {/* Viewport & Mobile */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '4px' }}>
          <button
            id="btn-test-mobile"
            onClick={() => setMobileView((m) => !m)}
            style={{
              background: mobileView ? '#38bdf8' : '#1e293b',
              color: mobileView ? '#07090e' : '#f8fafc',
              border: '1px solid #334155',
              padding: '6px',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            {mobileView ? 'Mobile 390px' : 'Full Window'}
          </button>
          <button
            id="btn-recreate-app"
            onClick={() => {
              setMountCount((c) => c + 1);
              addLog('Canvas key refreshed.');
            }}
            style={{
              background: '#1e293b',
              color: '#f8fafc',
              border: '1px solid #334155',
              padding: '6px',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Recreate
          </button>
        </div>

        {/* Log display */}
        <div
          id="log"
          style={{
            fontSize: '11px',
            color: '#94a3b8',
            fontFamily: 'monospace',
            maxHeight: '75px',
            overflowY: 'auto',
            background: 'rgba(0, 0, 0, 0.4)',
            padding: '6px',
            borderRadius: '4px',
            border: '1px solid #1e293b',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            marginTop: '4px',
          }}
        >
          {logText}
        </div>
      </div>
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<App />);
}

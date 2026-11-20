// <Svg>, <ScreenQuad> and <Text3D smooth> on a real GPU, WebGPU or the WebGL2 compatibility layer: each mode mounts two
// canvases in StrictMode and the script reads their screenshots (scripts/test-shapes-browser.mjs).
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, PbrMaterial, useFrame } from '@margoengine/react';
import { Svg } from '@margoengine/react/geometry';
import { ScreenQuad } from '@margoengine/react/effects-extra';
import { Text3D } from '@margoengine/react/text';
import { engineRuntime } from '@margoengine/core/extension';

// Source Sans 3, SIL OFL 1.1, packages/text/tests/fixtures/fonts/NOTICE.md.
const font = '/packages/text/tests/fixtures/fonts/SourceSans3-Regular.ttf';
// A red square fill on the left, a blue unfilled stroked square on the right.
const drawing = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect x="0" y="20" width="40" height="60" fill="#ff0000"/>
<rect x="60" y="25" width="30" height="50" fill="none" stroke="#0000ff" stroke-width="8"/></svg>`;
// vUv as red and green, so each corner of the screen shows its own uv.
const fragmentShader = `precision highp float;
varying vec2 vUv;
void main() { gl_FragColor = vec4(vUv.x, vUv.y, 0.0, 1.0); }`;
const state = { frames: [0, 0], ready: [false, false], errors: [] as string[], engines: [] as ReturnType<typeof engineRuntime>[] };
function Count({ side }: { side: number }) {
  useFrame(() => {
    state.frames[side]++;
  });
  return null;
}
function Body({ side, mode }: { side: number; mode: string }) {
  if (mode === 'svg')
    return side ? (
      <Svg src={drawing} flipY scale={[0.04, 0.04, 0.04]} position={[-2, 2, 0]} onLoad={() => (state.ready[side] = true)} />
    ) : (
      <Svg src={drawing} flipY skipStrokes scale={[0.04, 0.04, 0.04]} position={[-2, 2, 0]} onLoad={() => (state.ready[side] = true)} />
    );
  if (mode === 'screenquad') {
    state.ready[side] = true;
    return side ? <ScreenQuad fragmentShader={fragmentShader} depthWrite={false} /> : null;
  }
  return (
    <Text3D
      font={font}
      size={3.2}
      height={0.6}
      curveSegments={8}
      bevelEnabled
      bevelSize={0.12}
      bevelThickness={0.12}
      bevelSegments={1}
      smooth={side ? 0.0001 : undefined}
      position={[-1.2, -1.1, 0]}
      rotation={[0, 0.5, 0]}
      onBuild={() => (state.ready[side] = true)}
    >
      O
      <PbrMaterial color="#e0a96a" metalness={0} roughness={0.35} />
    </Text3D>
  );
}
const root = createRoot(document.querySelector('#app')!);
Object.assign(window, {
  shapes: {
    state,
    mount(mode: string, backend: 'webgpu' | 'webgl2') {
      state.frames = [0, 0];
      state.ready = [false, false];
      state.errors = [];
      root.render(
        <StrictMode>
          {[0, 1].map((side) => (
            <section key={side} data-side={side}>
              <Canvas
                key={mode + backend}
                backend={backend}
                loadFallback={backend === 'webgl2' ? () => import('@margoengine/webgl2-compat/preview') : undefined}
                camera={{ position: [0, 0, 6], target: [0, 0, 0] }}
                onCreated={(stage) => {
                  state.engines[side] = engineRuntime(stage.engine);
                }}
                onError={(error) => state.errors.push(String(error))}
              >
                <Count side={side} />
                <Body side={side} mode={mode} />
              </Canvas>
            </section>
          ))}
        </StrictMode>,
      );
    },
    unmount() {
      root.unmount();
    },
  },
});

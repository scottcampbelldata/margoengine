// Real-GPU proofs of the reflection components, one mode each, on WebGPU and the WebGL2 compatibility layer.
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, Mesh, PbrMaterial, RenderView, Scene, useFrame } from '@margoengine/react';
import { PlaneGeometry, SphereGeometry } from '@margoengine/react/geometry';
import { CubeCamera, Environment, Fog, Lightformer } from '@margoengine/react/environment';
import { MappedPbrMaterial, TextureMaterial } from '@margoengine/react/textures';
import { MeshReflectorMaterial } from '@margoengine/react/materials';

const state = { frames: 0, errors: [] as string[] };
function Count() {
  useFrame(() => state.frames++);
  return null;
}
// A red emissive wall behind the canvas camera: only a reflection can bring it into view.
function Wall() {
  return (
    <Mesh position={[0, 0, 7]} rotation={[0, Math.PI, 0]}>
      <PlaneGeometry args={[40, 40]} />
      <TextureMaterial color="#000000" emissive={[1, 0, 0]} />
    </Mesh>
  );
}
// A mirror ball: its centre faces the canvas camera, so it reflects what lies behind that camera.
const ball = (envMap?: GPUTexture) => (
  <Mesh>
    <SphereGeometry args={[1, 48, 24]} />
    <MappedPbrMaterial color="#ffffff" metalness={1} roughness={0} envMap={envMap ?? null} />
  </Mesh>
);
const modes: Record<string, () => React.ReactNode> = {
  'cube-camera': () => (
    <>
      <Wall />
      <CubeCamera resolution={128}>{(texture) => ball(texture)}</CubeCamera>
    </>
  ),
  // Faces fogged green by the CubeCamera's own fog (the scene has none): the wall 7 units away is fully fogged.
  'cube-camera-fog': () => (
    <>
      <Wall />
      <CubeCamera resolution={128} fog={{ color: '#00ff00', near: 0, far: 1 }}>
        {(texture) => ball(texture)}
      </CubeCamera>
    </>
  ),
  // The scene fog (from 4 units, past the ball, so the main view shows the ball clear) is off in the faces.
  'cube-camera-fog-off': () => (
    <>
      <Fog color="#00ff00" near={4} far={5} />
      <Wall />
      <CubeCamera resolution={128} fog={false}>
        {(texture) => ball(texture)}
      </CubeCamera>
    </>
  ),
  // The same scene fog without the prop reaches the faces: the reflected wall turns green.
  'cube-camera-scene-fog': () => (
    <>
      <Fog color="#00ff00" near={4} far={5} />
      <Wall />
      <CubeCamera resolution={128}>{(texture) => ball(texture)}</CubeCamera>
    </>
  ),
  // The faces draw an HDR sky as their background; the main view keeps its dark one.
  'cube-camera-env-map': () => (
    <CubeCamera resolution={128} frames={1} envMap="/packages/environment/tests/fixtures/sun_sky.hdr">
      {(texture) => ball(texture)}
    </CubeCamera>
  ),
  // A 2 x 2 floor-style plane facing the camera: at mirror 1 its centre shows the wall behind the camera.
  'mesh-reflector': () => (
    <>
      <Wall />
      <Mesh>
        <PlaneGeometry args={[2, 2]} />
        <MeshReflectorMaterial color="#202020" mirror={1} resolution={512} />
      </Mesh>
    </>
  ),
  // mixStrength 0: only the plane's own lit grey.
  'mesh-reflector-off': () => (
    <>
      <Wall />
      <Mesh>
        <PlaneGeometry args={[2, 2]} />
        <MeshReflectorMaterial color="#202020" mixStrength={0} />
      </Mesh>
    </>
  ),
  // A red softbox to the left inside <Environment>: the captured environment lights the ball's left side red.
  lightformer: () => (
    <>
      <Environment background={false}>
        <Lightformer color="#ff0000" intensity={8} scale={10} position={[-5, 0, 0]} target={[0, 0, 0]} />
      </Environment>
      <Mesh>
        <SphereGeometry args={[1, 48, 24]} />
      </Mesh>
    </>
  ),
  // A green card between the camera and the origin, inside <Environment>: hidden in the main view.
  'lightformer-hidden': () => (
    <Environment background={false}>
      <Lightformer color="#00ff00" position={[0, 0, 2]} target={[0, 0, 4]} />
    </Environment>
  ),
  // The same card outside an Environment is drawn as an unlit green shape.
  'lightformer-outside': () => <Lightformer color="#00ff00" position={[0, 0, 2]} target={[0, 0, 4]} />,
  // Fog inside a named <Scene> fogs that scene's meshes: the only view draws it, so a white plane turns green.
  'scene-fog': () => (
    <>
      <RenderView scene="fogged" />
      <Scene name="fogged" background="#000000">
        <Fog color="#00ff00" near={0} far={1} />
        <Mesh position={[0, 0, -2]}>
          <PlaneGeometry args={[4, 4]} />
          <PbrMaterial color="#ffffff" />
        </Mesh>
      </Scene>
    </>
  ),
  'no-env-map': () => (
    <>
      <Wall />
      {ball()}
    </>
  ),
};
const root = createRoot(document.querySelector('#app')!);
Object.assign(window, {
  reflections: {
    state,
    mount(mode: string) {
      state.frames = 0;
      state.errors = [];
      root.render(
        <StrictMode>
          <section>
            <Canvas
              key={mode}
              backend="webgpu"
              camera={{ position: [0, 0, 4], fov: 50 }}
              onError={(error) =>
                state.errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
              }
            >
              <Count />
              {modes[mode]()}
            </Canvas>
          </section>
        </StrictMode>,
      );
    },
    unmount() {
      root.unmount();
    },
  },
});

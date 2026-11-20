// Real-GPU proofs of the drei-style staging components, one mode per component, on WebGPU and the WebGL2 layer.
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, Mesh, PbrMaterial, useFrame } from '@margoengine/react';
import { PlaneGeometry, SphereGeometry } from '@margoengine/react/geometry';
import { Caustics } from '@margoengine/react/caustics';
import { AccumulativeShadows, RandomizedLight } from '@margoengine/react/accumulative-shadows';
import { MarchingCube, MarchingCubes } from '@margoengine/react/marching-cubes';
import { Mask, useMask } from '@margoengine/react/materials';
import { useDepthBuffer } from '@margoengine/react/portals';
import { Sampler } from '@margoengine/react/sampler';
import { BoxGeometry as Box } from '@margoengine/react';
import { Geometry, engineRuntime } from '@margoengine/core/extension';
import { planeGeometry } from '@margoengine/geometry';
import { TextureMaterial } from '@margoengine/react/textures';

const state = {
  caustics: null as null | { readMap(): Promise<{ resolution: number; irradiance: Float32Array }> },
  accumulative: null as null | { samples: number; options: object; stats?: object },
  frames: 0,
  errors: [] as string[],
  depth: null as GPUTexture | null,
  gpu: null as GPUDevice | null,
};
function Depth() {
  state.depth = useDepthBuffer({ size: 64, frames: 3 });
  return (
    <Mesh>
      <PlaneGeometry args={[1, 1]} />
      <PbrMaterial color="#ffffff" />
    </Mesh>
  );
}
// Depth texels at the centre and a corner of a 1-sample depth texture, through a draw into an r32float target.
async function readDepth(): Promise<number[]> {
  const device = state.gpu!,
    depth = state.depth!,
    module = device.createShaderModule({
      code: `@group(0) @binding(0) var d: texture_depth_2d;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let at = select(vec2i(2, 2), vec2i(32, 32), p.x < 1.0);
  return vec4f(textureLoad(d, at, 0), 0.0, 0.0, 1.0);
}`,
    }),
    pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'r32float' }] },
    }),
    out = device.createTexture({ size: [2, 1], format: 'r32float', usage: 0x10 | 0x01 }),
    buffer = device.createBuffer({ size: 256, usage: 0x01 | 0x08 }),
    encoder = device.createCommandEncoder(),
    pass = encoder.beginRenderPass({
      colorAttachments: [{ view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    });
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: depth.createView({ aspect: 'depth-only' }) }],
    }),
  );
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer({ texture: out }, { buffer, bytesPerRow: 256 }, [2, 1]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(1);
  const values = [...new Float32Array(buffer.getMappedRange(), 0, 2)];
  buffer.unmap();
  out.destroy();
  buffer.destroy();
  return values;
}
function Count() {
  useFrame(() => state.frames++);
  return null;
}
function Masked({ inverse }: { inverse: boolean }) {
  const stencil = useMask(1, inverse);
  return (
    <Mesh position={[0, 0, -0.5]}>
      <PlaneGeometry args={[4, 4]} />
      <TextureMaterial color="#000000" emissive={[1, 0, 0]} {...stencil} />
    </Mesh>
  );
}
const square = (() => {
  const g = planeGeometry(1, 1);
  return new Geometry(g.positions, g.normals, g.indices);
})();
function Scatter() {
  return (
    <>
      <Sampler mesh={square} count={1000} transform={(p) => ({ position: p.position, scale: [0.08, 0.08, 0.08] })}>
        <Box />
        <PbrMaterial color="#ff0000" roughness={1} />
      </Sampler>
    </>
  );
}
const modes: Record<string, () => React.ReactNode> = {
  sampler: () => <Scatter />,
  // A glass ball over the floor: the photon map focuses under it.
  caustics: () => (
    <Caustics size={4} height={3} resolution={64} photonSide={128} frames={4} onReady={(c) => (state.caustics = c)}>
      <Mesh position={[0, 1, 0]}>
        <SphereGeometry args={[0.6, 32, 16]} />
      </Mesh>
    </Caustics>
  ),
  // A plane facing the camera (the group's up turned to +z) over the dark clear colour, lit from +x at
  // 45 degrees, over two boxes 1 above it (a core PbrMaterial one at y 0.8, a materials TextureMaterial one at y -0.8):
  // their white shadows (color) land 1 to the left of each, the mirrored spots stay clear.
  'accumulative-shadows': () => (
    <>
      <AccumulativeShadows
        rotation={[Math.PI / 2, 0, 0]}
        scale={6}
        color="#ffffff"
        frames={4}
        resolution={256}
        onReady={(c) => (state.accumulative = c)}
      >
        <RandomizedLight position={[3, 3, 0]} radius={0.3} ambient={0} amount={8} />
      </AccumulativeShadows>
      <Mesh castShadow position={[0, 0.8, 1]}>
        <Box args={[0.5, 0.5, 0.5]} />
        <PbrMaterial color="#ff0000" />
      </Mesh>
      <Mesh castShadow position={[0, -0.8, 1]}>
        <Box args={[0.5, 0.5, 0.5]} />
        <TextureMaterial color="#000000" emissive={[1, 0, 0]} />
      </Mesh>
    </>
  ),
  // One red ball, shown through its vertex colours by a TextureMaterial, scaled to fill the middle of the view.
  'marching-cubes': () => (
    <MarchingCubes scale={[4, 4, 4]} resolution={32} enableColors>
      <MarchingCube color="#ff0000" strength={1} />
      <TextureMaterial color="#ffffff" roughness={1} />
    </MarchingCubes>
  ),
  mask: () => (
    <>
      <Mask id={1}>
        <PlaneGeometry args={[1, 1]} />
      </Mask>
      <Masked inverse={false} />
    </>
  ),
  depth: () => <Depth />,
  'mask-inverse': () => (
    <>
      <Mask id={1}>
        <PlaneGeometry args={[1, 1]} />
      </Mask>
      <Masked inverse />
    </>
  ),
};
const root = createRoot(document.querySelector('#app')!);
Object.assign(window, {
  stageParts: {
    state,
    readDepth,
    async readCaustics() {
      const { resolution, irradiance } = await state.caustics!.readMap();
      let max = 0,
        sum = 0,
        at = 0;
      irradiance.forEach((v, i) => {
        sum += v;
        if (v > max) [max, at] = [v, i];
      });
      return {
        resolution,
        max,
        mean: sum / irradiance.length,
        x: at % resolution,
        y: Math.floor(at / resolution),
        finite: irradiance.every(Number.isFinite),
      };
    },
    mount(mode: string) {
      state.caustics = null;
      state.accumulative = null;
      // One sample, so the depth texture is a plain texture_depth_2d the probe can load.
      Object.assign(globalThis, { margoLow: mode === 'depth' ? true : undefined });
      state.frames = 0;
      state.errors = [];
      root.render(
        <StrictMode>
          <section>
            <Canvas
              key={mode}
              backend="webgpu"
              camera={{ position: [0, 0, 4], fov: 50 }}
              onCreated={(stage) => {
                state.gpu = engineRuntime(stage.engine).gpu ?? null;
                Object.assign(state, { engine: engineRuntime(stage.engine) });
              }}
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

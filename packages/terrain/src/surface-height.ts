import { terrainOutside } from './shader.js';

declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number };

interface GridDraw {
  readonly vertex: GPUBuffer;
  readonly center: GPUBuffer;
  readonly ring: GPUBuffer;
  readonly centerCount: number;
  readonly ringCount: number;
}

interface SurfaceHeight {
  readonly texture: GPUTexture;
  draw(
    encoder: GPUCommandEncoder,
    version: number,
    rings: readonly { group: GPUBindGroup }[],
    geometry: GridDraw,
  ): void;
}

const uvAt = `(position.xz-frame.map.xy)/frame.map.zw`;
const projection = `let n=vec2f(textureDimensions(heightMap));let uv=(${uvAt}*(n-1.0)+0.5)/n;o.clip=vec4f(uv.x*2.0-1.0,1.0-2.0*uv.y,0.0,1.0);`;

/** A world-height image of the clipmap triangles. UVs match the source texture including the half-texel border. */
export function surfaceHeight(
  device: GPUDevice,
  source: GPUTexture,
  layout: GPUBindGroupLayout,
  vertexCode: string,
  clip: (code: string) => string,
  floating: boolean,
): SurfaceHeight | undefined {
  const tier = (device as GPUDevice & { adapter?: { capabilities?: { tier?: string } } }).adapter?.capabilities?.tier;
  if (tier === 'ldr') return undefined;
  const format = tier === 'half-float' ? 'rgba16float' : 'r32float';
  const width = Math.min(2049, source.width),
    height = Math.min(2049, source.height);
  const size = [width, height];
  const yShift = floating ? '+frame.anchor.z' : '';
  const output = format === 'rgba16float' ? 'vec4f' : 'f32';
  const color = (value: string) => (output === 'vec4f' ? `vec4f(${value},0.0,0.0,1.0)` : value);
  // Seed uncovered texels from the height field. The drawn rings replace those samples on the visible surface.
  const module = device.createShaderModule({
    code: clip(
      vertexCode.replace('o.clip=frame.camera*vec4f(position,1);', projection) +
        /* wgsl */ `
@vertex fn seedVertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);
}
@fragment fn seed(@builtin(position) p:vec4f)->@location(0) ${output} {
  let n=vec2f(textureDimensions(heightMap));let q=(p.xy/vec2f(${width},${height})*n-0.5)/max(n-1.0,vec2f(1.0));
  return ${color('height(frame.map.xy+q*frame.map.zw)' + yShift)};
}
@fragment fn sampleSurface(i:Output)->@location(0) ${output} {
  ${terrainOutside}
  return ${color('i.position.y' + yShift)};
}`,
    ),
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const seed = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'seedVertex' },
    fragment: { module, entryPoint: 'seed', targets: [{ format }] },
  });
  const draw = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
      module,
      entryPoint: 'vertex',
      buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
    },
    fragment: { module, entryPoint: 'sampleSurface', targets: [{ format }] },
  });
  const texture = device.createTexture({
    label: 'Terrain drawn surface height',
    size,
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  const view = texture.createView();
  let drawn = -1;
  return {
    texture,
    draw(encoder, version, rings, geometry) {
      if (drawn === version) return;
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(seed);
      pass.setBindGroup(0, rings[0].group);
      pass.draw(3);
      pass.setPipeline(draw);
      pass.setVertexBuffer(0, geometry.vertex);
      // Finest level wins at a shared boundary. Both use the same vertices and height texture as the colour pass.
      for (let i = rings.length - 1; i >= 0; i--) {
        pass.setBindGroup(0, rings[i].group);
        pass.setIndexBuffer(i ? geometry.ring : geometry.center, 'uint32');
        pass.drawIndexed(i ? geometry.ringCount : geometry.centerCount);
      }
      pass.end();
      drawn = version;
    },
  };
}

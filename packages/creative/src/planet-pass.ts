import type { PassContext, Vec3 } from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import { sceneSamples } from '../../shared/quality.js';
import surfaceSource from './shaders/planet_surface.wgsl?raw';
import atmosphereSource from './shaders/planet_atmosphere.wgsl?raw';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; VERTEX: number; INDEX: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };

export interface PlanetImages {
  day: ImageBitmap;
  night?: ImageBitmap;
  specular?: ImageBitmap;
  normal?: ImageBitmap;
  clouds?: ImageBitmap;
}
export interface PlanetPassConfig {
  radius: number;
  atmosphereColor: Vec3;
  atmosphereIntensity: number;
  nightIntensity: number;
}
type Context = Extract<PassContext, { backend: 'webgpu' }>;
type Variant = {
  surface: GPURenderPipeline;
  shell: GPURenderPipeline;
  surfaceGroup: GPUBindGroup;
  shellGroup: GPUBindGroup;
};

export class PlanetPass {
  private readonly uniformData = new Float32Array(48);
  private readonly buffers: GPUBuffer[] = [];
  private readonly textures: GPUTexture[] = [];
  private readonly variants = new Map<string, Variant>();
  private readonly uniform: GPUBuffer;
  private readonly vertex: GPUBuffer;
  private readonly index: GPUBuffer;
  private readonly indexCount: number;
  private readonly color: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' };
  private readonly surfaceDepth: GPURenderPassDepthStencilAttachment;
  private readonly shellDepth: GPURenderPassDepthStencilAttachment;
  private readonly surfaceDescriptor: GPURenderPassDescriptor;
  private readonly shellDescriptor: GPURenderPassDescriptor;
  private disposed = false;
  private readonly samples = sceneSamples();
  private views: GPUTextureView[] = [];
  private sampler?: GPUSampler;
  private surfaceModule?: GPUShaderModule;
  private shellModule?: GPUShaderModule;

  constructor(
    private readonly device: GPUDevice,
    images: PlanetImages,
    private readonly format: GPUTextureFormat,
    private readonly depthFormat: GPUTextureFormat,
    config: PlanetPassConfig,
  ) {
    finiteVector(config.atmosphereColor, 3, 'Planet atmosphere color');
    if (
      !Number.isFinite(Math.fround(config.radius)) ||
      Math.fround(config.radius) <= 0 ||
      !Number.isFinite(Math.fround(config.radius * 1.01))
    )
      throw new RangeError('Planet radius must be positive and finite');
    if (
      !Number.isFinite(Math.fround(config.atmosphereIntensity)) ||
      config.atmosphereIntensity < 0 ||
      config.atmosphereColor.some((value) => value < 0)
    )
      throw new RangeError('Planet atmosphere must be non-negative and finite');
    if (!images.day) throw new TypeError('Planet needs a day image');
    for (const image of [images.day, images.night, images.specular, images.normal, images.clouds]) {
      if (
        image &&
        (!Number.isSafeInteger(image.width) ||
          !Number.isSafeInteger(image.height) ||
          image.width < 1 ||
          image.height < 1 ||
          Math.max(image.width, image.height) > device.limits.maxTextureDimension2D)
      )
        throw new RangeError('Planet image dimensions exceed GPU limits');
    }
    this.uniformData[35] = config.radius;
    this.uniformData.set(config.atmosphereColor, 40);
    this.uniformData[43] = config.atmosphereIntensity;
    this.uniformData[44] = +!!images.normal;
    this.uniformData[45] = +!!images.clouds;
    this.uniformData[46] = config.nightIntensity;
    this.surfaceDepth = { view: undefined!, depthLoadOp: 'load', depthStoreOp: 'store' };
    this.shellDepth = { view: undefined!, depthReadOnly: true };
    if (depthFormat.includes('stencil')) {
      this.surfaceDepth.stencilReadOnly = true;
      this.shellDepth.stencilReadOnly = true;
    }
    this.surfaceDescriptor = { colorAttachments: [this.color], depthStencilAttachment: this.surfaceDepth };
    this.shellDescriptor = { colorAttachments: [this.color], depthStencilAttachment: this.shellDepth };
    try {
      const buffer = (data: Float32Array | Uint32Array, usage: number): GPUBuffer => {
        if (data.byteLength > device.limits.maxBufferSize) throw new RangeError('Planet buffers exceed GPU limits');
        const resource = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
        this.buffers.push(resource);
        device.queue.writeBuffer(resource, 0, data as Float32Array<ArrayBuffer>);
        return resource;
      };
      this.uniform = buffer(this.uniformData, GPUBufferUsage.UNIFORM);
      const segments = 128,
        rings = 64;
      const positions = new Float32Array((segments + 1) * (rings + 1) * 3);
      const indices = new Uint32Array(segments * (rings - 1) * 6);
      let offset = 0;
      for (let ring = 0; ring <= rings; ring++) {
        const latitude = (ring * Math.PI) / rings,
          extent = Math.sin(latitude),
          height = Math.cos(latitude);
        for (let segment = 0; segment <= segments; segment++) {
          const longitude = (segment * Math.PI * 2) / segments,
            vertex = (ring * (segments + 1) + segment) * 3;
          positions[vertex] = extent * Math.cos(longitude);
          positions[vertex + 1] = height;
          positions[vertex + 2] = extent * Math.sin(longitude);
          if (ring < rings && segment < segments) {
            const a = ring * (segments + 1) + segment,
              b = a + segments + 1;
            if (ring > 0) {
              indices[offset++] = a;
              indices[offset++] = a + 1;
              indices[offset++] = b;
            }
            if (ring < rings - 1) {
              indices[offset++] = a + 1;
              indices[offset++] = b + 1;
              indices[offset++] = b;
            }
          }
        }
      }
      this.vertex = buffer(positions, GPUBufferUsage.VERTEX);
      this.index = buffer(indices, GPUBufferUsage.INDEX);
      this.indexCount = indices.length;
      const texture = (image: ImageBitmap | undefined, srgb: boolean, fallback: readonly number[]): GPUTextureView => {
        // shortcut: one mip level can alias at a distance, add mip generation when minified views need it.
        const resource = device.createTexture({
          size: [image?.width ?? 1, image?.height ?? 1],
          format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.textures.push(resource);
        if (image)
          device.queue.copyExternalImageToTexture({ source: image }, { texture: resource }, [
            image.width,
            image.height,
          ]);
        else device.queue.writeTexture({ texture: resource }, new Uint8Array(fallback), { bytesPerRow: 4 }, [1, 1]);
        return resource.createView();
      };
      this.views = [
        texture(images.day, true, [255, 255, 255, 255]),
        texture(images.night, true, [0, 0, 0, 255]),
        texture(images.specular, false, [0, 255, 0, 255]),
        texture(images.normal, false, [128, 128, 255, 255]),
        texture(images.clouds, false, [0, 0, 0, 255]),
      ];
      this.sampler = device.createSampler({
        addressModeU: 'repeat',
        addressModeV: 'clamp-to-edge',
        minFilter: 'linear',
        magFilter: 'linear',
      });
      this.surfaceModule = device.createShaderModule({ code: surfaceSource });
      this.shellModule = device.createShaderModule({ code: atmosphereSource });
      this.variant(format, this.samples, depthFormat);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private variant(target: GPUTextureFormat, count: number, depthFormat: GPUTextureFormat): Variant {
    if ((target !== this.format && target !== 'rgba16float') || (count !== 1 && count !== this.samples))
      throw new Error('Unsupported planet target or device');
    const key = target + ':' + count + ':' + depthFormat,
      cached = this.variants.get(key);
    if (cached) return cached;
    const pipeline = (module: GPUShaderModule, shell: boolean) =>
      this.device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vs_main',
          buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
        },
        fragment: {
          module,
          entryPoint: 'fs_main',
          constants: { outputHdr: +(target === 'rgba16float') },
          targets: [
            {
              format: target,
              blend: shell
                ? {
                    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                  }
                : undefined,
            },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        multisample: { count },
        depthStencil: { format: depthFormat, depthWriteEnabled: !shell, depthCompare: 'greater-equal' },
      });
    const surface = pipeline(this.surfaceModule!, false),
      shell = pipeline(this.shellModule!, true);
    const surfaceGroup = this.device.createBindGroup({
      layout: surface.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: this.sampler! },
        ...this.views.slice(0, 4).map((resource, index) => ({ binding: index + 2, resource })),
      ],
    });
    const shellGroup = this.device.createBindGroup({
      layout: shell.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: this.sampler! },
        { binding: 2, resource: this.views[4] },
      ],
    });
    const variant = { surface, shell, surfaceGroup, shellGroup };
    this.variants.set(key, variant);
    return variant;
  }

  updateFrame(
    cameraMatrix: Float32Array,
    modelMatrix: Float32Array,
    cameraPosition: Vec3,
    sunDirection: ArrayLike<number>,
    cloudOffsetU: number,
  ): void {
    if (this.disposed) throw new Error('Planet pass is disposed');
    finiteVector(cameraMatrix, 16, 'Planet camera matrix');
    finiteVector(modelMatrix, 16, 'Planet model matrix');
    finiteVector(cameraPosition, 3, 'Planet camera position');
    finiteVector(sunDirection, 3, 'Planet sun direction');
    const length = Math.hypot(sunDirection[0], sunDirection[1], sunDirection[2]);
    if (!length || !Number.isFinite(cloudOffsetU))
      throw new RangeError('Planet sun must be nonzero and cloud offset finite');
    const data = this.uniformData;
    data.set(cameraMatrix, 0);
    data.set(modelMatrix, 16);
    data.set(cameraPosition, 32);
    data[36] = sunDirection[0] / length;
    data[37] = sunDirection[1] / length;
    data[38] = sunDirection[2] / length;
    data[39] = ((cloudOffsetU % 1) + 1) % 1;
    this.device.queue.writeBuffer(this.uniform, 0, data);
  }

  record(context: Context, shell: boolean): void {
    if (this.disposed) throw new Error('Planet pass is disposed');
    if (context.device !== this.device) throw new Error('Unsupported planet target or device');
    const depthFormat = context.descriptor.depthStencil?.format ?? this.depthFormat,
      variant = this.variant(context.format, context.descriptor.multisample?.count ?? 1, depthFormat);
    this.surfaceDepth.stencilReadOnly = this.shellDepth.stencilReadOnly = depthFormat.includes('stencil') || undefined;
    this.color.view = context.color;
    this.surfaceDepth.view = this.shellDepth.view = context.depth;
    const pass = context.encoder.beginRenderPass(shell ? this.shellDescriptor : this.surfaceDescriptor);
    pass.setPipeline(shell ? variant.shell : variant.surface);
    pass.setBindGroup(0, shell ? variant.shellGroup : variant.surfaceGroup);
    pass.setVertexBuffer(0, this.vertex);
    pass.setIndexBuffer(this.index, 'uint32');
    pass.drawIndexed(this.indexCount);
    pass.end();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const buffer of this.buffers) buffer.destroy();
    for (const texture of this.textures) texture.destroy();
    this.buffers.length = this.textures.length = this.views.length = 0;
    this.variants.clear();
    this.sampler = undefined;
    this.surfaceModule = this.shellModule = undefined;
  }
}

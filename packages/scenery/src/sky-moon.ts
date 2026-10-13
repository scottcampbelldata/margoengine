import type { Vec3 } from '@margoengine/core';
import { finiteVector } from '../../shared/math.js';
import skyMoonShaderSource from './shaders/sky_moon.wgsl?raw';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

export interface SkyMoonConfig {
  zenithColor?: Vec3;
  horizonColor?: Vec3;
  moonColor?: Vec3;
  moonDirection?: Vec3;
  /** Angular radius in radians, between 0 and PI / 2 (exclusive). Default: 0.038. */
  moonSize?: number;
  /** -1 = new, 0 = half, 1 = full; values are clamped. */
  moonPhase?: number;
  glowIntensity?: number;
  starIntensity?: number;
  /** Twinkle amplitude; zero holds stars steady. Default: 1. */
  starTwinkleIntensity?: number;
  /** Horizon haze thickness; zero removes the haze gradient. Default: 1. */
  hazeDensity?: number;
}

export class SkyMoonPass {
  private readonly pipeline: GPURenderPipeline;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly descriptor: GPURenderPipelineDescriptor;
  private readonly uniformBuffer: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  // 160 bytes; color padding retains twinkle, haze, and the precomputed moon sine.
  private readonly uniformData = new Float32Array(40);

  constructor(
    private readonly device: GPUDevice,
    targetFormat: GPUTextureFormat,
    depthFormat?: GPUTextureFormat,
  ) {
    this.setConfig({
      zenithColor: [0.015, 0.025, 0.065],
      horizonColor: [0.08, 0.09, 0.15],
      moonColor: [0.92, 0.95, 1],
      moonDirection: [0.4, 0.7, 0.5],
      moonSize: 0.038,
      moonPhase: 0.85,
      glowIntensity: 1.2,
      starIntensity: 0.8,
      starTwinkleIntensity: 1,
      hazeDensity: 1,
    });
    this.uniformBuffer = device.createBuffer({
      size: this.uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    try {
      const layout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform', minBindingSize: 160 },
          },
        ],
      });
      this.bindGroup = device.createBindGroup({
        layout,
        entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
      });
      const module = device.createShaderModule({ code: skyMoonShaderSource });
      const descriptor: GPURenderPipelineDescriptor = {
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vs_main' },
        fragment: {
          module,
          entryPoint: 'fs_main',
          targets: [{ format: targetFormat }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depthFormat
          ? {
              format: depthFormat,
              depthWriteEnabled: false,
              depthCompare: 'greater-equal',
            }
          : undefined,
      };
      this.pipeline = device.createRenderPipeline(descriptor);
      this.descriptor = descriptor;
    } catch (error) {
      this.uniformBuffer.destroy();
      throw error;
    }
  }

  setConfig(config: SkyMoonConfig): void {
    for (const color of [
      config.zenithColor,
      config.horizonColor,
      config.moonColor,
    ]) {
      if (color !== undefined) {
        finiteVector(color, 3, 'Sky color');
        if (color.some((value) => value < 0))
          throw new RangeError('Sky colors must be non-negative');
      }
    }
    let directionLength = 0;
    if (config.moonDirection !== undefined) {
      finiteVector(config.moonDirection, 3, 'Moon direction');
      directionLength = Math.hypot(
        config.moonDirection[0],
        config.moonDirection[1],
        config.moonDirection[2],
      );
      if (!directionLength)
        throw new RangeError('Moon direction must be nonzero');
    }
    for (const value of [
      config.moonSize,
      config.moonPhase,
      config.glowIntensity,
      config.starIntensity,
      config.starTwinkleIntensity,
      config.hazeDensity,
    ]) {
      if (
        value !== undefined &&
        (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)))
      )
        throw new RangeError('Sky parameters must be finite Float32 numbers');
    }
    if (
      config.moonSize !== undefined &&
      (Math.fround(config.moonSize) <= 0 ||
        Math.fround(config.moonSize) >= Math.PI / 2)
    )
      throw new RangeError('Moon size must be between 0 and PI / 2');

    const data = this.uniformData;
    if (config.zenithColor !== undefined) data.set(config.zenithColor, 24);
    if (config.horizonColor !== undefined) data.set(config.horizonColor, 28);
    if (config.moonColor !== undefined) data.set(config.moonColor, 32);
    if (config.moonDirection !== undefined) {
      data[20] = config.moonDirection[0] / directionLength;
      data[21] = config.moonDirection[1] / directionLength;
      data[22] = config.moonDirection[2] / directionLength;
    }
    if (config.moonSize !== undefined) {
      data[23] = Math.cos(config.moonSize);
      data[35] = Math.sin(config.moonSize);
    }
    if (config.moonPhase !== undefined)
      data[36] = Math.max(-1, Math.min(1, config.moonPhase));
    if (config.glowIntensity !== undefined)
      data[37] = Math.max(0, config.glowIntensity);
    if (config.starIntensity !== undefined)
      data[38] = Math.max(0, config.starIntensity);
    if (config.starTwinkleIntensity !== undefined)
      data[27] = Math.max(0, config.starTwinkleIntensity);
    if (config.hazeDensity !== undefined)
      data[31] = Math.max(0, config.hazeDensity);
  }

  /** Uploads camera/time using the retained staging array; valid frames allocate no temporary objects. */
  updateFrame(
    invViewProjMatrix16: Float32Array | readonly number[],
    cameraPos: Vec3,
    timeSeconds: number,
  ): void {
    finiteVector(invViewProjMatrix16, 16, 'Inverse view-projection');
    finiteVector(cameraPos, 3, 'Camera position');
    if (
      !Number.isFinite(timeSeconds) ||
      !Number.isFinite(Math.fround(timeSeconds))
    )
      throw new RangeError('Sky time must be a finite Float32 number');
    const data = this.uniformData;
    data.set(invViewProjMatrix16, 0);
    data[16] = cameraPos[0];
    data[17] = cameraPos[1];
    data[18] = cameraPos[2];
    data[19] = 1;
    data[39] = timeSeconds;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  /** Records a background triangle with the scene's sample count. */
  record(passEncoder: GPURenderPassEncoder, sampleCount = 1, depthFormat = this.descriptor.depthStencil?.format): void {
    const count = sampleCount === 4 ? 4 : 1;
    let pipeline = count === 1 && depthFormat === this.descriptor.depthStencil?.format ? this.pipeline : undefined;
    if (!pipeline) {
      const key = count + ':' + depthFormat;
      pipeline = this.pipelines.get(key);
      if (!pipeline) {
        pipeline = this.device.createRenderPipeline({...this.descriptor, multisample: {count},
          depthStencil: depthFormat === undefined ? undefined : {depthWriteEnabled: false, depthCompare: 'greater-equal', ...this.descriptor.depthStencil, format: depthFormat}});
        this.pipelines.set(key, pipeline);
      }
    }
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.draw(3, 1, 0, 0);
  }

  dispose(): void {
    this.uniformBuffer.destroy();
    this.pipelines.clear();
  }
}

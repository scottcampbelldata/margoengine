/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Material, MapSlot } from '@margoengine/materials';
import { fault, typeError } from '../../shared/errors.js';
import type { Json } from './server.js';

/** Page-side loader options. Materials are explicitly named app targets, never arbitrary object paths. */
export interface AssetInstallerOptions {
  materials?: Record<string, Material>;
}
/** Optional-package scene wiring for LivePageBridge.addAsset. Owns only the resources it installs. */
export class AssetInstaller implements Disposable {
  /** Creates the page-side asset owner. Default materials are empty. */
  static attach(engine: EngineKernel, options: AssetInstallerOptions = {}): AssetInstaller {
    return new AssetInstaller(engine, options);
  }
  private readonly lifetime = new AbortController();
  private readonly cleanup: (() => void)[] = [];
  private environmentId = 0;
  private environmentCleanup?: () => void;
  constructor(
    private readonly engine: EngineKernel,
    private readonly options: AssetInstallerOptions = {},
  ) {}
  /** Loads a model, environment or material map and installs it. The callback can be passed directly to addAsset. */
  readonly load = async (args: Record<string, unknown>, signal: AbortSignal): Promise<Json> => {
    const active = AbortSignal.any([this.lifetime.signal, signal]);
    active.throwIfAborted();
    if (typeof args.url !== 'string' || !/^https?:$/.test(new URL(args.url).protocol))
      throw typeError('Pass an HTTP asset URL served by the app', 'mcp');
    if (args.kind === 'model') {
      const { loadGLTF } = await import('@margoengine/gltf-pro');
      const model = await loadGLTF(this.engine, args.url, { signal: active });
      if (active.aborted) {
        this.engine.removePlugin(model.name);
        active.throwIfAborted();
      }
      this.cleanup.push(() => this.engine.removePlugin(model.name));
      return { kind: 'model', id: model.root.id, plugin: model.name };
    }
    if (args.kind === 'hdri') {
      const { Environment, EnvironmentLighting, loadEnvironmentImage } = await import('@margoengine/environment');
      const source = await loadEnvironmentImage(args.url, { signal: active });
      active.throwIfAborted();
      const name = `mcp-assets-environment:${this.environmentId++}`;
      const environment = await Environment.create(this.engine, source, { name });
      if (active.aborted) {
        environment.dispose();
        active.throwIfAborted();
      }
      this.engine.use(environment);
      let lighting: InstanceType<typeof EnvironmentLighting>;
      try {
        lighting = EnvironmentLighting.attach(this.engine, environment, { name: `${name}:lighting` });
      } catch (error) {
        this.engine.removePlugin(environment.name);
        throw error;
      }
      if (active.aborted) {
        this.engine.removePlugin(lighting.name);
        this.engine.removePlugin(environment.name);
        active.throwIfAborted();
      }
      const cleanup = () => {
        this.engine.removePlugin(lighting.name);
        this.engine.removePlugin(environment.name);
      };
      this.environmentCleanup?.();
      this.environmentCleanup = cleanup;
      return { kind: 'hdri', plugin: lighting.name };
    }
    if (args.kind !== 'texture') throw typeError('Asset kind must be model, hdri or texture', 'mcp');
    const targets = this.options.materials ?? {};
    const material = Object.hasOwn(targets, String(args.target)) ? targets[String(args.target)] : undefined;
    if (!material) throw fault('unsupported', 'Name an app material registered with AssetInstaller.materials', 'mcp');
    const { loadTexture, mapSlots } = await import('@margoengine/materials');
    const slot = String(args.slot ?? 'map') as MapSlot;
    if (!mapSlots.includes(slot)) throw typeError('Pass a supported Material map slot', 'mcp');
    const texture = await loadTexture(args.url, {
      signal: active,
      colorSpace: slot === 'map' || slot === 'emissiveMap' ? 'srgb' : 'linear',
    });
    if (active.aborted) {
      texture.dispose();
      active.throwIfAborted();
    }
    const previous = material[slot];
    material[slot] = texture;
    this.cleanup.push(() => {
      if (material[slot] === texture) material[slot] = previous;
      texture.dispose();
    });
    return { kind: 'texture', target: String(args.target), slot };
  };
  /** Cancels pending loads, restores owned texture bindings and removes installed models/environments. */
  dispose(): void {
    this.lifetime.abort();
    this.environmentCleanup?.();
    this.environmentCleanup = undefined;
    for (const cleanup of this.cleanup.reverse()) cleanup();
    this.cleanup.length = 0;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

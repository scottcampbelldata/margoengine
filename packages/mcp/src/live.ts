/// <reference lib="esnext.disposable" preserve="true" />
import type { Engine, EnginePlugin } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import type { PackageObjectsOptions, PropertyValue } from '@margoengine/inspector/packages';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { Json, ToolDefinition, ToolResult } from './server.js';

/** Explicit operations accepted by the dev page, never JavaScript evaluation. */
export type LiveOperation = 'scene' | 'properties' | 'set' | 'capture' | 'errors' | 'asset';
/** A transport to one running page; the host supplies cancellation and a hard deadline. */
export interface LiveConnection {
  request(operation: LiveOperation, args: Record<string, unknown>, signal?: AbortSignal): Promise<Json>;
}
/** Page plugin options. Import this entry only in development builds. */
export interface LivePageOptions extends PackageObjectsOptions {
  /** Required explicit opt-in. False or missing rejects before installing listeners. */
  enabled: boolean;
  /** Optional relay URL and its secret bearer token; without these use handle directly. */
  endpoint?: string;
  token?: string;
  /** Error event source, default window when available. */
  events?: EventTarget;
  /** Error ring size, default 100, maximum 1000. */
  errorLimit?: number;
  /** App-owned asset loader. Resolves only after the asset is added to the scene. */
  addAsset?: (asset: Record<string, unknown>, signal: AbortSignal) => Promise<Json>;
}

/** Dev-only engine plugin: inspect package properties, capture the canvas and read bounded error history. */
export class LivePageBridge implements EnginePlugin, Disposable {
  /** Registers an explicitly enabled development bridge with this engine. */
  static attach(engine: EngineKernel, options: LivePageOptions): LivePageBridge {
    const bridge = new LivePageBridge(options);
    try {
      engine.use(bridge);
      return bridge;
    } catch (error) {
      bridge.dispose();
      throw error;
    }
  }
  readonly name = 'mcp:live';
  private engine?: Engine;
  private lifetime = new AbortController();
  private errors: { message: string; kind: string }[] = [];
  private events?: EventTarget;
  private loop?: Promise<void>;
  private readonly limit: number;
  private readonly recordError = (event: Event) => {
    const e = event as ErrorEvent & PromiseRejectionEvent & { error?: Error };
    this.reportError(e.message ?? e.error?.message ?? String(e.reason), event.type);
  };
  constructor(private readonly options: LivePageOptions) {
    if (options.enabled !== true)
      throw fault('state', 'Live bridge requires enabled: true in a development build', 'mcp');
    this.limit = options.errorLimit ?? 100;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 1000)
      throw rangeError('errorLimit must be 1 to 1000', 'mcp');
    if (options.endpoint && (!options.token || new URL(options.endpoint).protocol !== 'http:'))
      throw typeError('The dev relay needs an http endpoint and token', 'mcp');
  }
  /** Attaches to the engine; no listener or request exists before setup. */
  setup(engine: Engine): void {
    if (this.engine || this.lifetime.signal.aborted)
      throw fault('state', 'Create a fresh live bridge before attaching', 'mcp');
    this.engine = engine;
    this.events = this.options.events ?? (typeof window === 'undefined' ? undefined : window);
    this.events?.addEventListener('error', this.recordError);
    this.events?.addEventListener('unhandledrejection', this.recordError);
    engine.gpu?.addEventListener('uncapturederror', this.recordError);
    if (this.options.endpoint) this.loop = this.connect();
  }
  /** Records app or renderer errors without replacing console methods. */
  reportError(message: string, kind = 'app'): void {
    this.errors.push({ message: String(message).slice(0, 4000), kind });
    if (this.errors.length > this.limit) this.errors.shift();
  }
  /** Resolves when relay polling ends. Network failures reject and are recorded; there is no hidden retry. */
  get closed(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }
  /** Executes one allow-listed operation using the inspector's validation and package setters. */
  async handle(operation: LiveOperation, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Json> {
    const active = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    active.throwIfAborted();
    const engine = this.engine;
    if (!engine) throw fault('state', 'Attach the live bridge to an engine first', 'mcp');
    if (operation === 'errors') {
      const result = this.errors.map((e) => ({ ...e }));
      if (args.clear === true) this.errors.length = 0;
      return result;
    }
    if (operation === 'asset') {
      if (!this.options.addAsset)
        throw fault('unsupported', 'Configure addAsset with the app asset loader first', 'mcp');
      return this.options.addAsset(args, active);
    }
    if (operation === 'capture') {
      engine.render();
      const canvas = engine.canvas as HTMLCanvasElement;
      if (typeof canvas.toBlob !== 'function') throw fault('unsupported', 'Canvas capture needs an HTML canvas', 'mcp');
      const blob = await new Promise<Blob>((resolve, reject) => {
        const abort = () => reject(active.reason);
        active.addEventListener('abort', abort, { once: true });
        canvas.toBlob((value) => {
          active.removeEventListener('abort', abort);
          value
            ? resolve(value)
            : reject(fault('failed', 'Canvas encoding failed; check origin-clean textures', 'mcp'));
        }, 'image/png');
      });
      active.throwIfAborted();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length > 12_000_000) throw rangeError('Canvas PNG exceeds 12 MB; reduce canvas resolution', 'mcp');
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return { data: btoa(binary), mimeType: 'image/png', width: canvas.width, height: canvas.height };
    }
    const { findPackageObjects, describeObject, editProperty } = await import('@margoengine/inspector/packages');
    const objects = findPackageObjects(engine, this.options);
    for (const mesh of engine.scene.meshes.values())
      objects.push({
        id: `mesh:${mesh.id}`,
        group: 'object',
        label: mesh.name || `Mesh ${mesh.id}`,
        target: mesh,
        properties: describeObject(mesh),
      });
    const describe = (object: (typeof objects)[number]): Json => ({
      id: object.id,
      label: object.label,
      group: object.group,
      readOnly: object.readOnly ?? null,
      properties: object.properties.map((p) => ({
        key: p.key,
        kind: p.kind,
        min: Number.isFinite(p.min) ? p.min! : null,
        max: Number.isFinite(p.max) ? p.max! : null,
        value: p.get() as Json,
      })),
    });
    if (operation === 'scene') return { objects: objects.map(describe), backend: engine.backend };
    const object = objects.find((o) => o.id === args.id);
    if (!object) throw typeError('Unknown object id; call live_scene first', 'mcp');
    if (operation === 'properties') return describe(object);
    if (operation === 'set') {
      if (typeof args.key !== 'string') throw typeError('Pass a property key from live_properties', 'mcp');
      active.throwIfAborted();
      editProperty(object, args.key, args.value as PropertyValue);
      return describe(object);
    }
    throw typeError('Unknown live operation; use a listed tool', 'mcp');
  }
  private async connect(): Promise<void> {
    const signal = this.lifetime.signal;
    const send = async (path: string, body?: unknown) => {
      const response = await fetch(`${this.options.endpoint}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw fault('failed', `Live relay returned ${response.status}; check relay settings`, 'mcp');
      return response.status === 204 ? null : response.json();
    };
    try {
      while (!signal.aborted) {
        const command = await send('/poll');
        if (!command) continue;
        let result: unknown;
        try {
          result = {
            value: await this.handle(command.operation, command.args, AbortSignal.timeout(command.timeoutMs)),
          };
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        await send('/result', { id: command.id, ...(result as object) });
      }
    } catch (error) {
      if (!signal.aborted) {
        this.reportError(String(error), 'relay');
        throw error;
      }
    }
  }
  /** Aborts polling and removes every owned error listener. */
  dispose(): void {
    const engine = this.engine;
    this.engine = undefined;
    this.lifetime.abort();
    this.events?.removeEventListener('error', this.recordError);
    this.events?.removeEventListener('unhandledrejection', this.recordError);
    engine?.gpu?.removeEventListener('uncapturederror', this.recordError);
    engine?.sceneOf?.(this)?.removePlugin(this.name);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** MCP tools for an explicitly connected running app; capture returns native MCP image content. */
export function createLiveTools(connection: LiveConnection): ToolDefinition[] {
  return (['scene', 'properties', 'set', 'capture', 'errors'] as const).map((operation) => ({
    name: `live_${operation}`,
    title: `Live ${operation}`,
    description: `Read or edit the connected development page: ${operation}. Get object ids and editable keys with live_scene.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        key: { type: 'string' },
        value: { type: ['number', 'boolean', 'array'], items: { type: 'number' } },
        clear: { type: 'boolean' },
      },
      required: operation === 'set' ? ['id', 'key', 'value'] : operation === 'properties' ? ['id'] : [],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: operation !== 'set' && operation !== 'errors', openWorldHint: true },
    async run(args, { signal }): Promise<ToolResult> {
      const value = await connection.request(operation, args, signal);
      if (operation === 'capture') {
        const frame = value as { data: string; mimeType: string };
        return { content: [{ type: 'image', data: frame.data, mimeType: frame.mimeType }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { value } };
    },
  }));
}

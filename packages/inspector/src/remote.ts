/// <reference lib="esnext.disposable" preserve="true" />
// Remote inspection: a scene running on a phone or headset (the target) answers a desktop browser (the viewer) over
// any string transport: a MessagePort, BroadcastChannel or WebSocket the app already has, or the HTTP relay of
// `@margoengine/inspector/remote-relay` (fetch POST to send, a streamed fetch response of one JSON message per line to
// receive). The target runs only the listed operations (no code evaluation), checks every edit with `editProperty`'s
// kind and range checks, and refuses requests without its token when it has one.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { margoError } from '../../shared/errors.js';
import { hexOf, linearOf } from './color.js';
import { EditHistory } from './history.js';
import {
  describeObject,
  editProperty,
  findPackageObjects,
  type PackageObject,
  type PackageObjectsOptions,
  type PropertyKind,
  type PropertyValue,
} from './packages.js';

/** A two-way string channel between target and viewer. */
export interface RemoteTransport {
  send(data: string): void;
  /** Calls `handler` with each message received; returns a function that stops it. */
  listen(handler: (data: string) => void): () => void;
  /** Ends the channel (optional). */
  close?(): void;
}
/** Operations a viewer may ask of a target. */
export type RemoteOperation = 'hello' | 'scene' | 'set' | 'undo' | 'redo' | 'capture' | 'stats';
/** One editable value as sent over the wire. */
export interface RemoteProperty {
  key: string;
  kind: PropertyKind;
  min: number | null;
  max: number | null;
  value: PropertyValue;
}
/** One object of the remote scene as sent over the wire. */
export interface RemoteObject {
  id: string;
  label: string;
  group: PackageObject['group'];
  readOnly: string | null;
  properties: RemoteProperty[];
}
/** What the target says about itself. */
export interface RemoteHello {
  backend: string;
  width: number;
  height: number;
  userAgent: string;
  objects: number;
}
/** The target's frame rate and frame time, averaged over its last frames. */
export interface RemoteStats {
  fps: number;
  frameMilliseconds: number;
  frames: number;
  meshes: number;
}
/** A PNG of the target's canvas. */
export interface RemoteCapture {
  data: string;
  mimeType: 'image/png';
  width: number;
  height: number;
}

const tag = 'margo-remote',
  version = 1,
  maxMessage = 16_000_000;
interface Request {
  [tag]: number;
  id: number;
  op: RemoteOperation;
  args?: Record<string, unknown>;
  token?: string;
}
interface Reply {
  [tag]: number;
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: string;
  event?: 'stats';
  data?: unknown;
}
/** A parsed message of this protocol, or undefined for anything else on a shared channel. */
function parse(data: unknown): (Request & Reply) | undefined {
  if (typeof data !== 'string' || data.length > maxMessage || !data.includes(tag)) return undefined;
  try {
    const m = JSON.parse(data);
    return m && typeof m === 'object' && m[tag] === version ? m : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A transport over a channel with `postMessage` (MessagePort, BroadcastChannel, Worker) or `send` (WebSocket,
 * RTCDataChannel) and `message` events carrying strings.
 */
export function channelTransport(channel: {
  postMessage?(data: string): void;
  send?(data: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  start?(): void;
  close?(): void;
}): RemoteTransport {
  const post = channel?.send ?? channel?.postMessage;
  if (typeof post !== 'function' || typeof channel.addEventListener !== 'function')
    throw new TypeError('channelTransport needs a MessagePort, BroadcastChannel or WebSocket; pass one');
  return {
    send: (data) => post.call(channel, data),
    listen(handler) {
      const listener = (event: { data: unknown }) => typeof event.data === 'string' && handler(event.data);
      channel.addEventListener('message', listener);
      channel.start?.();
      return () => channel.removeEventListener('message', listener);
    },
    close: () => channel.close?.(),
  };
}

/** Options for `relayTransport`. */
export interface RelayTransportOptions {
  /** The relay's URL, as `createRemoteRelay` reports it (`http://192.168.1.20:8787`). */
  url: string;
  /** The relay's token. Sent in a header, never in the URL. */
  token: string;
  /** Which side this page is: the scene (`target`) or the desktop panel (`viewer`). */
  role: 'target' | 'viewer';
  /** Called once when the stream or a send fails; the transport then stops. */
  onError?(error: Error): void;
}

/**
 * A transport through `@margoengine/inspector/remote-relay`: each message is POSTed, and the other side's messages
 * arrive on one streamed response, one per line. Works in any browser with streamed fetch responses.
 */
export function relayTransport(options: RelayTransportOptions): RemoteTransport {
  const { url, token, role, onError } = options ?? ({} as RelayTransportOptions);
  if (typeof url !== 'string' || !/^https?:\/\//.test(url))
    throw new TypeError('relayTransport needs the relay url (http or https); pass what createRemoteRelay reports');
  if (typeof token !== 'string' || !token) throw new TypeError('relayTransport needs the relay token; pass it');
  if (role !== 'target' && role !== 'viewer') throw new TypeError("relayTransport role must be 'target' or 'viewer'");
  const base = url.replace(/\/+$/, ''),
    headers = { Authorization: `Bearer ${token}`, 'X-Margo-Role': role },
    lifetime = new AbortController();
  let failed = false,
    queue = Promise.resolve();
  const fail = (error: unknown) => {
    if (failed || lifetime.signal.aborted) return;
    failed = true;
    lifetime.abort();
    onError?.(error instanceof Error ? error : new Error(String(error)));
  };
  return {
    send(data) {
      // In order: each POST starts after the last one finished.
      queue = queue.then(async () => {
        if (failed || lifetime.signal.aborted) return;
        try {
          const response = await fetch(`${base}/send`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: data,
            signal: lifetime.signal,
          });
          if (!response.ok) throw new Error(`Relay refused a message (${response.status}); check the url and token`);
        } catch (error) {
          fail(error);
        }
      });
    },
    listen(handler) {
      const stop = new AbortController(),
        signal = AbortSignal.any([stop.signal, lifetime.signal]);
      void (async () => {
        try {
          const response = await fetch(`${base}/events`, { headers, signal });
          if (!response.ok || !response.body)
            throw new Error(`Relay refused the stream (${response.status}); check the url and token`);
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let rest = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const lines = (rest + value).split('\n');
            rest = lines.pop()!;
            for (const line of lines) if (line) handler(line);
          }
          if (!signal.aborted) throw new Error('Relay closed the stream; restart the relay and reconnect');
        } catch (error) {
          if (!signal.aborted) fail(error);
        }
      })();
      return () => stop.abort();
    },
    close: () => lifetime.abort(),
  };
}

/** `RemoteTarget` options. */
export interface RemoteTargetOptions extends PackageObjectsOptions {
  transport: RemoteTransport;
  /** When set, every request must carry it (`RemoteInspector`'s `token`). */
  token?: string;
  /** Milliseconds between the stats the target sends unasked, 100 to 60,000, or 0 for none. Default 1,000. */
  statsIntervalMs?: number;
}

/** The objects a target lists: package objects (`findPackageObjects`) and the scene's meshes. */
function objectsOf(engine: Engine, options: PackageObjectsOptions): PackageObject[] {
  const out = findPackageObjects(engine, options);
  for (const mesh of engine.scene.meshes.values())
    out.push({
      id: `mesh:${mesh.id}`,
      group: 'object',
      label: mesh.name || `Mesh ${mesh.id}`,
      target: mesh,
      properties: describeObject(mesh),
    });
  return out;
}
const wire = (o: PackageObject): RemoteObject => ({
  id: o.id,
  label: o.label,
  group: o.group,
  readOnly: o.readOnly ?? null,
  properties: o.properties.map((p) => {
    const v = p.get();
    return {
      key: p.key,
      kind: p.kind,
      min: Number.isFinite(p.min) ? p.min! : null,
      max: Number.isFinite(p.max) ? p.max! : null,
      value: typeof v === 'object' ? Array.from(v) : v,
    };
  }),
});

/**
 * The scene side: an engine plugin that answers a `RemoteInspector` over `transport`. Attach it in development
 * builds of the page running on the phone or headset: `RemoteTarget.attach(engine, { transport, token })`.
 */
export class RemoteTarget implements EnginePlugin, Disposable {
  readonly name = 'inspector:remote';
  readonly history = new EditHistory();
  private engine?: Engine;
  private stop?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private readonly times: number[] = [];
  private frames = 0;
  private disposed = false;

  static attach(engine: EngineKernel, options: RemoteTargetOptions): RemoteTarget {
    const target = new RemoteTarget(options);
    engineRuntime(engine).use(target);
    return target;
  }
  constructor(private readonly options: RemoteTargetOptions) {
    if (!options?.transport || typeof options.transport.send !== 'function')
      throw new TypeError('RemoteTarget needs a transport; pass channelTransport(...) or relayTransport(...)');
    const every = options.statsIntervalMs ?? 1000;
    if (!Number.isFinite(every) || (every !== 0 && (every < 100 || every > 60000)))
      throw new RangeError('RemoteTarget statsIntervalMs must be 0 or 100 to 60000; pass milliseconds in range');
    if (options.token !== undefined && (typeof options.token !== 'string' || options.token.length < 8))
      throw new TypeError('RemoteTarget token must be a string of 8 or more characters; pass a longer secret');
  }
  setup(engine: Engine): void {
    if (this.disposed || this.engine)
      throw margoError('attached', 'RemoteTarget is disposed or already attached; create a new RemoteTarget');
    this.engine = engine;
    this.stop = this.options.transport.listen((data) => void this.receive(data));
    const every = this.options.statsIntervalMs ?? 1000;
    if (every) this.timer = setInterval(() => this.post({ [tag]: version, event: 'stats', data: this.stats() }), every);
  }
  onPreUpdate(delta: number): void {
    this.frames++;
    if (delta > 0) {
      this.times.push(delta);
      if (this.times.length > 60) this.times.shift();
    }
  }
  /** The frame rate and frame time over the last 60 frames. */
  stats(): RemoteStats {
    const mean = this.times.length ? this.times.reduce((a, b) => a + b, 0) / this.times.length : 0;
    return {
      fps: mean ? 1 / mean : 0,
      frameMilliseconds: mean * 1000,
      frames: this.frames,
      meshes: this.engine?.scene.meshes.size ?? 0,
    };
  }
  /** Runs one operation as a viewer's request would (no token check): for tests and local use. */
  async handle(op: RemoteOperation, args: Record<string, unknown> = {}): Promise<unknown> {
    const engine = this.engine;
    if (!engine || this.disposed)
      throw margoError('state', 'RemoteTarget is not attached; attach it to an engine first');
    if (op === 'stats') return this.stats();
    if (op === 'undo' || op === 'redo') return this.history[op]();
    if (op === 'capture') return capture(engine);
    const objects = objectsOf(engine, this.options);
    if (op === 'hello') {
      const canvas = engine.canvas as { width?: number; height?: number };
      return {
        backend: engine.backend,
        width: canvas.width ?? 0,
        height: canvas.height ?? 0,
        userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
        objects: objects.length,
      } satisfies RemoteHello;
    }
    if (op === 'scene') return objects.map(wire);
    if (op === 'set') {
      const object = objects.find((o) => o.id === args.id);
      if (!object) throw new TypeError(`No object ${String(args.id)}; pick an id from the scene list`);
      if (typeof args.key !== 'string') throw new TypeError('set needs a property key; pass one from the scene list');
      editProperty(object, args.key, args.value as PropertyValue, this.history);
      return wire(object);
    }
    throw new TypeError(`Unknown remote operation ${String(op)}; use hello, scene, set, undo, redo, capture or stats`);
  }
  private async receive(data: string): Promise<void> {
    const m = parse(data);
    if (!m || typeof m.op !== 'string' || typeof m.id !== 'number') return;
    let reply: Reply;
    try {
      if (this.options.token !== undefined && m.token !== this.options.token)
        throw new Error('Wrong or missing token; pass the token the target page was given');
      reply = { [tag]: version, id: m.id, ok: true, result: await this.handle(m.op, m.args ?? {}) };
    } catch (error) {
      reply = { [tag]: version, id: m.id, ok: false, error: (error as Error)?.message ?? String(error) };
    }
    this.post(reply);
  }
  private post(message: Reply): void {
    if (!this.disposed) this.options.transport.send(JSON.stringify(message));
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.stop?.();
    this.engine = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

async function capture(engine: Engine): Promise<RemoteCapture> {
  engine.render();
  const canvas = engine.canvas as HTMLCanvasElement;
  if (typeof canvas.toBlob !== 'function')
    throw margoError('unsupported', 'Capture needs an HTML canvas; capture on a page, not a worker canvas');
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw margoError('failed', 'Canvas encoding failed; use only origin-clean textures');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length > 12_000_000) throw new RangeError('Canvas PNG exceeds 12 MB; lower the canvas resolution');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { data: btoa(binary), mimeType: 'image/png', width: canvas.width, height: canvas.height };
}

/** `RemoteInspector` options. */
export interface RemoteInspectorOptions {
  transport: RemoteTransport;
  /** The target's token, when it has one. */
  token?: string;
  /** Element for the panel; null for no panel. Default `document.body`. */
  parent?: HTMLElement | null;
  /** Most milliseconds to wait for a reply, 100 to 120,000. Default 10,000. */
  timeoutMs?: number;
}

const css = `
:host{position:fixed;left:12px;top:12px;width:340px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;z-index:10001;display:block;color:#202226;background:#fafbfc;border:1px solid #b9bec7;border-radius:4px;font:12px/1.4 system-ui;letter-spacing:0}
*{box-sizing:border-box}h2{font-size:14px;margin:0;padding:10px 12px;border-bottom:1px solid #d5d9df}.row{display:flex;gap:8px;align-items:center;padding:6px 12px}.status{color:#5d636b}.status[data-state=error]{color:#b42318}
details{border-bottom:1px solid #d5d9df;padding:6px 12px}summary{cursor:pointer;font-weight:600}label{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px}input{font:inherit;min-width:0}input[type=number]{width:72px}.axes{display:flex;gap:4px}.axes input{width:56px}
input[type=color]{width:48px;height:24px;padding:0}input:disabled{opacity:.5}img{display:block;max-width:calc(100% - 24px);margin:6px 12px}button{font:inherit}
`;

/**
 * The desktop side: asks a `RemoteTarget` for its scene, edits it, takes screenshots and shows its frame rate, in a
 * panel (`parent: null` for none). `await viewer.connect()` says hello and lists the scene.
 */
export class RemoteInspector implements Disposable {
  readonly element?: HTMLElement;
  /** The objects of the last scene list. */
  objects: RemoteObject[] = [];
  /** The target's latest stats (sent every second by default). */
  stats?: RemoteStats;
  /** The target's hello, once connected. */
  target?: RemoteHello;
  private next = 1;
  private readonly waiting = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly stop: () => void;
  private readonly timeout: number;
  private readonly body?: HTMLElement;
  private readonly status?: HTMLElement;
  private readonly image?: HTMLImageElement;
  private disposed = false;

  constructor(private readonly options: RemoteInspectorOptions) {
    if (!options?.transport || typeof options.transport.listen !== 'function')
      throw new TypeError('RemoteInspector needs a transport; pass channelTransport(...) or relayTransport(...)');
    this.timeout = options.timeoutMs ?? 10000;
    if (!Number.isFinite(this.timeout) || this.timeout < 100 || this.timeout > 120000)
      throw new RangeError('RemoteInspector timeoutMs must be 100 to 120000; pass milliseconds in range');
    this.stop = options.transport.listen((data) => this.receive(data));
    const parent = options.parent === undefined ? document.body : options.parent;
    if (!parent) return;
    const doc = parent.ownerDocument;
    this.element = doc.createElement('div');
    this.element.dataset.margoRemoteInspector = '';
    const root = this.element.attachShadow({ mode: 'open' }),
      style = doc.createElement('style'),
      title = doc.createElement('h2'),
      bar = doc.createElement('div'),
      refresh = doc.createElement('button'),
      shot = doc.createElement('button');
    style.textContent = css;
    title.textContent = 'Remote scene';
    bar.className = 'row';
    refresh.textContent = 'Refresh';
    shot.textContent = 'Screenshot';
    this.status = doc.createElement('span');
    this.status.className = 'status';
    this.status.setAttribute('role', 'status');
    this.status.textContent = 'Not connected';
    this.image = doc.createElement('img');
    this.image.alt = 'Remote canvas';
    this.image.hidden = true;
    this.body = doc.createElement('div');
    bar.append(refresh, shot, this.status);
    root.append(style, title, bar, this.image, this.body);
    parent.append(this.element);
    refresh.addEventListener('click', () => void this.scene().catch((e) => this.show(e)));
    shot.addEventListener('click', () => void this.capture().catch((e) => this.show(e)));
  }
  /** Sends one operation and resolves with the target's result; rejects with its error or on timeout. */
  request<T = unknown>(op: RemoteOperation, args?: Record<string, unknown>): Promise<T> {
    if (this.disposed) return Promise.reject(margoError('disposed', 'RemoteInspector is disposed; create a new one'));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(
          margoError(
            'timeout',
            `The target did not answer ${op} in ${this.timeout} ms; check that its page is open and attached`,
          ),
        );
      }, this.timeout);
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.options.transport.send(JSON.stringify({ [tag]: version, id, op, args, token: this.options.token }));
    });
  }
  /** Says hello and lists the scene. */
  async connect(): Promise<RemoteHello> {
    this.target = await this.request<RemoteHello>('hello');
    await this.scene();
    return this.target;
  }
  /** Lists the target's objects again and rebuilds the panel. */
  async scene(): Promise<RemoteObject[]> {
    this.objects = await this.request<RemoteObject[]>('scene');
    this.build();
    return this.objects;
  }
  /** Edits one value on the target (checked there) and returns the object as it is now. */
  async set(id: string, key: string, value: PropertyValue): Promise<RemoteObject> {
    const object = await this.request<RemoteObject>('set', { id, key, value });
    const at = this.objects.findIndex((o) => o.id === id);
    if (at >= 0) this.objects[at] = object;
    return object;
  }
  /** Undoes the target's last remote edit; false when there was none. */
  undo(): Promise<boolean> {
    return this.request<boolean>('undo');
  }
  redo(): Promise<boolean> {
    return this.request<boolean>('redo');
  }
  /** A PNG of the target's canvas, shown in the panel. */
  async capture(): Promise<RemoteCapture> {
    const shot = await this.request<RemoteCapture>('capture');
    if (this.image) {
      this.image.src = `data:${shot.mimeType};base64,${shot.data}`;
      this.image.hidden = false;
    }
    return shot;
  }
  private receive(data: string): void {
    const m = parse(data);
    if (!m) return;
    if (m.event === 'stats') {
      this.stats = m.data as RemoteStats;
      this.line();
      return;
    }
    const wait = typeof m.id === 'number' ? this.waiting.get(m.id) : undefined;
    if (!wait || m.op !== undefined) return;
    this.waiting.delete(m.id!);
    clearTimeout(wait.timer);
    if (m.ok) wait.resolve(m.result);
    else wait.reject(new Error(m.error ?? 'The target refused the request; read the target page console'));
  }
  private line(): void {
    if (!this.status) return;
    this.status.dataset.state = 'ok';
    const t = this.target,
      s = this.stats;
    this.status.textContent = [t ? `${t.backend} ${t.width}x${t.height}` : '', s ? `${s.fps.toFixed(0)} fps` : '']
      .filter(Boolean)
      .join(', ');
  }
  private show(error: Error): void {
    if (!this.status) return;
    this.status.dataset.state = 'error';
    this.status.textContent = error.message;
  }
  private build(): void {
    if (!this.body) return;
    this.line();
    const doc = this.body.ownerDocument;
    this.body.replaceChildren(
      ...this.objects.map((object) => {
        const details = doc.createElement('details'),
          summary = doc.createElement('summary');
        summary.textContent = `${object.label} (${object.group})`;
        details.append(summary);
        for (const p of object.properties) {
          const label = doc.createElement('label'),
            name = doc.createElement('span'),
            inputs = this.inputs(doc, object, p);
          name.textContent = p.key;
          label.append(name, ...inputs);
          details.append(label);
        }
        return details;
      }),
    );
  }
  private inputs(doc: Document, object: RemoteObject, p: RemoteProperty): HTMLElement[] {
    const send = (value: PropertyValue) => void this.set(object.id, p.key, value).catch((e) => this.show(e));
    const make = (type: string, value: string) => {
      const input = doc.createElement('input');
      input.type = type;
      input.value = value;
      input.disabled = !!object.readOnly;
      input.setAttribute('aria-label', `${object.label} ${p.key}`);
      if (p.min !== null) input.min = String(p.min);
      if (p.max !== null) input.max = String(p.max);
      if (type === 'number') input.step = 'any';
      return input;
    };
    if (p.kind === 'boolean') {
      const input = make('checkbox', '');
      input.checked = p.value === true;
      input.addEventListener('change', () => send(input.checked));
      return [input];
    }
    if (p.kind === 'number') {
      const input = make('number', String(p.value));
      input.addEventListener('change', () => send(Number(input.value)));
      return [input];
    }
    if (p.kind === 'color') {
      const input = make('color', hexOf(p.value as number[]));
      input.addEventListener('input', () => send(linearOf(input.value)));
      return [input];
    }
    const box = doc.createElement('span'),
      axes = (p.value as number[]).map((v) => make('number', String(v)));
    box.className = 'axes';
    box.append(...axes);
    for (const input of axes) input.addEventListener('change', () => send(axes.map((a) => Number(a.value))));
    return [box];
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    for (const [, wait] of this.waiting) {
      clearTimeout(wait.timer);
      wait.reject(margoError('disposed', 'RemoteInspector was disposed before the target answered'));
    }
    this.waiting.clear();
    this.element?.remove();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

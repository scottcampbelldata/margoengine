// `?timing`: where the seconds of loading go, on screen as plain text, so a phone that nothing here can measure sends a
// screenshot (README.md says how to read it). A dynamic import: without the option this file is not even downloaded. It
// only watches: it wraps WebGPU's adapter, device and pipeline calls and WebSocket to note the times, and changes no
// argument, result or order. loadtime.mjs reads the same numbers through `window.voxelSandbox.timing`.

/** What a frame tells the timing. */
export interface FrameFacts {
  /** The world drew at least one chunk this frame. */
  drew: boolean;
  /** The page lets the player move: spawned, with the ground under the player in the world. */
  canMove: boolean;
  /** The chunks in the world. */
  world: number;
  /** The chunks with a mesh on the GPU. */
  meshed: number;
  /** The chunks on their way to the GPU. */
  pending: number;
  /** Light work done this frame. */
  light: number;
  /** Everything in range is drawn. */
  ready: boolean;
  /** Tier, view distance and canvas size, for the panel. */
  about: string;
}

/** The order the phases come in; a phase that did not happen shows a dash. */
export const PHASES = [
  ['html', 'HTML downloaded'],
  ['js', 'JS downloaded'],
  ['probe', 'WebGPU check done'],
  ['module', 'Game code starts'],
  ['adapter', 'GPU adapter'],
  ['device', 'GPU device'],
  ['engine', 'Engine ready'],
  ['setup', 'World set up'],
  ['frame', 'First frame'],
  ['join', 'Server chosen (/join)'],
  ['open', 'Socket open'],
  ['welcome', 'Welcome'],
  ['chunk', 'First chunk'],
  ['spawn', 'Spawn message'],
  ['pipelines', 'Shaders compiled'],
  ['draw', 'First world drawn'],
  ['move', 'CAN MOVE'],
  ['near', 'Ground drawn'],
  ['loaded', 'All chunks received'],
  ['meshed', 'Everything drawn'],
] as const;

export type PhaseName = (typeof PHASES)[number][0];

/** The panel's text from the phases: `name  time  gap`, in seconds from the moment the page was asked for. */
export function timingLines(marks: Readonly<Partial<Record<PhaseName, number>>>, extra: readonly string[]): string[] {
  const lines = ['Plaza load, seconds', ''];
  let last = 0;
  for (const [key, label] of PHASES) {
    const at = marks[key],
      name = label.padEnd(22);
    if (at === undefined) {
      lines.push(`${name}   -`);
      continue;
    }
    lines.push(`${name}${(at / 1000).toFixed(2).padStart(6)} +${(Math.max(0, at - last) / 1000).toFixed(2)}`);
    last = Math.max(last, at);
  }
  return [...lines, '', ...extra];
}

/** The watcher. Start it before the engine exists. */
export class LoadTiming {
  readonly marks: Partial<Record<PhaseName, number>> = {};
  /** Every quarter second until everything is drawn: seconds, chunks received, in the world, meshed, on their way. */
  readonly timeline: number[][] = [];
  readonly counts = {
    chunks: 0,
    chunkBytes: 0,
    messages: 0,
    pipelines: 0,
    pipelineMs: 0,
    longestFrame: 0,
    longFrames: 0,
    frames: 0,
    lightFrames: 0,
  };
  #panel: HTMLPreElement;
  #shown = 0;
  #sampled = 0;
  #openPipelines = 0;
  #started = false;
  #about = '';
  constructor() {
    this.#panel = document.createElement('pre');
    this.#panel.id = 'timing';
    this.#panel.setAttribute('aria-live', 'off');
    this.#panel.style.cssText =
      'position:fixed;z-index:9;left:0;top:0;margin:0;padding:6px 8px;max-width:100vw;box-sizing:border-box;' +
      'font:12px/1.3 ui-monospace,Menlo,Consolas,monospace;color:#fff;background:rgba(0,0,0,.78);' +
      'pointer-events:none;white-space:pre';
    document.body.append(this.#panel);
    const entry = (name: string) => performance.getEntriesByName(name)[0]?.startTime;
    this.mark('probe', entry('margo-probe-done'));
    this.mark('module', entry('margo-main'));
    this.#watchGpu();
    this.#watchSocket();
    this.show();
  }
  /** Notes phase `name`, once. */
  mark(name: PhaseName, at: number | undefined = performance.now()): void {
    if (at !== undefined && this.marks[name] === undefined) this.marks[name] = at;
  }
  #watchGpu(): void {
    const wrapResult = <T extends object>(proto: T, method: keyof T, done: (result: never) => void) => {
      const original = proto[method] as (...args: unknown[]) => Promise<never>;
      (proto as Record<keyof T, unknown>)[method] = function (this: unknown, ...args: unknown[]) {
        return original.apply(this, args).then((value) => {
          done(value);
          return value;
        });
      };
    };
    wrapResult(GPU.prototype, 'requestAdapter', () => this.mark('adapter'));
    wrapResult(GPUAdapter.prototype, 'requestDevice', () => this.mark('device'));
    const self = this;
    for (const name of ['createRenderPipelineAsync', 'createComputePipelineAsync'] as const) {
      const original = GPUDevice.prototype[name] as (...args: unknown[]) => Promise<unknown>;
      (GPUDevice.prototype as unknown as Record<string, unknown>)[name] = function (
        this: GPUDevice,
        ...args: unknown[]
      ) {
        const start = performance.now();
        self.#openPipelines++;
        const settle = () => {
          self.counts.pipelines++;
          self.counts.pipelineMs += performance.now() - start;
          if (!--self.#openPipelines) self.marks.pipelines = performance.now();
        };
        const result = original.apply(this, args);
        result.then(settle, settle);
        return result;
      };
    }
  }
  #watchSocket(): void {
    const self = this,
      Plain = globalThis.WebSocket;
    globalThis.WebSocket = class extends Plain {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('open', () => self.mark('open'));
        this.addEventListener('message', (event) => {
          if (!(event.data instanceof ArrayBuffer)) return;
          self.counts.messages++;
          const type = new Uint8Array(event.data)[0];
          if (type === 16) self.mark('welcome');
          else if (type === 17) {
            self.mark('chunk');
            self.counts.chunks++;
            self.counts.chunkBytes += event.data.byteLength;
          } else if (type === 22) self.mark('loaded');
        });
      }
    };
  }
  /** Call after every frame: `cpu` is its CPU milliseconds. */
  frame(cpu: number, facts: FrameFacts): void {
    const now = performance.now(),
      c = this.counts;
    this.#about = facts.about;
    if (!this.#started) {
      this.#started = true;
      this.mark('frame', now);
    }
    if (!this.marks.meshed) {
      c.frames++;
      if (facts.light) c.lightFrames++;
      if (cpu > 50) c.longFrames++;
      c.longestFrame = Math.max(c.longestFrame, cpu);
    }
    if (facts.drew) this.mark('draw', now);
    if (facts.canMove) {
      this.mark('move', now);
      // Meshes go nearest first, so nine chunks with quads is the ground around the player.
      if (facts.meshed >= 9) this.mark('near', now);
    }
    if (facts.ready) this.mark('meshed', now);
    if (now - this.#sampled >= 250 && !this.marks.meshed) {
      this.#sampled = now;
      this.timeline.push([
        +(now / 1000).toFixed(2),
        c.chunks,
        facts.world,
        facts.meshed,
        facts.pending,
        +c.longestFrame.toFixed(0),
      ]);
    }
    if (now - this.#shown >= 500 || (facts.ready && this.#shown < this.marks.meshed!)) this.show();
  }
  /** The resource numbers come late: read them when they are asked for. */
  #readDownloads(): { files: number; bytes: number } {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav?.responseEnd) this.mark('html', nav.responseEnd);
    let files = 0,
      bytes = nav?.encodedBodySize ?? 0,
      end = 0;
    for (const entry of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
      if (!/\.js(\?|$)/.test(entry.name) || /worker|timing/i.test(entry.name)) continue;
      files++;
      bytes += entry.encodedBodySize;
      if (entry.startTime < (this.marks.module ?? Number.POSITIVE_INFINITY)) end = Math.max(end, entry.responseEnd);
    }
    if (end) this.marks.js = end;
    return { files, bytes };
  }
  /** Everything, for loadtime.mjs. */
  read(): { marks: Partial<Record<PhaseName, number>>; counts: LoadTiming['counts']; timeline: number[][] } {
    this.#readDownloads();
    return { marks: { ...this.marks }, counts: { ...this.counts }, timeline: this.timeline };
  }
  /** Writes the panel. */
  show(): void {
    this.#shown = performance.now();
    const { files, bytes } = this.#readDownloads(),
      c = this.counts,
      connection = (navigator as { connection?: { effectiveType?: string; downlink?: number } }).connection,
      lines = timingLines(this.marks, [
        `JS ${files} files ${(bytes / 1024).toFixed(0)} KB (0 KB = cached or no header)`,
        `chunks ${c.chunks}, ${(c.chunkBytes / 1024).toFixed(0)} KB`,
        `pipelines ${c.pipelines}, sum ${(c.pipelineMs / 1000).toFixed(2)} s`,
        `frames ${c.frames}, longest ${(c.longestFrame / 1000).toFixed(2)} s, over 50 ms ${c.longFrames}`,
        this.#about,
        ...(connection?.effectiveType ? [`net ${connection.effectiveType} ${connection.downlink ?? ''} Mbps`] : []),
        `${screen.width}x${screen.height} @${devicePixelRatio}, ${navigator.hardwareConcurrency || '?'} cores`,
      ]);
    this.#panel.textContent = lines.join('\n');
  }
}

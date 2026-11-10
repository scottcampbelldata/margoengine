import { createStage, type Stage, type StageOptions } from './index.js';
import { addViewerExtras, type ViewerExtras, type ViewerExtrasOptions, type ViewerHotspot } from './viewer-extras.js';
import { fault, typeError } from '../../shared/errors.js';

/** Defaults for every instance of the explicitly registered custom element. Attributes override them. */
export interface ViewerElementOptions {
  stage?: StageOptions;
  viewer?: Omit<ViewerExtrasOptions, 'parent' | 'signal' | 'hotspots'>;
}
/** Imperative controls on the declarative viewer. Events bubble across the shadow boundary. */
export interface ModelViewerElement extends HTMLElement {
  src: string;
  readonly stage: Stage | null;
  readonly viewer: ViewerExtras | null;
  /** The current source's load, replaced on reload. Rejects on failure or cancellation. */
  readonly ready: Promise<void>;
  readonly availableAnimations: readonly string[];
  readonly availableVariants: readonly string[];
  readonly paused: boolean;
  currentTime: number;
  play(clip?: string | number): void;
  pause(): void;
  dismissPoster(): void;
  /** Reload the current src, including declarative hotspots. */
  reload(): Promise<void>;
}

/**
 * Register <margo-viewer> (or a chosen name) explicitly. Importing is SSR safe and registers nothing.
 * Attributes: src, alt, poster, reveal, autoplay, animation-name, variant-name, ar, auto-rotate.
 * Child annotations use slot="hotspot-name", data-position="x y z", optional data-node (name/index)
 * and data-offset="x y z". load/error and the controller's interaction events bubble from the element.
 */
export function registerViewerElement(
  name = 'margo-viewer',
  options: ViewerElementOptions = {},
): CustomElementConstructor {
  if (!globalThis.customElements || !globalThis.HTMLElement)
    throw fault('unsupported', 'Register the viewer element in a browser with Custom Elements');
  if (customElements.get(name))
    throw fault('state', `Custom element ${name} already registered; reuse its constructor`);
  class Element extends HTMLElement implements ModelViewerElement {
    static observedAttributes = [
      'src',
      'alt',
      'poster',
      'reveal',
      'autoplay',
      'animation-name',
      'variant-name',
      'ar',
      'auto-rotate',
    ];
    stage: Stage | null = null;
    viewer: ViewerExtras | null = null;
    ready: Promise<void> = Promise.resolve();
    private request?: AbortController;
    private scheduled = false;
    private readonly mount: HTMLDivElement;
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' }),
        style = this.ownerDocument.createElement('style');
      style.textContent = ':host{display:block;position:relative;min-height:150px} .mount{position:absolute;inset:0}';
      this.mount = this.ownerDocument.createElement('div');
      this.mount.className = 'mount';
      root.append(style, this.mount);
    }
    get src(): string {
      return this.getAttribute('src') ?? '';
    }
    set src(value: string) {
      this.setAttribute('src', value);
    }
    get availableAnimations(): readonly string[] {
      return this.viewer?.animation?.clips.map((clip) => clip.name) ?? [];
    }
    get availableVariants(): readonly string[] {
      return this.viewer?.model.variants ?? [];
    }
    get paused(): boolean {
      return !this.viewer?.animation?.playing;
    }
    get currentTime(): number {
      return this.viewer?.animation?.time ?? 0;
    }
    set currentTime(value: number) {
      this.requireViewer().seek(value);
    }
    play(clip?: string | number): void {
      this.requireViewer().play(clip);
    }
    pause(): void {
      this.requireViewer().pause();
    }
    dismissPoster(): void {
      this.requireViewer().dismissPoster();
    }
    private requireViewer(): ViewerExtras {
      if (!this.viewer) throw fault('state', 'Wait for the viewer element load event or ready promise');
      return this.viewer;
    }
    connectedCallback(): void {
      this.schedule();
    }
    disconnectedCallback(): void {
      this.clear();
    }
    attributeChangedCallback(key: string, before: string | null, after: string | null): void {
      if (before === after || !this.isConnected) return;
      // Controls update in place, preserving the visitor's camera and current model.
      if (this.viewer && ['autoplay', 'animation-name', 'variant-name', 'auto-rotate', 'alt'].includes(key)) {
        try {
          if (key === 'autoplay') {
            if (this.hasAttribute('autoplay')) this.play();
            else this.pause();
          }
          if (key === 'animation-name') {
            const paused = this.paused;
            this.play(after ?? 0);
            if (paused) this.pause();
          }
          if (key === 'variant-name') this.viewer.selectVariant(after ?? undefined);
          if (key === 'auto-rotate') this.viewer.turntable = this.hasAttribute('auto-rotate');
          if (key === 'alt') this.stage!.canvas.setAttribute('aria-label', after ?? '3D model');
        } catch (error) {
          this.emit('error', { error });
        }
      } else this.schedule();
    }
    private emit(name: string, detail?: unknown): void {
      this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
    }
    private schedule(): void {
      if (this.scheduled) return;
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (this.isConnected) void this.reload();
      });
    }
    private clear(): void {
      this.request?.abort();
      this.request = undefined;
      this.viewer?.dispose();
      this.viewer = null;
      this.stage?.dispose();
      this.stage = null;
      this.removeAttribute('aria-busy');
    }
    reload(): Promise<void> {
      this.clear();
      if (!this.isConnected || !this.src) return (this.ready = Promise.resolve());
      const request = new AbortController(),
        source = this.src,
        attr = (key: string): string | undefined => this.getAttribute(key) ?? undefined,
        defaults = options.viewer ?? {};
      this.request = request;
      this.setAttribute('aria-busy', 'true');
      const load = async (): Promise<void> => {
        const src = new URL(source, this.baseURI);
        const stage = await createStage(this.mount, {
          ...options.stage,
          label: attr('alt') ?? defaults.alt ?? '3D model',
        });
        if (request.signal.aborted) {
          stage.dispose();
          request.signal.throwIfAborted();
        }
        this.stage = stage;
        const viewer = await addViewerExtras(stage, src, {
          ...defaults,
          parent: this.mount,
          signal: request.signal,
          alt: attr('alt') ?? defaults.alt,
          poster: attr('poster') ?? defaults.poster,
          reveal: (attr('reveal') ?? defaults.reveal) as ViewerExtrasOptions['reveal'],
          autoplay: this.hasAttribute('autoplay') || defaults.autoplay,
          animationName: attr('animation-name') ?? defaults.animationName,
          variant: attr('variant-name') ?? defaults.variant,
          ar: this.hasAttribute('ar') || defaults.ar,
          turntable: this.hasAttribute('auto-rotate') || (defaults.turntable ?? false),
        });
        request.signal.throwIfAborted();
        this.viewer = viewer;
        for (const name of ['play', 'pause', 'variant-change', 'pick', 'poster-dismissed'])
          viewer.events.addEventListener(name, (event) => this.emit(name, (event as CustomEvent).detail), {
            signal: request.signal,
          });
        const vector = (value: string | undefined): [number, number, number] | undefined => {
          if (value === undefined) return undefined;
          const numbers = value.trim().split(/\s+/).map(Number);
          if (numbers.length !== 3 || !numbers.every(Number.isFinite))
            throw typeError('Hotspot vectors need three finite space-separated numbers', 'arguments');
          return numbers as [number, number, number];
        };
        for (const element of this.querySelectorAll<HTMLElement>('[slot^="hotspot-"]')) {
          const node = element.dataset.node,
            mesh =
              node === undefined
                ? undefined
                : viewer.model.nodes.find((mesh, index) => mesh.name === node || String(index) === node);
          if (node !== undefined && !mesh) throw fault('state', `Unknown hotspot node ${node}`);
          const hotspot: ViewerHotspot = {
            element,
            mesh,
            position: vector(element.dataset.position),
            offset: vector(element.dataset.offset),
          };
          await viewer.addHotspot(hotspot);
        }
        request.signal.throwIfAborted();
        stage.engine.render();
        this.removeAttribute('aria-busy');
        this.emit('load', { viewer });
      };
      this.ready = load().catch((error: unknown) => {
        if (!request.signal.aborted) {
          this.clear();
          this.emit('error', { error });
        }
        throw error;
      });
      // Attribute reactions have no promise consumer. Keep ready rejectable for explicit callers.
      void this.ready.catch(() => {});
      return this.ready;
    }
  }
  customElements.define(name, Element);
  return Element;
}

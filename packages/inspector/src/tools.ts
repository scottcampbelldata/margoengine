/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Camera, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import type { PBRModel } from '@margoengine/gltf-pro';
import type { CanvasRecording, CanvasRecordingOptions } from '@margoengine/video/record';
import { fault } from '../../shared/errors.js';

/** A named application camera. Its live pose and projection are copied while selected. */
export interface InspectorCamera {
  id: string;
  label: string;
  camera: Camera;
}
/** Tools placement, application cameras and additional loaded models. */
export interface CameraToolsOptions {
  /** Default document.body; null leaves the controls detached. */
  parent?: HTMLElement | ShadowRoot | null;
  cameras?: readonly InspectorCamera[];
  /** Loaded models outside the engine plugin list. Default automatic discovery. */
  models?: readonly PBRModel[];
  signal?: AbortSignal;
}
/** Screenshot format and cancellation. */
export interface ToolsScreenshotOptions {
  /** Default image/png. Unsupported browser encodings may return PNG. */
  type?: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Lossy encoder quality, 0..1. Default browser choice. */
  quality?: number;
  /** Default 10000 ms, positive and finite. */
  timeout?: number;
  signal?: AbortSignal;
}
/** glTF output and scope. */
export interface ToolsExportOptions {
  /** Default true for GLB; false returns embedded-buffer glTF JSON. */
  binary?: boolean;
  /** Default the engine scene; a loaded model preserves its PBR materials, skins and animations. */
  model?: PBRModel;
  signal?: AbortSignal;
}
type CameraPose = Pick<Camera, 'position' | 'target' | 'up' | 'fov' | 'near' | 'far' | 'project'>;
function cameraPose(camera: CameraPose): CameraPose {
  return {
    position: [...camera.position],
    target: [...camera.target],
    up: [...camera.up],
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
    project: camera.project,
  };
}
function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
let serial = 0;
/** Camera selection, canvas screenshots/recordings and lazy glTF export, usable beside any inspector panel. */
export class CameraTools implements EnginePlugin {
  readonly name = `inspector:tools:${++serial}`;
  readonly element: HTMLElement;
  private readonly runtime: Engine;
  private readonly home: CameraPose;
  private readonly cameras = new Map<string, InspectorCamera>();
  private readonly modelIds = new WeakMap<PBRModel, number>();
  private nextModel = 0;
  private active = 'default';
  private updateCamera?: () => void;
  private selection = 0;
  private signature = '';
  private disposed = false;
  private starting = false;
  private recording?: CanvasRecording;
  private readonly controller = new AbortController();
  private readonly urls = new Set<string>();
  private readonly picker: HTMLSelectElement;
  private readonly scope: HTMLSelectElement;
  private readonly format: HTMLSelectElement;
  private readonly output: HTMLOutputElement;
  private readonly recordButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly abort = () => this.dispose();
  /** Attaches the panel; pass inspector.root as parent to put it in the existing inspector. */
  static attach(engine: EngineKernel, options: CameraToolsOptions = {}): CameraTools {
    const result = new CameraTools(engine, options);
    try {
      engine.use(result);
      return result;
    } catch (error) {
      result.dispose();
      throw error;
    }
  }
  constructor(
    readonly engine: EngineKernel,
    private readonly options: CameraToolsOptions = {},
  ) {
    options.signal?.throwIfAborted();
    if (
      (options.cameras ?? []).some(
        (camera) =>
          !camera?.id ||
          camera.id === 'default' ||
          camera.id.startsWith('model:') ||
          !camera.camera ||
          typeof camera.label !== 'string',
      )
    )
      throw new TypeError('Use named application cameras with unreserved ids');
    this.runtime = engineRuntime(engine);
    this.home = cameraPose(engine.camera);
    const doc = engine.canvas.ownerDocument;
    this.element = doc.createElement('fieldset');
    const legend = doc.createElement('legend');
    legend.textContent = 'Cameras and capture';
    this.element.append(legend);
    const select = (label: string) => {
      const wrap = doc.createElement('label'),
        input = doc.createElement('select');
      wrap.textContent = label;
      input.setAttribute('aria-label', label);
      wrap.append(input);
      this.element.append(wrap);
      return input;
    };
    this.picker = select('Camera');
    this.picker.addEventListener('change', () => this.action(() => this.select(this.picker.value)));
    this.scope = select('Export scope');
    this.format = select('Export format');
    for (const [value, text] of [
      ['glb', 'Binary glTF (.glb)'],
      ['gltf', 'glTF JSON (.gltf)'],
    ]) {
      const option = doc.createElement('option');
      option.value = value;
      option.textContent = text;
      this.format.append(option);
    }
    const button = (label: string, action: () => Promise<unknown>) => {
      const input = doc.createElement('button');
      input.type = 'button';
      input.textContent = label;
      input.addEventListener('click', () => this.action(action));
      this.element.append(input);
      return input;
    };
    button('Screenshot', async () => this.download(await this.screenshot(), 'screenshot.png'));
    this.recordButton = button('Record canvas', () => this.startRecording());
    this.stopButton = button('Stop recording', async () => this.download(await this.stopRecording(), 'recording.webm'));
    button('Export glTF', async () => {
      const binary = this.format.value === 'glb',
        model = this.models().find((model) => this.modelKey(model) === this.scope.value);
      this.download(await this.exportGLTF({ binary, model }), binary ? 'scene.glb' : 'scene.gltf');
    });
    this.output = doc.createElement('output');
    this.output.setAttribute('aria-live', 'polite');
    this.element.append(this.output);
    (options.parent === undefined ? doc.body : options.parent)?.append(this.element);
    for (const camera of options.cameras ?? []) this.addCamera(camera);
    options.signal?.addEventListener('abort', this.abort, { once: true });
    this.refresh();
  }
  setup(): void {}
  private signal(signal?: AbortSignal): AbortSignal {
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    combined.throwIfAborted();
    return combined;
  }
  private async action(run: () => Promise<unknown>): Promise<void> {
    try {
      this.output.textContent = '';
      await run();
    } catch (error) {
      if (!this.disposed) this.output.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      this.refresh();
    }
  }
  private models(): PBRModel[] {
    const result = new Set(this.options.models ?? []);
    for (const scene of this.runtime.scenes)
      for (const plugin of scene.plugins.values())
        if ('asset' in plugin && 'nodes' in plugin && 'cameras' in plugin) result.add(plugin as PBRModel);
    return [...result].filter((model) => !model.disposed);
  }
  private modelKey(model: PBRModel): string {
    if (!this.modelIds.has(model)) this.modelIds.set(model, ++this.nextModel);
    return `model:${this.modelIds.get(model)}`;
  }
  /** Lists registered application and live glTF cameras. The default entry restores the original engine camera. */
  list(): readonly { id: string; label: string }[] {
    return [
      { id: 'default', label: 'Default camera' },
      ...[...this.cameras.values()].map(({ id, label }) => ({ id, label })),
      ...this.models().flatMap((model) =>
        model.cameras.map((camera, index) => ({
          id: `${this.modelKey(model)}:${index}`,
          label: `${model.name}: ${camera.name || `Camera ${index}`}`,
        })),
      ),
    ];
  }
  /** Adds or replaces a named application camera; ids beginning model: and default are reserved. */
  addCamera(camera: InspectorCamera): this {
    if (
      this.disposed ||
      !camera?.id ||
      camera.id === 'default' ||
      camera.id.startsWith('model:') ||
      !camera.camera ||
      typeof camera.label !== 'string'
    )
      throw new TypeError('Use a live panel and a named application camera with a unique unreserved id');
    this.cameras.set(camera.id, camera);
    if (this.active === camera.id)
      this.updateCamera = () => Object.assign(this.engine.camera, cameraPose(camera.camera));
    this.signature = '';
    this.refresh();
    return this;
  }
  /** Removes an application camera. Removing the active camera restores the original view. */
  removeCamera(id: string): void {
    this.cameras.delete(id);
    if (this.active === id) this.restoreCamera();
    this.signature = '';
    this.refresh();
  }
  private restoreCamera(): void {
    this.selection++;
    this.updateCamera = undefined;
    this.active = 'default';
    Object.assign(this.engine.camera, cameraPose(this.home));
  }
  /** Activates a camera. Loaded-camera projection code is imported only for a loaded glTF camera. */
  async select(id: string): Promise<void> {
    this.signal();
    const selection = ++this.selection;
    if (id === 'default') {
      this.restoreCamera();
      this.refresh();
      return;
    }
    const application = this.cameras.get(id);
    let update: () => void;
    if (application) update = () => Object.assign(this.engine.camera, cameraPose(application.camera));
    else {
      const model = this.models().find((model) => id.startsWith(this.modelKey(model) + ':')),
        index = Number(id.slice(id.lastIndexOf(':') + 1));
      if (!model || !Number.isInteger(index) || !model.cameras[index])
        throw new RangeError('Use an id from CameraTools.list()');
      const { viewGLTFCamera } = await waitFor(import('@margoengine/gltf-pro'), this.controller.signal);
      this.signal();
      if (!this.models().includes(model))
        throw fault('disposed', 'The selected camera model is no longer available; select a live camera');
      update = () => {
        this.engine.camera.project = undefined;
        viewGLTFCamera(model, index);
      };
    }
    if (selection !== this.selection) return;
    update();
    this.active = id;
    this.updateCamera = update;
    this.refresh();
  }
  onPreUpdate(): void {
    if (!this.list().some((camera) => camera.id === this.active)) this.restoreCamera();
    this.updateCamera?.();
    this.refresh();
  }
  /** Renders and serializes the canvas. DOM overlays are outside this image. */
  screenshot(options: ToolsScreenshotOptions = {}): Promise<Blob> {
    const signal = this.signal(options.signal),
      timeout = options.timeout ?? 10000;
    if (
      !Number.isFinite(timeout) ||
      timeout <= 0 ||
      (options.quality !== undefined &&
        (!Number.isFinite(options.quality) || options.quality < 0 || options.quality > 1))
    )
      throw new RangeError('Use a positive screenshot timeout and quality from 0 to 1');
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (blob?: Blob | null, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(limit);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else if (blob) resolve(blob);
        else reject(fault('failed', 'Screenshot encoder returned no image; check canvas origin access'));
      };
      const abort = () => finish(undefined, signal.reason),
        limit = setTimeout(
          () => finish(undefined, fault('timeout', 'Screenshot timed out; check the encoder or increase timeout')),
          timeout,
        );
      signal.addEventListener('abort', abort, { once: true });
      try {
        this.engine.render();
        this.engine.canvas.toBlob((blob) => finish(blob), options.type ?? 'image/png', options.quality);
      } catch (error) {
        finish(undefined, error);
      }
    });
  }
  /** Starts browser recording; the video/record entry loads on this action only. */
  async startRecording(options: CanvasRecordingOptions = {}): Promise<CanvasRecording> {
    const signal = this.signal(options.signal);
    if (this.recording || this.starting)
      throw fault('state', 'Stop the current canvas recording before starting another');
    this.starting = true;
    this.refresh();
    try {
      const { recordCanvas } = await waitFor(import('@margoengine/video/record'), signal);
      signal.throwIfAborted();
      const recording = (this.recording = recordCanvas(this.engine.canvas, { ...options, signal }));
      void recording.result.then(
        () => {
          if (this.recording === recording) {
            this.recording = undefined;
            this.refresh();
          }
        },
        (error) => {
          if (this.recording === recording) {
            this.recording = undefined;
            if (!this.disposed) this.output.textContent = String(error);
            this.refresh();
          }
        },
      );
      return recording;
    } finally {
      this.starting = false;
      this.refresh();
    }
  }
  /** Finishes recording after its final data event, returning the actual encoded file. */
  async stopRecording(): Promise<Blob> {
    this.signal();
    if (!this.recording) throw fault('state', 'Start a canvas recording before stopping it');
    return this.recording.stop();
  }
  /** Exports the engine scene or a selected loaded model with the existing exporter package. */
  async exportGLTF(options: ToolsExportOptions = {}): Promise<Blob> {
    const signal = this.signal(options.signal),
      binary = options.binary ?? true,
      exporters = await waitFor(import('@margoengine/exporters'), signal);
    signal.throwIfAborted();
    const model = options.model;
    if (model && (model.disposed || model.root.engine !== this.runtime))
      throw new TypeError('Use a live model from this tools engine for export');
    const animations = model
      ? [...this.runtime.scenes]
          .flatMap((scene) => [...scene.plugins.values()])
          .filter(
            (plugin): plugin is import('@margoengine/animation').Animation =>
              'model' in plugin && plugin.model === model && 'clips' in plugin,
          )
      : [];
    const result = model
      ? await waitFor(exporters.exportModel(model, { binary, animations }), signal)
      : binary
        ? exporters.exportGLB(this.engine)
        : exporters.exportGLTF(this.engine);
    signal.throwIfAborted();
    return result instanceof Uint8Array
      ? new Blob([result as Uint8Array<ArrayBuffer>], { type: 'model/gltf-binary' })
      : new Blob([JSON.stringify(result.json)], { type: 'model/gltf+json' });
  }
  private download(blob: Blob, name: string): void {
    this.signal();
    const url = URL.createObjectURL(blob),
      link = this.element.ownerDocument.createElement('a');
    this.urls.add(url);
    link.href = url;
    link.download = name;
    link.textContent = name;
    this.element.append(link);
    link.click();
    this.output.textContent = `Saved ${name}`;
  }
  /** Refreshes camera/model choices and recording button availability. */
  refresh(): void {
    if (this.disposed || !this.picker) return;
    const cameras = this.list(),
      models = this.models(),
      signature = JSON.stringify([cameras, models.map((model) => [this.modelKey(model), model.name])]);
    if (signature !== this.signature) {
      this.signature = signature;
      const add = (select: HTMLSelectElement, id: string, label: string) => {
        const option = select.ownerDocument.createElement('option');
        option.value = id;
        option.textContent = label;
        select.append(option);
      };
      this.picker.replaceChildren();
      cameras.forEach((camera) => add(this.picker, camera.id, camera.label));
      const scope = this.scope.value;
      this.scope.replaceChildren();
      add(this.scope, 'scene', 'Engine scene');
      models.forEach((model) => add(this.scope, this.modelKey(model), model.name));
      this.scope.value = [...this.scope.options].some((option) => option.value === scope) ? scope : 'scene';
    }
    this.picker.value = this.active;
    this.recordButton.disabled = this.starting || !!this.recording;
    this.stopButton.disabled = !this.recording;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.restoreCamera();
    this.controller.abort();
    this.recording?.dispose();
    this.recording = undefined;
    this.options.signal?.removeEventListener('abort', this.abort);
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
    this.element.remove();
    this.runtime.sceneOf(this)?.removePlugin(this.name);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

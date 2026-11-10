/// <reference lib="esnext.disposable" preserve="true" />
import type { Animation } from '@margoengine/animation';
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import { SkeletonHelper } from '@margoengine/lines';
import { interpolateQuaternions } from '@margoengine/math/quat';
import { fault, rangeError } from '../../shared/errors.js';

/** A clip's independent playback controls. Times are seconds, weights are nonnegative and normalized per model. */
export interface InspectorClipState {
  time: number;
  weight: number;
  playing: boolean;
  loop: boolean;
  speed: number;
}
/** Animation panel placement and cancellation. */
export interface AnimationPanelOptions {
  /** Default document.body; null keeps the controls detached. */
  parent?: HTMLElement | ShadowRoot | null;
  /** Default none. Aborting disposes the panel and restores each player's playback state. */
  signal?: AbortSignal;
}
type Pose = { nodes: number[][]; morphs: Float32Array[] };
const keys = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz'] as const;
function read(animation: Animation): Pose {
  const t = animation.model.root.engine.store.transforms;
  return {
    nodes: animation.model.nodes.map((n) => keys.map((key) => t[key][n.id])),
    morphs: animation.model.primitives.map((p) => p.weights.slice()),
  };
}
function write(animation: Animation, pose: Pose): void {
  animation.model.nodes.forEach((node, i) => {
    const p = pose.nodes[i];
    node.setPosition([p[0], p[1], p[2]]).setQuaternion([p[3], p[4], p[5], p[6]]).setScale([p[7], p[8], p[9]]);
  });
  animation.model.primitives.forEach((p, i) => p.weights.set(pose.morphs[i]));
}
function mix(out: Pose, sample: Pose, weight: number): void {
  out.nodes.forEach((p, i) => {
    const q = sample.nodes[i],
      rotation = interpolateQuaternions(p.slice(3, 7), q.slice(3, 7), weight, 0.9995);
    for (let c = 0; c < p.length; c++) p[c] = c >= 3 && c < 7 ? rotation[c - 3] : p[c] + (q[c] - p[c]) * weight;
  });
  out.morphs.forEach((p, i) => {
    for (let c = 0; c < p.length; c++) p[c] += (sample.morphs[i][c] - p[c]) * weight;
  });
}
interface ModelControl {
  animation: Animation;
  initial: ReturnType<Animation['captureState']>;
  rest: Pose;
  states: InspectorClipState[];
  helpers: SkeletonHelper[];
  skeleton: boolean;
  element: HTMLElement;
  inputs: HTMLInputElement[][];
  off: () => void;
}
let serial = 0;
/** Per-model play, pause, scrub and weighted clips, plus an on-top skeleton on either rendering backend. */
export class AnimationPanel implements EnginePlugin {
  readonly name = `inspector:animation:${++serial}`;
  readonly element: HTMLElement;
  readonly overlay: SVGSVGElement;
  private readonly models = new Map<Animation, ModelControl>();
  private readonly runtime: Engine;
  private disposed = false;
  private readonly abort = () => this.dispose();
  /** Attaches the panel. Omitted players are discovered from the engine's Animation plugins. */
  static attach(
    engine: EngineKernel,
    players?: readonly Animation[],
    options: AnimationPanelOptions = {},
  ): AnimationPanel {
    const panel = new AnimationPanel(engine, options);
    try {
      engine.use(panel);
      for (const player of players ??
        ([...panel.runtime.plugins.values()].filter((p) => 'clips' in p && 'model' in p && 'seek' in p) as Animation[]))
        panel.add(player);
      return panel;
    } catch (error) {
      panel.dispose();
      throw error;
    }
  }
  constructor(
    readonly engine: EngineKernel,
    private readonly options: AnimationPanelOptions = {},
  ) {
    options.signal?.throwIfAborted();
    this.runtime = engineRuntime(engine);
    const doc = engine.canvas.ownerDocument;
    this.element = doc.createElement('section');
    this.element.setAttribute('aria-label', 'Animations');
    this.overlay = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.overlay.setAttribute('aria-label', 'Skeleton overlay');
    this.overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:10000;overflow:hidden';
    doc.body.append(this.overlay);
    (options.parent === undefined ? doc.body : options.parent)?.append(this.element);
    options.signal?.addEventListener('abort', this.abort, { once: true });
  }
  setup(): void {}
  /** Adds a live player from this engine. The panel owns its clock until remove or dispose. */
  add(animation: Animation): this {
    if (this.disposed || animation.model.disposed || animation.model.root.engine !== this.runtime)
      throw fault('state', 'Use a live Animation from this panel engine');
    if (this.models.has(animation)) return this;
    const initial = animation.captureState(),
      rest = read(animation),
      doc = this.element.ownerDocument,
      element = doc.createElement('fieldset'),
      legend = doc.createElement('legend');
    legend.textContent = animation.model.name || 'Model';
    element.append(legend);
    const helpers = (animation.model.asset.doc.skins ?? []).map((_, i) => SkeletonHelper.fromGLTF(animation.model, i));
    const control: ModelControl = {
      animation,
      initial,
      rest,
      helpers,
      skeleton: false,
      element,
      inputs: [],
      states: animation.clips.map((_, i) => ({
        time: i === initial.clip ? initial.time : 0,
        weight: i === initial.clip ? 1 : 0,
        playing: initial.playing,
        loop: initial.loop,
        speed: initial.speed,
      })),
      off: () => {},
    };
    const skeleton = doc.createElement('input');
    skeleton.type = 'checkbox';
    const label = doc.createElement('label');
    label.textContent = 'Skeleton';
    label.append(skeleton);
    element.append(label);
    skeleton.disabled = helpers.length === 0;
    skeleton.addEventListener('change', () => {
      control.skeleton = skeleton.checked;
      this.drawSkeletons();
    });
    animation.clips.forEach((clip, index) => {
      const row = doc.createElement('fieldset'),
        title = doc.createElement('legend');
      title.textContent = clip.name || `Clip ${index}`;
      row.append(title);
      for (const [text, playing] of [
        ['Play', true],
        ['Pause', false],
      ] as const) {
        const button = doc.createElement('button');
        button.textContent = text;
        button.type = 'button';
        button.addEventListener('click', () => this.set(animation, index, { playing }));
        row.append(button);
      }
      const inputs: HTMLInputElement[] = [];
      for (const [text, key, min, max, step] of [
        ['Time', 'time', 0, clip.duration, 0.001],
        ['Weight', 'weight', 0, 1, 0.01],
        ['Speed', 'speed', 0, 10, 0.1],
      ] as const) {
        const input = doc.createElement('input'),
          label = doc.createElement('label');
        label.textContent = text;
        input.type = key === 'time' ? 'range' : 'number';
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.setAttribute('aria-label', `${clip.name || index} ${text}`);
        label.append(input);
        row.append(label);
        inputs.push(input);
        input.addEventListener('input', () =>
          this.set(animation, index, { [key]: input.valueAsNumber, ...(key === 'time' ? { playing: false } : {}) }),
        );
      }
      const loop = doc.createElement('input'),
        loopLabel = doc.createElement('label');
      loop.type = 'checkbox';
      loopLabel.textContent = 'Loop';
      loopLabel.append(loop);
      row.append(loopLabel);
      inputs.push(loop);
      loop.addEventListener('change', () => this.set(animation, index, { loop: loop.checked }));
      control.inputs.push(inputs);
      element.append(row);
    });
    control.off = animation.model.onDispose(() => this.remove(animation));
    this.models.set(animation, control);
    animation.playing = false;
    this.element.append(element);
    this.syncInputs(control);
    return this;
  }
  /** Returns a copy of one clip's state; clip indices disambiguate duplicate names. */
  state(animation: Animation, clip: number): Readonly<InspectorClipState> {
    return { ...this.control(animation, clip).states[clip] };
  }
  private control(animation: Animation, clip: number): ModelControl {
    const control = this.models.get(animation);
    if (!control || !Number.isInteger(clip) || !control.states[clip])
      throw rangeError('Use a clip index from a player added to this panel', 'state');
    return control;
  }
  /** Changes playback, immediately posing scrubs and weight edits. Scrubbing through the UI pauses that clip. */
  set(animation: Animation, clip: number, patch: Partial<InspectorClipState>): this {
    const control = this.control(animation, clip),
      state = { ...control.states[clip], ...patch };
    if (
      ![state.time, state.weight, state.speed].every((v) => Number.isFinite(v) && v >= 0) ||
      typeof state.playing !== 'boolean' ||
      typeof state.loop !== 'boolean'
    )
      throw rangeError('Use finite nonnegative time, weight and speed, and boolean playing and loop', 'state');
    state.time = Math.min(state.time, animation.clips[clip].duration);
    control.states[clip] = state;
    this.pose(control);
    this.syncInputs(control);
    return this;
  }
  private pose(control: ModelControl): void {
    const { animation, rest } = control;
    let result: Pose | undefined,
      total = 0;
    for (const [i, state] of control.states.entries())
      if (state.weight > 0) {
        write(animation, rest);
        animation.clip = i;
        // A scrub to the final frame must hold it even when looping playback is enabled.
        animation.options.loop = false;
        animation.seek(state.time);
        const sample = read(animation);
        total += state.weight;
        if (result) mix(result, sample, state.weight / total);
        else result = sample;
      }
    write(animation, result ?? rest);
    animation.playing = false;
  }
  private syncInputs(control: ModelControl): void {
    control.states.forEach((state, i) => {
      const inputs = control.inputs[i];
      [state.time, state.weight, state.speed].forEach((v, c) => {
        inputs[c].value = String(v);
      });
      inputs[3].checked = state.loop;
    });
  }
  onPreUpdate(delta: number): void {
    for (const control of this.models.values()) {
      for (const [i, state] of control.states.entries())
        if (state.playing) {
          const duration = control.animation.clips[i].duration;
          state.time += delta * state.speed;
          if (state.loop && duration > 0) state.time %= duration;
          else if (state.time >= duration) {
            state.time = duration;
            state.playing = false;
          }
        }
      this.pose(control);
      this.syncInputs(control);
    }
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: this.name, order: 21, execute: () => this.drawSkeletons() });
  }
  /** Refreshes projected joint segments after world matrices change; also used by the registered render pass. */
  drawSkeletons(): void {
    const rect = this.engine.canvas.getBoundingClientRect(),
      svg = this.overlay,
      m = this.runtime.camera.matrix;
    Object.assign(svg.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    svg.setAttribute('viewBox', `0 0 ${this.engine.canvas.width} ${this.engine.canvas.height}`);
    const paths: string[] = [];
    for (const control of this.models.values())
      if (control.skeleton)
        for (const helper of control.helpers) {
          if (!helper.update(this.engine)) continue;
          for (let i = 0; i + 1 < helper.count; i += 2) {
            const project = (j: number) => {
              const p = helper.points,
                x = p[j * 4],
                y = p[j * 4 + 1],
                z = p[j * 4 + 2],
                w = m[3] * x + m[7] * y + m[11] * z + m[15];
              return w <= 0
                ? null
                : [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w];
            };
            const a = project(i),
              b = project(i + 1);
            if (a && b)
              paths.push(
                `M${((a[0] + 1) * this.engine.canvas.width) / 2},${((1 - a[1]) * this.engine.canvas.height) / 2}L${((b[0] + 1) * this.engine.canvas.width) / 2},${((1 - b[1]) * this.engine.canvas.height) / 2}`,
              );
          }
        }
    svg.replaceChildren();
    const path = svg.ownerDocument.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', paths.join(''));
    path.setAttribute('stroke', '#ff7a2e');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('fill', 'none');
    svg.append(path);
  }
  /** Removes a model and restores the original player state. A disposed model is left alone. */
  remove(animation: Animation): void {
    const control = this.models.get(animation);
    if (!control) return;
    this.models.delete(animation);
    control.off();
    control.element.remove();
    control.helpers.forEach((h) => h.dispose());
    if (!animation.model.disposed) {
      write(animation, control.rest);
      animation.restoreState(control.initial);
    }
    this.drawSkeletons();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const animation of this.models.keys()) this.remove(animation);
    this.options.signal?.removeEventListener('abort', this.abort);
    this.overlay.remove();
    this.element.remove();
    this.runtime.removePlugin(this.name);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

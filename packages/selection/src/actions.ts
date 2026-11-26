/// <reference lib="esnext.disposable" preserve="true" />
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** The trigger names. Times are in seconds, like the `dt` of {@link ActionSystem.update}. */
export type TriggerType =
  | 'pick'
  | 'doublePick'
  | 'longPick'
  | 'pickDown'
  | 'pickUp'
  | 'pointerOver'
  | 'pointerOut'
  | 'intersectEnter'
  | 'intersectExit'
  | 'everyFrame'
  | 'keyDown'
  | 'keyUp';
/** A trigger with parameters. `delay` is for longPick (default 0.5 s), `key` filters key triggers (a `KeyboardEvent.key` or a list; unset matches every key), `other` is the node an intersect trigger watches. */
export interface TriggerSpec<N = unknown> {
  type: TriggerType;
  delay?: number;
  key?: string | readonly string[];
  other?: N;
}
/** A trigger name, or a {@link TriggerSpec} when it takes parameters. */
export type Trigger<N = unknown> = TriggerType | TriggerSpec<N>;
/** What an action or condition receives. */
export interface ActionContext<N = unknown> {
  trigger: TriggerType;
  /** The node whose manager fired. */
  node: N;
  /** The other node of an intersect trigger. */
  other?: N;
  /** The key of a key trigger. */
  key?: string;
  /** The pointer position (CSS pixels) of a pointer trigger. */
  x?: number;
  y?: number;
  manager: ActionManager<N>;
}
/**
 * One step of a chain. Return nothing for an instant action, or a stepper `(dt) => done` for a timed one; the chain
 * waits until the stepper returns true before it starts the next link.
 */
export type Action<N = unknown> = (context: ActionContext<N>) => void | ((dt: number) => boolean);
/** A predicate that must hold for a link to run; a false condition ends that firing of the chain. */
export type Condition<N = unknown> = (context: ActionContext<N>) => boolean;
/** How a registration walks its chain: `sequence` runs every link on each firing (default), `step` runs the next link only, wrapping at the end. */
export type ChainMode = 'sequence' | 'step';
/** Easing from 0..1 to 0..1 for {@link interpolate}. Default linear. */
export type Ease = (t: number) => number;

const types: readonly string[] = [
  'pick',
  'doublePick',
  'longPick',
  'pickDown',
  'pickUp',
  'pointerOver',
  'pointerOut',
  'intersectEnter',
  'intersectExit',
  'everyFrame',
  'keyDown',
  'keyUp',
];
const bad = (what: string) => rangeError(`${what}; see the actions README`, 'actions');
const gone = () => fault('disposed', 'ActionManager is disposed; create a new one', 'actions');
const keyMatches = (spec: TriggerSpec<any>, key?: string) =>
  spec.key === undefined || (typeof spec.key === 'string' ? spec.key === key : spec.key.includes(key as string));

interface Link<N> {
  action: Action<N>;
  condition?: Condition<N>;
}
interface Registration<N> {
  spec: TriggerSpec<N>;
  links: Link<N>[];
  mode: ChainMode;
  next: number;
  longFired: boolean;
  inside: boolean;
}
interface Run<N> {
  context: ActionContext<N>;
  links: Link<N>[];
  at: number;
  stepper?: (dt: number) => boolean;
}
/** The handle `registerAction` returns: `then` appends the next link of the chain. */
export class ActionChain<N = unknown> {
  /** @internal */
  constructor(private readonly reg: Registration<N>) {}
  /** Add a link; in `sequence` mode it runs after the previous link finished, in `step` mode on the next firing. */
  then(action: Action<N>, condition?: Condition<N>): this {
    if (typeof action !== 'function')
      throw typeError('ActionChain.then needs an action function; build one with run(), setValue() or interpolate()', 'actions');
    this.reg.links.push({ action, condition });
    return this;
  }
}
/**
 * Declarative trigger-to-action rules of one node. Create it through {@link ActionSystem.manager} to get pointer, key
 * and intersection triggers, or alone and call {@link ActionManager.fire} and {@link ActionManager.update} yourself.
 */
export class ActionManager<N = unknown> {
  private regs: Registration<N>[] = [];
  private runs: Run<N>[] = [];
  private over = false;
  private disposed = false;
  constructor(readonly node: N) {}
  /** Register `action` for `trigger` and return its chain; a false `condition` skips the firing. */
  registerAction(
    trigger: Trigger<N>,
    action: Action<N>,
    condition?: Condition<N>,
    mode: ChainMode = 'sequence',
  ): ActionChain<N> {
    if (this.disposed) throw gone();
    const spec: TriggerSpec<N> = typeof trigger === 'string' ? { type: trigger } : { ...trigger };
    if (!types.includes(spec.type)) throw bad(`Unknown action trigger ${String(spec.type)}`);
    if (typeof action !== 'function')
      throw typeError('registerAction needs an action function; build one with run(), setValue() or interpolate()', 'actions');
    if (mode !== 'sequence' && mode !== 'step') throw bad('Chain mode must be sequence or step');
    if (spec.delay !== undefined && !(Number.isFinite(spec.delay) && spec.delay >= 0))
      throw bad('longPick delay must be seconds, 0 or more');
    if (spec.type.startsWith('intersect') && spec.other === undefined)
      throw bad(`${spec.type} needs the other node to watch`);
    const reg: Registration<N> = { spec, links: [{ action, condition }], mode, next: 0, longFired: false, inside: false };
    this.regs.push(reg);
    return new ActionChain(reg);
  }
  /** Remove every registration of `type`; returns how many went. Running chains finish. */
  unregister(type: TriggerType): number {
    const before = this.regs.length;
    this.regs = this.regs.filter((r) => r.spec.type !== type);
    return before - this.regs.length;
  }
  /** Fire the registrations of `type`. `key` picks key triggers, `other` intersect triggers. */
  fire(type: TriggerType, extra: Partial<Omit<ActionContext<N>, 'trigger' | 'node' | 'manager'>> = {}): void {
    if (this.disposed) throw gone();
    for (const reg of this.regs.slice()) {
      const { spec } = reg;
      if (spec.type !== type || !keyMatches(spec, extra.key) || (spec.other !== undefined && spec.other !== extra.other)) continue;
      this.start(reg, { trigger: type, node: this.node, manager: this, ...extra });
    }
  }
  /** Advance running chains by `dt` seconds, then fire everyFrame. */
  update(dt: number): void {
    if (this.disposed) throw gone();
    if (!(Number.isFinite(dt) && dt >= 0)) throw bad('update needs dt seconds, 0 or more');
    for (const run of this.runs.slice()) this.advance(run, dt);
    this.fire('everyFrame');
  }
  /** The pointer entered or left the node; fires pointerOver / pointerOut once per change. */
  hover(inside: boolean, extra: { x?: number; y?: number } = {}): void {
    if (inside === this.over) return;
    this.over = inside;
    this.fire(inside ? 'pointerOver' : 'pointerOut', extra);
  }
  /** Fire longPick registrations whose delay `held` seconds reached, once per press. Returns true if any fired. */
  hold(held: number, extra: { x?: number; y?: number } = {}): boolean {
    let fired = false;
    for (const reg of this.regs) {
      if (reg.spec.type !== 'longPick' || reg.longFired || held < (reg.spec.delay ?? 0.5)) continue;
      reg.longFired = fired = true;
      this.start(reg, { trigger: 'longPick', node: this.node, manager: this, ...extra });
    }
    return fired;
  }
  /** A new press begins: rearm the longPick registrations. */
  rearm(): void {
    for (const reg of this.regs) reg.longFired = false;
  }
  /** Ask `overlaps(node, other)` for each intersect registration; fires enter on false to true and exit on true to false. */
  intersect(overlaps: (node: N, other: N) => boolean): void {
    if (this.disposed) throw gone();
    for (const reg of this.regs.slice()) {
      const { type, other } = reg.spec;
      if (type !== 'intersectEnter' && type !== 'intersectExit') continue;
      const now = overlaps(this.node, other as N);
      const was = reg.inside;
      reg.inside = now;
      if (now !== was && type === (now ? 'intersectEnter' : 'intersectExit'))
        this.start(reg, { trigger: type, node: this.node, other, manager: this });
    }
  }
  /** True when any intersect trigger is registered. */
  get watchesIntersections(): boolean {
    return this.regs.some((r) => r.spec.type.startsWith('intersect'));
  }
  /** Number of chains still waiting on a timed action. */
  get running(): number {
    return this.runs.length;
  }
  /** Drop all registrations and running chains. */
  dispose(): void {
    this.disposed = true;
    this.regs = [];
    this.runs = [];
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
  private start(reg: Registration<N>, context: ActionContext<N>): void {
    let links = reg.links.slice();
    if (reg.mode === 'step') {
      links = [links[reg.next % links.length] as Link<N>];
      reg.next = (reg.next + 1) % reg.links.length;
    }
    this.advance({ context, links, at: 0 }, 0);
  }
  private advance(run: Run<N>, dt: number): void {
    let waiting = false;
    if (run.stepper) {
      if (run.stepper(dt)) run.stepper = undefined;
      else waiting = true;
    }
    while (!waiting && run.at < run.links.length) {
      const link = run.links[run.at++] as Link<N>;
      if (link.condition && !link.condition(run.context)) {
        run.at = run.links.length;
        break;
      }
      const stepper = link.action(run.context);
      if (typeof stepper === 'function' && !stepper(0)) {
        run.stepper = stepper;
        waiting = true;
      }
    }
    const index = this.runs.indexOf(run);
    if (waiting && index < 0) this.runs.push(run);
    else if (!waiting && index >= 0) this.runs.splice(index, 1);
  }
}

/** An action that calls `callback` with the context. */
export const run =
  <N = unknown>(callback: (context: ActionContext<N>) => void): Action<N> =>
  (context) => {
    callback(context);
  };
/** An action that waits `seconds` before the chain continues. */
export const wait =
  <N = unknown>(seconds: number): Action<N> =>
  () => {
    if (!(Number.isFinite(seconds) && seconds >= 0)) throw bad('wait needs seconds, 0 or more');
    let t = 0;
    return (dt) => (t += dt) >= seconds;
  };
const walk = (target: any, path: string): [any, string] => {
  const parts = path.split('.');
  const last = parts.pop() as string;
  let object = target;
  for (const part of parts) object = object?.[part];
  if (object === null || typeof object !== 'object') throw bad(`Property path ${path} does not lead to an object`);
  return [object, last];
};
/** Set `target[property]` (a dotted path such as `position.x` works) to `value`. */
export const setValue =
  <N = unknown>(target: object, property: string, value: unknown): Action<N> =>
  () => {
    const [object, key] = walk(target, property);
    object[key] = value;
  };
/** Add `by` (default 1) to the number at `target[property]`. */
export const increment =
  <N = unknown>(target: object, property: string, by = 1): Action<N> =>
  () => {
    const [object, key] = walk(target, property);
    object[key] += by;
  };
/** Move a number, or a numeric vector, at `target[property]` to `to` over `seconds`, easing with `ease` (default linear). The end value is set exactly. */
export const interpolate =
  <N = unknown>(
    target: object,
    property: string,
    to: number | ArrayLike<number>,
    seconds: number,
    ease: Ease = (t) => t,
  ): Action<N> =>
  () => {
    if (!(Number.isFinite(seconds) && seconds >= 0)) throw bad('interpolate needs seconds, 0 or more');
    const [object, key] = walk(target, property);
    const vector = typeof to !== 'number';
    const start: number[] = vector ? Array.from(object[key] as ArrayLike<number>) : [object[key]];
    const end: number[] = vector ? Array.from(to as ArrayLike<number>) : [to as number];
    if (start.length !== end.length) throw bad('interpolate needs a target of the same length as the property');
    let t = 0;
    const apply = (k: number) => {
      const at = (i: number) => (start[i] as number) + ((end[i] as number) - (start[i] as number)) * k;
      if (vector) for (let i = 0; i < end.length; i++) object[key][i] = at(i);
      else object[key] = at(0);
    };
    return (dt) => {
      t += dt;
      const done = t >= seconds;
      apply(done ? 1 : ease(t / seconds));
      return done;
    };
  };
/** Call `target.play(...args)`, for example an animation player. */
export const play =
  <N = unknown>(target: { play(...args: any[]): unknown }, ...args: unknown[]): Action<N> =>
  () => {
    target.play(...args);
  };
/** Call `target.stop()`. */
export const stop =
  <N = unknown>(target: { stop(): unknown }): Action<N> =>
  () => {
    target.stop();
  };
/** A condition comparing `target[property]` with `value`. */
export const when =
  <N = unknown>(
    target: object,
    property: string,
    op: '==' | '!=' | '<' | '<=' | '>' | '>=',
    value: unknown,
  ): Condition<N> =>
  () => {
    const [object, key] = walk(target, property);
    const v = object[key];
    const w = value as any;
    return op === '==' ? v === w : op === '!=' ? v !== w : op === '<' ? v < w : op === '<=' ? v <= w : op === '>' ? v > w : v >= w;
  };

/** A world-space axis-aligned box. */
export interface ActionBounds {
  min: ArrayLike<number>;
  max: ArrayLike<number>;
}
/** Settings of {@link ActionSystem}. */
export interface ActionSystemOptions<N> {
  /** The node under a canvas position (CSS pixels), or null. Pointer triggers need it; give a sync lookup such as a Raycaster hit's mesh. */
  pick?: (x: number, y: number) => N | null | undefined;
  /** World-space box of a node, for intersect triggers. */
  bounds?: (node: N) => ActionBounds | null | undefined;
  /** Seconds between two picks of one node that make a doublePick. Default 0.3. */
  doublePick?: number;
}
/** The pointer event fields used (a DOM PointerEvent fits when x and y are canvas CSS pixels). */
export interface PointerLike {
  x: number;
  y: number;
}
const overlap = (a: ActionBounds, b: ActionBounds) =>
  [0, 1, 2].every((i) => (a.min[i] as number) <= (b.max[i] as number) && (b.min[i] as number) <= (a.max[i] as number));
/**
 * Connects pointer, key and frame input to the ActionManagers of many nodes. Feed it `pointerDown`, `pointerUp`,
 * `pointerMove`, `keyDown`, `keyUp` and `update(dt)` once a frame; it works out pick, double pick, long pick, over/out
 * and intersect enter/exit and fires the matching registrations. Event names follow W3C Pointer Events.
 */
export class ActionSystem<N = unknown> {
  private readonly managers = new Map<N, ActionManager<N>>();
  private time = 0;
  private hovered: N | null = null;
  private downNode: N | null = null;
  private downAt = 0;
  private held = false;
  private lastPick: { node: N; at: number } | null = null;
  private disposed = false;
  constructor(private readonly options: ActionSystemOptions<N> = {}) {
    const { doublePick = 0.3 } = options;
    if (!(Number.isFinite(doublePick) && doublePick >= 0)) throw bad('ActionSystem doublePick is seconds, 0 or more');
  }
  /** The manager of `node`, created on first use. */
  manager(node: N): ActionManager<N> {
    if (this.disposed) throw fault('disposed', 'ActionSystem is disposed; create a new one', 'actions');
    let m = this.managers.get(node);
    if (!m) this.managers.set(node, (m = new ActionManager(node)));
    return m;
  }
  private at(p: PointerLike): N | null {
    if (!this.options.pick) throw bad('Pointer triggers need the pick option; pass (x, y) => node');
    return this.options.pick(p.x, p.y) ?? null;
  }
  /** Pointer pressed: fires pickDown and starts timing a long pick. */
  pointerDown(p: PointerLike): void {
    const node = this.at(p);
    this.downNode = node;
    this.downAt = this.time;
    this.held = false;
    const m = node === null ? undefined : this.managers.get(node);
    m?.rearm();
    m?.fire('pickDown', p);
  }
  /** Pointer released: fires pickUp, then pick (and doublePick) when over the pressed node and no long pick fired. */
  pointerUp(p: PointerLike): void {
    const node = this.at(p);
    const down = this.downNode;
    this.downNode = null;
    if (node === null) return;
    const m = this.managers.get(node);
    m?.fire('pickUp', p);
    if (node !== down || this.held) return;
    m?.fire('pick', p);
    const last = this.lastPick;
    if (last && last.node === node && this.time - last.at <= (this.options.doublePick ?? 0.3)) {
      m?.fire('doublePick', p);
      this.lastPick = null;
    } else this.lastPick = { node, at: this.time };
  }
  /** Pointer moved: fires pointerOut on the node it left and pointerOver on the one it entered. */
  pointerMove(p: PointerLike): void {
    const node = this.at(p);
    if (node === this.hovered) return;
    if (this.hovered !== null) this.managers.get(this.hovered)?.hover(false, p);
    this.hovered = node;
    if (node !== null) this.managers.get(node)?.hover(true, p);
  }
  /** The pointer left the canvas. */
  pointerLeave(): void {
    if (this.hovered !== null) this.managers.get(this.hovered)?.hover(false);
    this.hovered = null;
  }
  /** A key went down; repeats (`event.repeat`) are ignored. Fires keyDown on every manager whose key filter matches. */
  keyDown(event: { key: string; repeat?: boolean }): void {
    if (!event.repeat) for (const m of this.managers.values()) m.fire('keyDown', { key: event.key });
  }
  /** A key went up. */
  keyUp(event: { key: string }): void {
    for (const m of this.managers.values()) m.fire('keyUp', { key: event.key });
  }
  /** Once a frame: advances time, long presses, intersections, running chains and everyFrame. */
  update(dt: number): void {
    if (!(Number.isFinite(dt) && dt >= 0)) throw bad('update needs dt seconds, 0 or more');
    this.time += dt;
    if (this.downNode !== null && this.managers.get(this.downNode)?.hold(this.time - this.downAt)) this.held = true;
    const boxOf = this.options.bounds;
    if (boxOf) {
      const overlaps = (a: N, b: N) => {
        const x = boxOf(a);
        const y = boxOf(b);
        return !!x && !!y && overlap(x, y);
      };
      for (const m of this.managers.values()) if (m.watchesIntersections) m.intersect(overlaps);
    }
    for (const m of this.managers.values()) m.update(dt);
  }
  /** Dispose every manager. */
  dispose(): void {
    this.disposed = true;
    for (const m of this.managers.values()) m.dispose();
    this.managers.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

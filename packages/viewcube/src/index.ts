/// <reference lib="esnext.disposable" preserve="true" />
import type { Camera, EngineKernel, RenderView } from '@margoengine/core';
import type { FrameGraph } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';

/** One of the six cube faces. */
export type Face = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';
/** A named view (`iso` is top-front-right), or a direction from the target toward the camera such as `[1, 1, 0]`. */
export type View = Face | 'iso' | readonly [number, number, number];
/** Camera projection the toggle switches between. */
export type Projection = 'orthographic' | 'perspective';
/** A camera placement for the home view: where the camera is and the target it looks at. */
export interface HomeView {
  position: readonly number[];
  target: readonly number[];
}
/** Options for {@link ViewCube}; every field has a default. */
export interface ViewCubeOptions {
  /** Element the cube is placed in. Default: the canvas's parent. */
  container?: HTMLElement;
  /**
   * The engine view this cube belongs to: it turns that view's camera and sits in the corner of its rectangle (the
   * container must cover the canvas). Default the engine camera and the whole canvas.
   */
  view?: Pick<RenderView, 'camera' | 'viewport' | 'pixels'>;
  /** Corner of the view the cube sits in. Default 'top-right'. */
  corner?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  /** Cube edge in CSS pixels. Default 80. */
  size?: number;
  /** Seconds a click animates for. Default 0.4. */
  duration?: number;
  /** A `@margoengine/cameras` CameraProjection (anything with `mode`): shows a perspective/orthographic toggle.
   * Default: the CameraProjection already attached to the engine, if any. */
  projection?: { mode: Projection };
  /** Face names, for translation. */
  labels?: Partial<Record<Face, string>>;
  /** Clicking the view already shown turns to the opposite one (Blender, SolidWorks "Normal To" twice). Default false.
   * A `@margoengine/controls` profile carries it: `ViewCube.attach(engine, {...BLENDER.viewCube})`. */
  flip?: boolean;
  /** Dragging the cube orbits the camera around its target; a press that moves under 3 pixels is still a click.
   * Default true; also a public field. */
  drag?: boolean;
  /**
   * The app's home view: shows a home button, and the button and the Home key animate there (position, target and
   * distance). `true` takes the camera as it is when the cube attaches. Default none: Home goes to the isometric view.
   */
  home?: HomeView | boolean;
  /** Shows two roll buttons that turn the view 90 degrees about the view axis, counter-clockwise and clockwise. Default false. */
  roll?: boolean;
}
type V3 = [number, number, number];
/** Normal, then the face's right and up as seen from outside. Y up, front is +Z, right is +X. */
const FACES: Record<Face, [V3, V3, V3]> = {
  front: [
    [0, 0, 1],
    [1, 0, 0],
    [0, 1, 0],
  ],
  back: [
    [0, 0, -1],
    [-1, 0, 0],
    [0, 1, 0],
  ],
  right: [
    [1, 0, 0],
    [0, 0, -1],
    [0, 1, 0],
  ],
  left: [
    [-1, 0, 0],
    [0, 0, 1],
    [0, 1, 0],
  ],
  top: [
    [0, 1, 0],
    [1, 0, 0],
    [0, 0, -1],
  ],
  bottom: [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ],
};
/** Arrow-key step; polar angles within POLE of 0 or π land exactly on the pole. */
const STEP = Math.PI / 4,
  POLE = 1e-9;
const CSS = `.mvc{position:absolute;z-index:1;touch-action:none;user-select:none;-webkit-user-select:none;font:600 11px system-ui,sans-serif}
.mvc-cube{position:absolute;inset:0;transform-style:preserve-3d;pointer-events:none}
.mvc-face{position:absolute;inset:0;display:grid;grid-template:20% 60% 20%/20% 60% 20%;backface-visibility:hidden;-webkit-backface-visibility:hidden;pointer-events:auto;box-sizing:border-box;border:1px solid #868d98;background:rgba(236,238,242,.92);color:#262a31}
.mvc-face>*{border:0;margin:0;padding:0;background:none;color:inherit;font:inherit;text-transform:uppercase;cursor:pointer;outline:none}
.mvc-face>:hover,.mvc-face>:focus-visible{background:rgba(52,128,246,.45)}
.mvc button:focus-visible{box-shadow:inset 0 0 0 2px #1a63d6}
.mvc-home,.mvc-roll{position:absolute;top:-26px;width:20px;height:20px;padding:0;border:1px solid #868d98;border-radius:50%;background:rgba(236,238,242,.92);color:#262a31;font:14px/1 system-ui,sans-serif;cursor:pointer}
.mvc-home{left:0;font-size:15px}
.mvc-projection{position:absolute;left:0;right:0;bottom:-26px;height:22px;border:1px solid #868d98;border-radius:4px;background:rgba(236,238,242,.92);color:#262a31;font:inherit;cursor:pointer}`;

/** Spherical angles of a direction: azimuth about +Y from +Z (0 when vertical, so top and bottom keep -Z and +Z up), polar from +Y. */
const angles = (d: readonly number[]): [number, number] => {
  const l = Math.hypot(d[0], d[1], d[2]),
    h = Math.hypot(d[0], d[2]);
  return [h > 1e-9 * l ? Math.atan2(d[0], d[2]) : 0, Math.acos(Math.max(-1, Math.min(1, d[1] / l)))];
};
/** "Top Front Right" for [1, 1, 1]. */
const describe = (d: readonly number[], labels: Record<Face, string>): string =>
  [
    d[1] > 0 ? labels.top : d[1] < 0 ? labels.bottom : '',
    d[2] > 0 ? labels.front : d[2] < 0 ? labels.back : '',
    d[0] > 0 ? labels.right : d[0] < 0 ? labels.left : '',
  ]
    .filter(Boolean)
    .join(' ');
/** Writes v turned by angle a about the direction d (Rodrigues' rotation formula) into out. */
const rotate = (out: number[], v: readonly number[], d: readonly number[], a: number): void => {
  const l = Math.hypot(d[0], d[1], d[2]),
    x = d[0] / l,
    y = d[1] / l,
    z = d[2] / l,
    c = Math.cos(a),
    s = Math.sin(a),
    k = (x * v[0] + y * v[1] + z * v[2]) * (1 - c);
  out[0] = v[0] * c + (y * v[2] - z * v[1]) * s + x * k;
  out[1] = v[1] * c + (z * v[0] - x * v[2]) * s + y * k;
  out[2] = v[2] * c + (x * v[1] - y * v[0]) * s + z * k;
};
const css = (m: readonly number[]): string => `matrix3d(${m.map((v) => +v.toFixed(6)).join(',')})`;
let count = 0;

/**
 * A CAD orientation cube in a corner of the view (Autodesk-style ViewCube). It turns with the camera; a click on a face,
 * edge or corner animates the camera around its target to that view, keeping the distance. Keyboard: the six faces are
 * buttons; arrow keys step the view 45°, Home goes to the home view (isometric without one). Works with the stage's CADCameraControls and
 * `@margoengine/controls` OrbitControls (they read the camera each frame), and toggles a `@margoengine/cameras` projection.
 */
export class ViewCube {
  /** The widget root; style or move it as you like. */
  readonly element: HTMLDivElement;
  readonly camera: Camera;
  duration: number;
  /** See ViewCubeOptions.flip. */
  flip: boolean;
  /** See ViewCubeOptions.drag. */
  drag: boolean;
  readonly name = 'margoengine-viewcube:' + count++;
  private readonly cube: HTMLDivElement;
  private readonly buttons: [HTMLElement, V3][] = [];
  private readonly toggle?: HTMLButtonElement;
  private readonly projection?: { mode: Projection };
  private readonly container: HTMLElement;
  private readonly position: string;
  private animation?: {
    theta: number;
    phi: number;
    dTheta: number;
    dPhi: number;
    radius: number;
    dRadius: number;
    from: V3;
    to?: V3;
    twist: number;
    dTwist: number;
    elapsed: number;
    duration: number;
    at?: readonly number[];
  };
  private homeView?: { position: V3; target: V3 };
  private homeButton?: HTMLButtonElement;
  /** Moves a top-corner cube down to make room for the button row above it. */
  private readonly lift: () => void;
  private last = '';
  private disposed = false;
  private upSet?: V3;
  private upPrev?: Camera['up'];
  /** Counter-clockwise roll of the image in radians, and the azimuth of the up the cube set on a pole. */
  private twist = 0;
  private az = 0;
  /** The press being dragged: pointer, where it went down, the camera's angles then, radians per CSS pixel. */
  private grab?: { id: number; x: number; y: number; theta: number; phi: number };
  private dragged = false;
  private readonly speed: number;

  /** Creates the ViewCube on `engine` (preferred over the constructor). */
  static attach(engine: EngineKernel, options?: ViewCubeOptions): ViewCube {
    return new ViewCube(engine, options);
  }
  constructor(
    readonly engine: EngineKernel,
    {
      container = engine.canvas.parentElement!,
      corner = 'top-right',
      size = 80,
      duration = 0.4,
      projection,
      labels = {},
      flip = false,
      drag = true,
      home,
      roll = false,
      view,
    }: ViewCubeOptions = {},
  ) {
    if (!container) throw new TypeError('ViewCube needs a container; pass options.container');
    if (!(size > 0) || !(duration >= 0)) throw new RangeError('Invalid size or duration; use size > 0, duration >= 0');
    // A CameraProjection already attached to the engine is found by its plugin name.
    const found = (engine as unknown as { plugins?: ReadonlyMap<string, { mode?: Projection }> }).plugins?.get(
      'cameras',
    );
    projection ??= found?.mode ? (found as { mode: Projection }) : undefined;
    this.camera = view?.camera ?? engine.camera;
    this.duration = duration;
    this.flip = flip;
    this.drag = drag;
    // The cube's surface follows the pointer: a drag of half the cube's width turns it one radian.
    this.speed = 2 / size;
    this.projection = projection;
    this.container = container;
    const names: Record<Face, string> = {
      top: 'Top',
      bottom: 'Bottom',
      front: 'Front',
      back: 'Back',
      left: 'Left',
      right: 'Right',
      ...labels,
    };
    const doc = container.ownerDocument,
      el = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, className?: string) => {
        const e = doc.createElement(tag);
        if (className) e.className = className;
        parent.appendChild(e);
        return e;
      };
    const root = (this.element = el('div', container, 'mvc'));
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'View cube');
    const [v, h] = corner.split('-');
    // Distance of each canvas edge to the view's edge, as a share of the canvas.
    const [x, y, w, hh] = view?.viewport ?? [0, 0, 1, 1],
      [sx, sy] = view?.pixels ? [engine.canvas.width, engine.canvas.height] : [1, 1],
      edge = { left: x / sx, top: y / sy, right: 1 - (x + w) / sx, bottom: 1 - (y + hh) / sy },
      at = (side: string, px: number) => (view ? `calc(${edge[side as 'top'] * 100}% + ${px}px)` : px + 'px');
    // The projection toggle sits below the cube and the home and roll buttons in a row above it.
    root.style[v as 'top'] = at(v, v === 'bottom' && projection ? 38 : 12);
    this.lift = () => void (v === 'top' && (root.style.top = at(v, 38)));
    root.style[h as 'left'] = at(h, 12);
    root.style.width = root.style.height = size + 'px';
    el('style', root).textContent = CSS;
    this.cube = el('div', root, 'mvc-cube');
    for (const face of Object.keys(FACES) as Face[]) {
      const [n, u, w] = FACES[face],
        f = el('div', this.cube, 'mvc-face'),
        k = size / 2;
      // Element x to the face's right, element y (down) to its down, z outward, pushed out by half the cube.
      f.style.transform = css([...u, 0, ...w.map((x) => -x), 0, ...n, 0, ...n.map((x) => x * k), 1]);
      for (let i = 0; i < 9; i++) {
        const row = 1 - Math.floor(i / 3),
          col = (i % 3) - 1,
          d = n.map((x, a) => x + col * u[a] + row * w[a]) as V3,
          label = describe(d, names),
          center = i === 4;
        const cell = el(center ? 'button' : 'div', f);
        cell.dataset.view = d.join();
        cell.title = label;
        if (center) {
          (cell as HTMLButtonElement).type = 'button';
          this.buttons.push([cell, n]);
          cell.textContent = names[face];
          cell.setAttribute('aria-label', label + ' view');
        } else cell.setAttribute('aria-hidden', 'true');
      }
    }
    if (projection) {
      const t = (this.toggle = el('button', root, 'mvc-projection'));
      t.type = 'button';
      t.dataset.projection = '';
      t.setAttribute('aria-label', 'Orthographic projection');
      this.showProjection();
    }
    if (home) this.setHome(home === true ? undefined : home);
    if (roll) {
      this.lift();
      for (const [turns, glyph, name, right] of [
        [1, '\u21b6', 'Roll the view counter-clockwise', 22],
        [-1, '\u21b7', 'Roll the view clockwise', 0],
      ] as const) {
        const b = el('button', root, 'mvc-roll');
        b.type = 'button';
        b.dataset.roll = String(turns);
        b.title = name;
        b.setAttribute('aria-label', name);
        b.textContent = glyph;
        b.style.right = right + 'px';
      }
    }
    root.addEventListener('click', this.onClick);
    root.addEventListener('keydown', this.onKey);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
      root.addEventListener(type, this.onPointer as EventListener);
    // Absolute placement needs a positioned container; restored on dispose.
    this.position = container.style.position;
    if (!this.position && doc.defaultView?.getComputedStyle(container).position === 'static')
      container.style.position = 'relative';
    engine.use({
      name: this.name,
      setup() {},
      onPreUpdate: (delta: number) => this.update(delta),
      // After every control has moved the camera, so the cube never lags a frame.
      registerPasses: (graph: FrameGraph) => {
        graph.add({ name: this.name + ':sync', order: 10000, execute: () => this.sync() });
      },
      dispose: () => this.dispose(),
    } as Parameters<EngineKernel['use']>[0]);
    this.sync();
  }

  /** Animates to a view (`duration` 0 jumps). The target and distance stay; vertical views keep -Z (top) or +Z (bottom) up. */
  view(view: View, duration = this.duration): void {
    const d = typeof view === 'string' ? (view === 'iso' ? [1, 1, 1] : FACES[view]?.[0]) : view;
    if (!d || d.length !== 3 || !d.every(Number.isFinite) || !Math.hypot(...d))
      throw new RangeError("Invalid view; use a face, 'iso' or [x, y, z]");
    this.orbit(...angles(d), duration);
  }
  /** Sets the home view (default: the camera as it is now) and shows the home button. */
  setHome(home: HomeView = this.camera): void {
    const position = [...home.position] as V3,
      target = [...home.target] as V3;
    if (
      position.length !== 3 ||
      target.length !== 3 ||
      ![...position, ...target].every(Number.isFinite) ||
      !Math.hypot(...position.map((x, i) => x - target[i]))
    )
      throw new RangeError('Invalid home; use a position and a target apart, three finite numbers each');
    this.homeView = { position, target };
    if (this.homeButton) return;
    const b = (this.homeButton = this.element.ownerDocument.createElement('button'));
    b.type = 'button';
    b.className = 'mvc-home';
    b.dataset.home = '';
    b.title = 'Home';
    b.setAttribute('aria-label', 'Home view');
    b.textContent = '⌂';
    this.element.appendChild(b);
    this.lift();
  }
  /** A copy of the home view, or undefined before one is set. */
  getHome(): HomeView | undefined {
    const h = this.homeView;
    return h && { position: [...h.position], target: [...h.target] };
  }
  /** Animates to the home view: its position, target and distance (`duration` 0 jumps). Without one, the isometric view. */
  home(duration = this.duration): void {
    const h = this.homeView;
    if (!h) return this.view('iso', duration);
    const d = h.position.map((x, i) => x - h.target[i]);
    this.orbit(...angles(d), duration, h.target, Math.hypot(...d));
  }
  /**
   * Rolls the view about its axis by quarter turns, counter-clockwise on screen for positive `turns` (default 1), keeping
   * the position and target. The cube keeps the roll while other controls orbit; a view change from the cube (a face,
   * edge or corner, the arrow keys, Home) turns the view upright again.
   */
  roll(turns = 1, duration = this.duration): void {
    if (!Number.isFinite(turns)) throw new RangeError('Invalid roll; use a number of quarter turns');
    this.orbit(...this.current(), duration, undefined, undefined, this.twist + (turns * Math.PI) / 2);
  }
  /** Quarter turns the view is rolled counter-clockwise: 0 to 3 at rest, fractional while a roll animates. */
  get turns(): number {
    return this.twist / (Math.PI / 2);
  }
  /** Current projection mode, or undefined without a projection. */
  getProjection(): Projection | undefined {
    return this.projection?.mode;
  }
  setProjection(mode: Projection): void {
    if (!this.projection) throw new MargoError('state', 'ViewCube has no projection; pass options.projection');
    if (mode !== 'orthographic' && mode !== 'perspective')
      throw new RangeError("Invalid projection; use 'orthographic' or 'perspective'");
    this.projection.mode = mode;
    this.showProjection();
  }
  /** Advances the animation; the engine calls it before each frame. */
  update(delta: number): void {
    const a = this.animation,
      c = this.camera;
    // Another control moved the camera: it wins.
    if (!a || (a.at && Math.hypot(...c.position.map((x, i) => x - a.at![i])) > 1e-6 * a.radius)) {
      this.animation = undefined;
      this.pole();
      return;
    }
    const t = a.duration ? Math.min(1, (a.elapsed += Math.max(0, delta)) / a.duration) : 1,
      s = t * t * (3 - 2 * t),
      theta = a.theta + a.dTheta * s;
    // A roll ends on a whole quarter turn, 0 to 3, so the upright view is exactly the unrolled one.
    this.twist =
      t === 1
        ? (((Math.round((a.twist + a.dTwist) / (Math.PI / 2)) % 4) + 4) % 4) * (Math.PI / 2)
        : a.twist + a.dTwist * s;
    // Home moves the target too; the last step lands on it exactly.
    if (a.to) c.target = a.from.map((x, i) => (t === 1 ? a.to![i] : x + (a.to![i] - x) * s)) as V3;
    a.at = this.place(theta, a.phi + a.dPhi * s, t === 1 ? a.radius + a.dRadius : a.radius + a.dRadius * s);
    this.pole(theta);
    if (t === 1) this.animation = undefined;
  }
  /** True while a view change is animating. */
  get animating(): boolean {
    return !!this.animation;
  }
  /** Turns the cube to the camera; called after each frame's updates. */
  sync(): void {
    if (this.disposed) return;
    // The projection may be toggled elsewhere (a controls profile key such as Blender's numpad 5).
    if (this.toggle && this.toggle.getAttribute('aria-pressed') !== String(this.projection!.mode === 'orthographic'))
      this.showProjection();
    const c = this.camera,
      z = c.position.map((x, i) => x - c.target[i]),
      l = Math.hypot(...z);
    if (!l) return;
    // Core's view rotation: right = up x back, then up' = back x right (camera.up is +Y unless an app changed it).
    const [zx, zy, zz] = z.map((x) => x / l),
      u = c.up ?? [0, 1, 0],
      r = [u[1] * zz - u[2] * zy, u[2] * zx - u[0] * zz, u[0] * zy - u[1] * zx],
      s = Math.hypot(...r);
    const [xx, xy, xz] = s ? r.map((x) => x / s) : [1, 0, 0],
      yx = zy * xz - zz * xy,
      yy = zz * xx - zx * xz,
      yz = zx * xy - zy * xx;
    // Rows (right, up, back) with y flipped for CSS: the columns are the images of world X, Y and Z.
    const m = css([xx, -yx, zx, 0, xy, -yy, zy, 0, xz, -yz, zz, 0, 0, 0, 0, 1]);
    if (m === this.last) return;
    this.cube.style.transform = this.last = m;
    // Only faces turned toward the viewer take keyboard focus (screen readers still reach all six).
    for (const [button, n] of this.buttons) button.tabIndex = n[0] * zx + n[1] * zy + n[2] * zz > 0.05 ? 0 : -1;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.animation = undefined;
    // Give back the up it set; a vertical camera moves 1e-6 rad off the pole (same image) so core accepts that up.
    const c = this.camera;
    if (this.upSet && c.up === this.upSet) {
      const [theta, phi] = this.current(),
        d = c.position.map((x, i) => x - c.target[i]);
      c.up = this.upPrev!;
      if (!d[0] && !d[2]) this.place(theta, phi ? Math.PI - 1e-6 : 1e-6, Math.hypot(...d));
    }
    this.element.removeEventListener('click', this.onClick);
    this.element.removeEventListener('keydown', this.onKey);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
      this.element.removeEventListener(type, this.onPointer as EventListener);
    this.grab = undefined;
    this.element.remove();
    this.container.style.position = this.position;
    if (!this.engine.disposed && this.engine.hasPlugin(this.name)) this.engine.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  /** Moves the camera to azimuth theta and polar angle phi around the target; near the poles exactly onto them. */
  private place(theta: number, phi: number, r: number): V3 {
    const p = this.camera.target,
      pole = phi < POLE ? 1 : phi > Math.PI - POLE ? -1 : 0;
    return (this.camera.position = pole
      ? [p[0], p[1] + pole * r, p[2]]
      : [
          p[0] + r * Math.sin(phi) * Math.sin(theta),
          p[1] + r * Math.cos(phi),
          p[2] + r * Math.sin(phi) * Math.cos(theta),
        ]);
  }
  /**
   * Core rejects an up parallel to the view. On an exactly vertical view the cube sets camera.up to the screen up the
   * view had on its way to the pole (azimuth theta), and puts the previous up back once the camera leaves the pole. An up
   * it did not set that already works (a CameraProjection's vertical up) is left alone. A roll turns that up about the
   * view axis, again every frame, so the roll holds while other controls orbit. An up set by someone else wins and ends
   * the roll.
   */
  private pole(theta?: number): void {
    const c = this.camera,
      d = c.position.map((x, i) => x - c.target[i]);
    if (this.upSet && c.up !== this.upSet) {
      this.upSet = undefined;
      this.twist = 0;
    }
    const app = this.upSet ? this.upPrev! : c.up;
    let n: readonly number[] = app;
    if (!d[0] && !d[2] && d[1]) {
      if (theta === undefined) return;
      const k = Math.sign(d[1]);
      if (this.upSet || !Math.hypot(app[0], app[2])) {
        n = [-k * Math.sin(theta), 0, -k * Math.cos(theta)];
        this.az = theta;
      } else this.az = Math.atan2(-k * app[0], -k * app[2]);
    }
    if (n === app && !this.twist) {
      if (this.upSet) {
        c.up = app;
        this.upSet = undefined;
      }
      return;
    }
    if (!this.upSet) {
      this.upPrev = c.up;
      c.up = this.upSet = [0, 0, 0];
    }
    rotate(this.upSet, n, d, -this.twist);
  }
  /** Azimuth and polar angle of the camera; on the pole the azimuth of the up the cube set, else of camera.up (the screen up). */
  private current(): [number, number] {
    const c = this.camera,
      d = c.position.map((x, i) => x - c.target[i]),
      u = c.up,
      a = angles(d);
    if (!d[0] && !d[2] && d[1])
      if (this.upSet && u === this.upSet) a[0] = this.az;
      else if (Math.hypot(u[0], u[2])) a[0] = d[1] > 0 ? Math.atan2(-u[0], -u[2]) : Math.atan2(u[0], u[2]);
    return a;
  }
  /** Animates the azimuth and polar angle around the target; home also moves the target to `to` and the distance to `radius`. */
  private orbit(
    theta: number,
    phi: number,
    duration: number,
    to?: readonly number[],
    radius?: number,
    twist = 0,
  ): void {
    const c = this.camera,
      r = Math.hypot(...c.position.map((x, i) => x - c.target[i])),
      [t0, p0] = this.current();
    c.cancelFit?.();
    this.animation = {
      theta: t0,
      phi: p0,
      dTheta: ((((theta - t0) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI,
      dPhi: phi - p0,
      radius: r,
      dRadius: (radius ?? r) - r,
      from: [...c.target] as V3,
      to: to && ([...to] as V3),
      twist: this.twist,
      dTwist: twist - this.twist,
      elapsed: 0,
      duration,
    };
    if (!duration) this.update(0);
  }
  private showProjection(): void {
    const t = this.toggle!,
      ortho = this.projection!.mode === 'orthographic';
    t.textContent = ortho ? 'Ortho' : 'Persp';
    t.setAttribute('aria-pressed', String(ortho));
  }
  private readonly onClick = (event: Event): void => {
    const target = (event.target as HTMLElement | null)?.closest?.(
      '[data-view],[data-projection],[data-home],[data-roll]',
    ) as HTMLElement | null;
    // The click that ends a drag is not a click on a face.
    if (this.dragged) return void (this.dragged = false);
    if (!target) return;
    if (target.dataset.view) {
      const d = target.dataset.view.split(',').map(Number) as V3,
        c = this.camera,
        o = c.position.map((x, i) => x - c.target[i]);
      // flip: already looking from d (and not mid-animation) turns to -d.
      const same =
        this.flip &&
        !this.animation &&
        (o[0] * d[0] + o[1] * d[1] + o[2] * d[2]) / Math.hypot(...o) / Math.hypot(...d) > 1 - 1e-9;
      this.view(same ? (d.map((x) => -x) as V3) : d);
    } else if (target.dataset.home !== undefined) this.home();
    else if (target.dataset.roll) this.roll(+target.dataset.roll);
    else this.setProjection(this.projection!.mode === 'orthographic' ? 'perspective' : 'orthographic');
  };
  /**
   * Drag to orbit: turntable angles as OrbitControls moves them, so dragging right turns the cube's front to the right
   * (the camera goes left) and dragging down tips the top toward the viewer, up to the poles.
   */
  private readonly onPointer = (event: PointerEvent): void => {
    const g = this.grab,
      c = this.camera;
    if (event.type === 'pointerdown') {
      this.dragged = false;
      // Only the cube's own cells start a drag, not the buttons beside it.
      if (this.drag && !event.button && (event.target as HTMLElement).dataset?.view !== undefined) {
        const [theta, phi] = this.current();
        this.grab = { id: event.pointerId, x: event.clientX, y: event.clientY, theta, phi };
      }
      return;
    }
    if (!g || event.pointerId !== g.id) return;
    if (event.type !== 'pointermove') {
      this.grab = undefined;
      return;
    }
    // On a rolled view the drag turns back by the roll, so the cube still follows the pointer on screen.
    const ex = event.clientX - g.x,
      ey = event.clientY - g.y,
      cs = Math.cos(this.twist),
      sn = Math.sin(this.twist),
      dx = ex * cs - ey * sn,
      dy = ex * sn + ey * cs;
    if (!this.dragged) {
      if (Math.hypot(ex, ey) < 3) return;
      this.dragged = true;
      this.animation = undefined;
      c.cancelFit?.();
      // Keeps the drag when the pointer leaves the cube; synthetic events have no pointer to capture.
      try {
        this.element.setPointerCapture(g.id);
      } catch {}
    }
    const theta = g.theta - dx * this.speed;
    this.place(
      theta,
      Math.min(Math.PI, Math.max(0, g.phi - dy * this.speed)),
      Math.hypot(...c.position.map((x, i) => x - c.target[i])),
    );
    this.pole(theta);
    event.preventDefault();
  };
  private readonly onKey = (event: KeyboardEvent): void => {
    this.dragged = false;
    const [theta, phi] = this.current(),
      snap = (x: number) => Math.round(x / STEP) * STEP;
    switch (event.key) {
      case 'ArrowLeft':
        this.orbit(snap(theta) - STEP, phi, this.duration);
        break;
      case 'ArrowRight':
        this.orbit(snap(theta) + STEP, phi, this.duration);
        break;
      case 'ArrowUp':
        this.orbit(theta, Math.max(0, snap(phi) - STEP), this.duration);
        break;
      case 'ArrowDown':
        this.orbit(theta, Math.min(Math.PI, snap(phi) + STEP), this.duration);
        break;
      case 'Home':
        this.home();
        break;
      default:
        return;
    }
    event.preventDefault();
  };
}

import type { FrameGraph } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { ViewCube } from './index.js';

// The package's protected navigation hooks permit a companion widget without widening the root API.
class CompassNavigation extends ViewCube {
  static localOf(cube: CompassNavigation, direction: readonly number[]): readonly number[] {
    return cube.local(direction);
  }
  static turn(cube: CompassNavigation, theta: number, phi: number, twist: number): void {
    // A manual compass drag retains distance and target even on a FitViewCube.
    CompassNavigation.prototype.orbit.call(cube, theta, phi, 0, undefined, undefined, twist);
  }
}

/** Cardinal direction in the cube's horizontal plane. */
export type Cardinal = 'north' | 'east' | 'south' | 'west';
/** Optional compass and menu configuration. */
export interface ViewCompassOptions {
  /** North heading in radians, clockwise from widget -front toward right. Default 0. */
  north?: number;
  /** Display the ring initially. Default true. */
  visible?: boolean;
  /** Add right-click and Shift+F10/ContextMenu access. Default true. */
  menu?: boolean;
  /** Fit action. Default calls cube.fit() when available; otherwise the menu item is disabled. */
  fit?: () => void;
  /** Short cardinal labels. Default N, E, S, W. Accessible names remain full direction names. */
  labels?: Partial<Record<Cardinal, string>>;
}
const instances = new WeakMap<ViewCube, ViewCompass>();
const directions: Cardinal[] = ['north', 'east', 'south', 'west'];
const CSS = `.mvc-compass{position:absolute;left:-8px;right:-8px;top:calc(100% + 32px);height:36px;pointer-events:none}
.mvc-compass-track{position:absolute;inset:0;border:1px solid var(--mvc-line);border-radius:50%;box-sizing:border-box}
.mvc-compass button{position:absolute;transform:translate(-50%,-50%);width:22px;height:22px;border:1px solid var(--mvc-line);border-radius:50%;padding:0;pointer-events:auto;background:var(--mvc-background);color:var(--mvc-text);font:600 10px system-ui;cursor:pointer}
.mvc-compass button:hover,.mvc-compass button:focus-visible{background:var(--mvc-hover);color:var(--mvc-hover-text)}
.mvc:has(>.mvc-compass)>.mvc-projection{bottom:-110px}
.mvc-menu{position:fixed;z-index:10000;min-width:180px;max-width:calc(100vw - 8px);padding:4px;border:1px solid var(--mvc-line);border-radius:5px;background:var(--mvc-background);color:var(--mvc-text);font:12px system-ui;box-sizing:border-box}
.mvc-menu button{display:block;width:100%;padding:6px 10px;text-align:left;border:0;background:none;color:inherit;font:inherit;cursor:pointer}
.mvc-menu button:hover,.mvc-menu button:focus-visible{background:var(--mvc-hover);color:var(--mvc-hover-text);outline:2px solid var(--mvc-focus);outline-offset:-2px}
.mvc-menu button:disabled{opacity:.5;cursor:default}
.mvc-menu [aria-checked=true]::before{content:'\u2713 ';}
.mvc-menu[hidden],.mvc-compass[hidden]{display:none}`;

/** A DOM compass ring and accessible context menu for any ViewCube, including /up and /fit. */
export class ViewCompass {
  /** Ring root; hidden by the visible property. */
  readonly element: HTMLDivElement;
  /** Context menu root, or undefined with menu:false. */
  readonly menu?: HTMLDivElement;
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly items: HTMLButtonElement[] = [];
  private readonly name: string;
  private readonly previousDispose: ViewCube['dispose'];
  private readonly disposeCube: () => void;
  private readonly margins: string[];
  private readonly off: (() => void)[] = [];
  private readonly fitAction?: () => void;
  private restoreFocus?: HTMLElement;
  private disposed = false;
  private heading = 0;
  private angle: number;
  private grab?: { id: number; x: number; y: number; theta: number; phi: number; twist: number; button: HTMLElement };
  private dragged = false;

  /** Attaches one compass to an existing cube; disposing either cleans up the compass. */
  static attach(cube: ViewCube, options?: ViewCompassOptions): ViewCompass {
    return new ViewCompass(cube, options);
  }
  constructor(
    readonly cube: ViewCube,
    options: ViewCompassOptions = {},
  ) {
    if (instances.has(cube))
      throw new MargoError('attached', 'Cube already has a compass; dispose it before attaching another');
    if (!cube.element.parentElement || cube.engine.disposed)
      throw new MargoError('disposed', 'Cube is disposed; create a new cube before attaching a compass');
    const north = options.north ?? 0;
    if (!Number.isFinite(north)) throw new RangeError('Invalid north; use a finite angle in radians');
    this.angle = north;
    this.name = cube.name + ':compass';
    const doc = cube.element.ownerDocument,
      make = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, className = '') => {
        const e = doc.createElement(tag);
        e.className = className;
        parent.appendChild(e);
        return e;
      };
    this.element = make('div', cube.element, 'mvc-compass');
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', 'Compass');
    make('style', this.element).textContent = CSS;
    make('div', this.element, 'mvc-compass-track').setAttribute('aria-hidden', 'true');
    directions.forEach((direction, index) => {
      const b = make('button', this.element);
      b.type = 'button';
      b.textContent = options.labels?.[direction] ?? direction[0].toUpperCase();
      b.setAttribute('aria-label', direction[0].toUpperCase() + direction.slice(1) + ' view');
      this.listen(b, 'click', () => {
        if (this.dragged) {
          this.dragged = false;
          return;
        }
        cube.view(this.direction(index));
      });
      this.buttons.push(b);
    });
    this.visible = options.visible ?? true;
    this.margins = [cube.element.style.marginLeft, cube.element.style.marginRight, cube.element.style.marginBottom];
    cube.element.style.marginLeft = `calc(${this.margins[0] || '0px'} + 16px)`;
    cube.element.style.marginRight = `calc(${this.margins[1] || '0px'} + 16px)`;
    cube.element.style.marginBottom = `calc(${this.margins[2] || '0px'} + 110px)`;
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
      this.listen(this.element, type, (e) => this.pointer(e as PointerEvent));
    const fitter = cube as ViewCube & { fit?: () => void };
    this.fitAction = options.fit ?? (typeof fitter.fit === 'function' ? () => fitter.fit!() : undefined);
    if (options.menu !== false) {
      this.menu = make('div', doc.body, 'mvc-menu');
      this.menu.hidden = true;
      this.menu.setAttribute('role', 'menu');
      this.menu.setAttribute('aria-label', 'View cube actions');
      const row = (label: string, action: () => void, role = 'menuitem') => {
        const b = make('button', this.menu!);
        b.type = 'button';
        b.textContent = label;
        b.tabIndex = -1;
        b.setAttribute('role', role);
        this.listen(b, 'click', () => {
          this.closeMenu();
          action();
        });
        this.items.push(b);
      };
      row('Home view', () => cube.home());
      row('Set current view as Home', () => cube.setHome());
      row('Fit to view', () => this.fitAction?.());
      row('Perspective', () => cube.setProjection('perspective'), 'menuitemradio');
      row('Orthographic', () => cube.setProjection('orthographic'), 'menuitemradio');
      row(
        'Show compass',
        () => {
          this.visible = !this.visible;
        },
        'menuitemcheckbox',
      );
      this.listen(cube.element, 'contextmenu', (event) => {
        const e = event as MouseEvent;
        e.preventDefault();
        this.openMenu(e.clientX, e.clientY);
      });
      this.listen(cube.element, 'keydown', (event) => {
        const e = event as KeyboardEvent;
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const r = cube.element.getBoundingClientRect();
          this.openMenu(r.left, r.bottom);
        }
      });
      this.listen(this.menu, 'keydown', (event) => this.menuKey(event as KeyboardEvent));
      this.listen(doc, 'pointerdown', (event) => {
        if (!this.menu!.contains(event.target as Node)) this.closeMenu(false);
      });
      this.listen(doc.defaultView!, 'resize', () => this.closeMenu(false));
      this.listen(doc, 'scroll', () => this.closeMenu(false), true);
    }
    this.previousDispose = cube.dispose;
    this.disposeCube = () => {
      this.dispose();
      this.previousDispose.call(cube);
    };
    cube.dispose = this.disposeCube;
    instances.set(cube, this);
    cube.engine.use({
      name: this.name,
      setup() {},
      registerPasses: (graph: FrameGraph) => {
        graph.add({ name: this.name, order: 10001, execute: () => this.sync() });
      },
      dispose: () => this.dispose(),
    } as Parameters<ViewCube['engine']['use']>[0]);
    this.sync();
  }
  /** North heading in radians. Updating it changes both labels and click directions. */
  get north(): number {
    return this.angle;
  }
  set north(angle: number) {
    if (!Number.isFinite(angle)) throw new RangeError('Invalid north; use a finite angle in radians');
    this.angle = angle;
    this.sync();
  }
  /** Whether the compass ring is shown. Default true. */
  get visible(): boolean {
    return !this.element.hidden;
  }
  set visible(value: boolean) {
    this.element.hidden = !value;
  }
  private direction(index: number): [number, number, number] {
    const a = this.angle + (index * Math.PI) / 2;
    return [Math.sin(a), 0, -Math.cos(a)];
  }
  /** Updates the ring heading after the cube's camera sync; the engine calls it each frame. */
  sync(): void {
    if (this.disposed) return;
    const c = this.cube.camera,
      d = CompassNavigation.localOf(
        this.cube,
        c.position.map((v, i) => v - c.target[i]),
      );
    if (Math.hypot(d[0], d[2]) > 1e-9 * Math.hypot(...d)) this.heading = Math.atan2(d[0], d[2]);
    else {
      const u = CompassNavigation.localOf(this.cube, c.up),
        k = Math.sign(d[1]);
      this.heading = Math.atan2(-k * u[0], -k * u[2]);
    }
    const half = (parseFloat(this.cube.element.style.width) + 16) / 2;
    this.buttons.forEach((b, i) => {
      const d = this.direction(i),
        x = (d[0] * Math.cos(this.heading) - d[2] * Math.sin(this.heading)) * half,
        y = (d[0] * Math.sin(this.heading) + d[2] * Math.cos(this.heading)) * 18;
      b.style.left = `calc(50% + ${x}px)`;
      b.style.top = `${18 + y}px`;
    });
  }
  /** Opens the context menu at viewport CSS coordinates, clamped to the viewport. */
  openMenu(x: number, y: number): void {
    if (!this.menu || this.disposed) return;
    if (![x, y].every(Number.isFinite)) throw new RangeError('Invalid menu point; use finite viewport coordinates');
    const doc = this.menu.ownerDocument,
      win = doc.defaultView!;
    this.restoreFocus = this.cube.element.contains(doc.activeElement)
      ? (doc.activeElement as HTMLElement)
      : (this.cube.element.querySelector('button[tabindex="0"]') ?? this.buttons[0]);
    this.items[2].disabled = !this.fitAction;
    const mode = this.cube.getProjection();
    for (const i of [3, 4]) {
      this.items[i].disabled = !mode;
      this.items[i].setAttribute('aria-checked', String(mode === (i === 3 ? 'perspective' : 'orthographic')));
    }
    this.items[5].setAttribute('aria-checked', String(this.visible));
    const style = win.getComputedStyle(this.cube.element);
    for (const token of ['background', 'text', 'line', 'hover', 'hover-text', 'focus'])
      this.menu.style.setProperty('--mvc-' + token, style.getPropertyValue('--mvc-' + token));
    this.menu.hidden = false;
    const r = this.menu.getBoundingClientRect();
    this.menu.style.left = Math.max(4, Math.min(x, win.innerWidth - r.width - 4)) + 'px';
    this.menu.style.top = Math.max(4, Math.min(y, win.innerHeight - r.height - 4)) + 'px';
    this.items[0].focus();
  }
  /** Hides the menu and, by default, restores the previously focused widget control. */
  closeMenu(restore = true): void {
    if (!this.menu || this.menu.hidden) return;
    this.menu.hidden = true;
    if (restore) this.restoreFocus?.focus();
  }
  private menuKey(e: KeyboardEvent): void {
    const enabled = this.items.filter((b) => !b.disabled),
      at = enabled.indexOf(this.menu!.ownerDocument.activeElement as HTMLButtonElement);
    if (e.key === 'Escape' || e.key === 'Tab') {
      this.closeMenu();
      if (e.key === 'Escape') e.preventDefault();
      return;
    }
    let index: number;
    if (e.key === 'ArrowDown') index = (at + 1) % enabled.length;
    else if (e.key === 'ArrowUp') index = (at - 1 + enabled.length) % enabled.length;
    else if (e.key === 'Home') index = 0;
    else if (e.key === 'End') index = enabled.length - 1;
    else return;
    e.preventDefault();
    enabled[index].focus();
  }
  private listen(target: EventTarget, type: string, listener: EventListener, capture = false): void {
    target.addEventListener(type, listener, capture);
    this.off.push(() => target.removeEventListener(type, listener, capture));
  }
  private pointer(e: PointerEvent): void {
    if (e.type === 'pointerdown') {
      this.dragged = false;
      const button = (e.target as HTMLElement).closest('button');
      if (e.button !== 0 || !button || !this.element.contains(button)) return;
      const c = this.cube.camera,
        d = CompassNavigation.localOf(
          this.cube,
          c.position.map((v, i) => v - c.target[i]),
        );
      this.sync();
      this.grab = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        theta: this.heading,
        phi: Math.acos(Math.max(-1, Math.min(1, d[1] / Math.hypot(...d)))),
        twist: (this.cube.turns * Math.PI) / 2,
        button,
      };
      if (e.isTrusted) button.setPointerCapture(e.pointerId);
      return;
    }
    const g = this.grab;
    if (!g || e.pointerId !== g.id) return;
    if (e.type !== 'pointermove') {
      if (g.button.hasPointerCapture?.(g.id)) g.button.releasePointerCapture(g.id);
      this.grab = undefined;
      return;
    }
    if (!this.dragged && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 3) return;
    this.dragged = true;
    CompassNavigation.turn(
      this.cube,
      g.theta - ((e.clientX - g.x) * 2) / (parseFloat(this.cube.element.style.width) + 16),
      g.phi,
      g.twist,
    );
    e.preventDefault();
    this.sync();
  }
  /** Removes the ring, menu, listeners and plugin; leaves the cube usable. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.closeMenu();
    this.disposed = true;
    if (this.grab?.button.hasPointerCapture?.(this.grab.id)) this.grab.button.releasePointerCapture(this.grab.id);
    this.grab = undefined;
    for (const off of this.off) off();
    this.element.remove();
    this.menu?.remove();
    const c = this.cube;
    [c.element.style.marginLeft, c.element.style.marginRight, c.element.style.marginBottom] = this.margins;
    if (c.dispose === this.disposeCube) c.dispose = this.previousDispose;
    instances.delete(c);
    if (!c.engine.disposed && c.engine.hasPlugin(this.name)) c.engine.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

import type { EngineKernel } from '@margoengine/core';
import { type Face, ViewCube, type ViewCubeOptions } from './index.js';

/** Options for {@link AxisTriad}: the ViewCube's, with `size` (the triad's width in CSS pixels) defaulting to 64. */
export type AxisTriadOptions = ViewCubeOptions;
/** Each axis: its direction, the face its positive and negative balls view from, the letter on its ball. */
const AXES: [number, Face, Face, string][] = [
  [0, 'right', 'left', 'X'],
  [1, 'top', 'bottom', 'Y'],
  [2, 'front', 'back', 'Z'],
];
/** Ball diameters in CSS pixels, positive and negative end. */
const BIG = 18,
  SMALL = 12;
const CSS = `.mvc-ball{position:absolute;left:0;top:0;box-sizing:border-box;margin:0;padding:0;border:2px solid var(--c);border-radius:50%;background:var(--c);color:#fff;font:700 10px/14px system-ui,sans-serif;text-align:center;pointer-events:auto;cursor:pointer;outline:none}
.mvc-ball[aria-hidden]{background:var(--mvc-background)}
.mvc-ball:hover,.mvc-ball:focus-visible{box-shadow:0 0 0 2px var(--mvc-focus)}
.mvc-stick{position:absolute;left:0;top:0;height:2px;background:var(--c);transform-origin:0 50%;pointer-events:none}`;

/**
 * A compact axis gizmo (X, Y and Z balls on sticks, and a smaller ball at each negative end) for apps that want less
 * than a cube. It is a {@link ViewCube} in every other way: a click on a ball animates to that axis view, dragging
 * orbits, and the home view, roll buttons, projection toggle, themes and keyboard work the same. The axis colours are
 * the custom properties `--mvc-x`, `--mvc-y` and `--mvc-z` (default red, green and blue).
 */
export class AxisTriad extends ViewCube {
  /** Balls and sticks with their signed axis (1 is +X, -3 is -Z); set while the base constructor builds the widget. */
  declare private axes: [ball: HTMLElement, stick: HTMLElement, axis: number][];
  declare private radius: number;

  /** Creates the AxisTriad on `engine` (preferred over the constructor). */
  static override attach(engine: EngineKernel, options?: AxisTriadOptions): AxisTriad {
    return new AxisTriad(engine, options);
  }
  constructor(engine: EngineKernel, options: AxisTriadOptions = {}) {
    super(engine, { size: 64, ...options });
  }

  /** Builds the balls and sticks in place of the cube's faces. */
  protected override build(cube: HTMLDivElement, names: Record<Face, string>, size: number): void {
    const doc = cube.ownerDocument,
      add = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, color: string) => {
        const e = doc.createElement(tag);
        e.className = className;
        e.style.setProperty('--c', color);
        cube.appendChild(e);
        return e;
      };
    cube.appendChild(doc.createElement('style')).textContent = CSS;
    this.axes = [];
    this.radius = size / 2 - BIG / 2;
    for (const [a, plus, minus, letter] of AXES) {
      const color = `var(--mvc-${letter.toLowerCase()},${['#c62828', '#2e7d32', '#1565c0'][a]})`;
      for (const sign of [1, -1]) {
        const d = [0, 0, 0];
        d[a] = sign;
        const face = sign > 0 ? plus : minus,
          stick = add('div', 'mvc-stick', color),
          ball = add(sign > 0 ? 'button' : 'div', 'mvc-ball', color);
        if (sign < 0) stick.style.opacity = '.5';
        ball.dataset.view = d.join();
        ball.title = names[face];
        ball.style.width = ball.style.height = (sign > 0 ? BIG : SMALL) + 'px';
        if (sign > 0) {
          (ball as HTMLButtonElement).type = 'button';
          ball.textContent = letter;
          ball.setAttribute('aria-label', `${names[face]} view (${letter})`);
        } else ball.setAttribute('aria-hidden', 'true');
        this.axes.push([ball, stick, sign * (a + 1)]);
      }
    }
  }
  /** Places each ball where its axis points on screen, nearer balls in front. */
  protected override draw(right: readonly number[], up: readonly number[], back: readonly number[]): void {
    const r = this.radius,
      c = r + BIG / 2;
    for (const [ball, stick, k] of this.axes) {
      const a = Math.abs(k) - 1,
        s = Math.sign(k),
        x = s * right[a] * r,
        y = -s * up[a] * r,
        depth = s * back[a],
        b = s > 0 ? BIG : SMALL;
      ball.style.transform = `translate(${+(c + x - b / 2).toFixed(3)}px,${+(c + y - b / 2).toFixed(3)}px)`;
      ball.style.zIndex = String(Math.round(depth * 100) + 200);
      stick.style.width = +Math.hypot(x, y).toFixed(3) + 'px';
      stick.style.transform = `translate(${c}px,${c - 1}px) rotate(${+Math.atan2(y, x).toFixed(6)}rad)`;
      stick.style.zIndex = String(Math.round(depth * 50) + 200);
    }
  }
}

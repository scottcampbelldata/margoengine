import type { OutlineFont, OutlineCommand } from '@margoengine/loaders/font';
import { fault, rangeError } from '../../shared/errors.js';
import { parseMath, mathTree, mathXML, type MathNode } from './math-parser.js';
import { markupText, renderMarkup } from './markup.js';
import type { Figure } from './figure.js';
import { registerPublicationLabel } from './publication-labels.js';
export { parseMath, mathML } from './math-parser.js';
export type { MathNode } from './math-parser.js';

/** Font and presentation options for the TeX subset. */
export interface MathOptions {
  /** Caller-owned outline font, including the formula's Unicode symbols. */
  readonly font: OutlineFont;
  /** Pixels per em, default 16. */
  readonly size?: number;
  /** Native MathML display mode, default false. */
  readonly display?: boolean;
  /** SVG fill, default currentColor. */
  readonly color?: string;
}
/** One formula's native MathML and matching vector outline with measured bounds. */
export interface MathLayout {
  readonly mathML: string;
  readonly svg: string;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly baseline: number;
}
interface Box {
  w: number;
  a: number;
  d: number;
  paths: string[];
}
const n = (x: number) => String(Math.round(x * 1e6) / 1e6);
/** @internal Font outline in SVG y-down coordinates. */
export function glyphPath(commands: readonly OutlineCommand[], x: number, y: number, sx: number, sy = -sx): string {
  return commands
    .map(
      (c) =>
        c[0] +
        c
          .slice(1)
          .map((v, i) => n((i % 2 ? y : x) + (v as number) * (i % 2 ? sy : sx)))
          .join(' '),
    )
    .join('');
}
/** @internal Text outlines and advances. Missing glyphs fail rather than silently replacing scientific symbols. */
export function outlineText(text: string, font: OutlineFont, size: number): { path: string; width: number } {
  const s = size / font.unitsPerEm,
    paths: string[] = [];
  let pen = 0,
    previous = '';
  for (const char of text) {
    const g = font.glyph(char);
    if (!g)
      throw fault(
        'unsupported',
        `Font ${font.familyName ?? ''} lacks ${char} (U+${char.codePointAt(0)!.toString(16)}). Supply a font covering the label.`,
        'sciviz',
      );
    if (previous) pen += font.kerning(previous, char) * s;
    paths.push(glyphPath(g.commands, pen, 0, s));
    pen += g.advance * s;
    previous = char;
  }
  return { path: paths.join(''), width: pen };
}
// Translation is applied to coordinates, keeping the result one reusable Path2D.
const move = (path: string, x: number, y: number): string => {
  let axis = 0;
  return path.replace(/[MLQCZ]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi, (v) => {
    if (/^[MLQCZ]$/i.test(v)) {
      axis = 0;
      return v;
    }
    return n(Number(v) + (axis++ % 2 ? y : x)) + ' ';
  });
};
const placed = (b: Box, x: number, y: number) => b.paths.map((p) => move(p, x, y));
const line = (x: number, y: number, w: number, t: number) =>
  `M${n(x)} ${n(y)}L${n(x + w)} ${n(y)}L${n(x + w)} ${n(y + t)}L${n(x)} ${n(y + t)}Z`;

/** Typeset the documented TeX subset to accessible MathML and font-outline SVG. */
export function renderMath(source: string, options: MathOptions): MathLayout {
  const size = options.size ?? 16,
    font = options.font;
  if (!Number.isFinite(size) || size <= 0)
    throw rangeError('Use a positive finite math size in pixels per em', 'sciviz');
  const text = (s: string, em: number): Box => {
    const r = outlineText(s, font, em);
    return {
      w: r.width,
      a: (font.ascender / font.unitsPerEm) * em,
      d: (-font.descender / font.unitsPerEm) * em,
      paths: [r.path],
    };
  };
  const layout = (ast: MathNode, em: number): Box => {
    const t = Math.max(em * 0.045, 0.25);
    if (ast.kind === 'space')
      return {
        w: em * (ast.text === 'qquad' ? 2 : ast.text === 'quad' ? 1 : ast.text === '!' ? -0.167 : 0.167),
        a: 0,
        d: 0,
        paths: [],
      };
    if (ast.kind === 'row') {
      const boxes = ast.children.map((x) => layout(x, em));
      let w = 0;
      const a = Math.max(0, ...boxes.map((b) => b.a)),
        d = Math.max(0, ...boxes.map((b) => b.d));
      const paths: string[] = [];
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (ast.children[i].kind === 'delimiter' && b.a + b.d > 0) {
          const delimiter = ast.children[i].text ?? '',
            g = font.glyph(delimiter);
          if (g)
            paths.push(
              glyphPath(
                g.commands,
                w,
                (d - a) / 2 + (((font.ascender + font.descender) / (font.ascender - font.descender)) * (a + d)) / 2,
                em / font.unitsPerEm,
                -(a + d) / (font.ascender - font.descender),
              ),
            );
        } else paths.push(...placed(b, w, 0));
        w += b.w;
      }
      return { w, a, d, paths };
    }
    if (ast.kind === 'frac') {
      const a = layout(ast.children[0], em * 0.8),
        b = layout(ast.children[1], em * 0.8),
        w = Math.max(a.w, b.w) + em * 0.3,
        axis = -em * 0.25;
      const ay = axis - em * 0.2 - a.d,
        by = axis + em * 0.2 + b.a;
      return {
        w,
        a: -ay + a.a,
        d: by + b.d,
        paths: [...placed(a, (w - a.w) / 2, ay), ...placed(b, (w - b.w) / 2, by), line(0, axis - t / 2, w, t)],
      };
    }
    if (ast.kind === 'scripts') {
      const b = layout(ast.children[0], em),
        sub = layout(ast.children[1], em * 0.7),
        sup = layout(ast.children[2], em * 0.7);
      let up = -Math.max(em * 0.55, b.a - em * 0.15),
        down = Math.max(em * 0.25, b.d + em * 0.15);
      if (sub.w && sup.w) {
        const gap = down - sub.a - (up + sup.d);
        if (gap < em * 0.2) {
          up -= (em * 0.2 - gap) / 2;
          down += (em * 0.2 - gap) / 2;
        }
      }
      return {
        w: b.w + Math.max(sub.w, sup.w) + em * 0.04,
        a: Math.max(b.a, -up + sup.a),
        d: Math.max(b.d, down + sub.d),
        paths: [...b.paths, ...placed(sub, b.w, down), ...placed(sup, b.w, up)],
      };
    }
    if (ast.kind === 'root') {
      const b = layout(ast.children[0], em),
        index = ast.children[1] ? layout(ast.children[1], em * 0.5) : undefined;
      const pad = index ? Math.max(index.w, em * 0.2) : 0,
        x = pad + em * 0.65,
        top = -b.a - em * 0.15,
        bottom = b.d;
      const path = `M${n(pad)} ${n(-em * 0.15)}L${n(pad + em * 0.15)} ${n(-em * 0.25)}L${n(pad + em * 0.32)} ${n(bottom)}L${n(x - em * 0.08)} ${n(top)}L${n(x + b.w + em * 0.1)} ${n(top)}L${n(x + b.w + em * 0.1)} ${n(top + t)}L${n(x)} ${n(top + t)}L${n(pad + em * 0.33)} ${n(bottom + em * 0.1)}L${n(pad + em * 0.12)} ${n(-em * 0.12)}Z`;
      return {
        w: x + b.w + em * 0.1,
        a: Math.max(-top, index ? b.a * 0.6 + index.a : 0),
        d: bottom + em * 0.1,
        paths: [path, ...placed(b, x, 0), ...(index ? placed(index, 0, -b.a * 0.6) : [])],
      };
    }
    if (ast.kind === 'accent') {
      const b = layout(ast.children[0], em),
        y = -b.a - em * 0.12,
        mark = ast.text!,
        w = b.w;
      let paths: string[];
      if (mark === 'bar' || mark === 'overline' || mark === 'underline')
        paths = [line(0, mark === 'underline' ? b.d + em * 0.12 : y, w, t)];
      else if (mark === 'hat' || mark === 'widehat')
        paths = [`M0 ${n(y)}L${n(w / 2)} ${n(y - em * 0.2)}L${n(w)} ${n(y)}L${n(w / 2)} ${n(y - em * 0.2 + t)}Z`];
      else if (mark === 'vec')
        paths = [
          line(0, y, w, t),
          `M${n(w - em * 0.2)} ${n(y - em * 0.12)}L${n(w)} ${n(y)}L${n(w - em * 0.2)} ${n(y + em * 0.12)}Z`,
        ];
      else if (mark === 'dot' || mark === 'ddot')
        paths =
          mark === 'dot'
            ? [line(w / 2 - t, y, t * 2, t * 2)]
            : [line(w / 2 - em * 0.12, y, t * 2, t * 2), line(w / 2 + em * 0.04, y, t * 2, t * 2)];
      else
        paths = [
          `M0 ${n(y)}C${n(w * 0.33)} ${n(y - em * 0.3)} ${n(w * 0.67)} ${n(y + em * 0.3)} ${n(w)} ${n(y)}L${n(w)} ${n(y + t)}C${n(w * 0.67)} ${n(y + em * 0.3 + t)} ${n(w * 0.33)} ${n(y - em * 0.3 + t)} 0 ${n(y + t)}Z`,
        ];
      return {
        w,
        a: b.a + (mark === 'underline' ? 0 : em * 0.4),
        d: b.d + (mark === 'underline' ? em * 0.2 : 0),
        paths: [...b.paths, ...paths],
      };
    }
    if (ast.kind === 'matrix') {
      const rows = ast.children.map((r) => r.children.map((c) => layout(c, em))),
        cols = Math.max(...rows.map((r) => r.length));
      const widths = Array.from({ length: cols }, (_, i) => Math.max(0, ...rows.map((r) => r[i]?.w ?? 0)));
      const metrics = rows.map((r) => ({ a: Math.max(...r.map((b) => b.a)), d: Math.max(...r.map((b) => b.d)) }));
      const h = metrics.reduce((s, m) => s + m.a + m.d, 0) + em * 0.4 * (rows.length - 1),
        a = h / 2 + em * 0.25,
        d = h - a;
      const pairs: Record<string, string[]> = {
        pmatrix: ['(', ')'],
        bmatrix: ['[', ']'],
        Bmatrix: ['{', '}'],
        vmatrix: ['|', '|'],
        Vmatrix: ['‖', '‖'],
        cases: ['{', ''],
      };
      const pair = pairs[ast.text!] ?? ['', ''],
        edge = pair[0] ? em * 0.45 : 0;
      const w = widths.reduce((a, b) => a + b, 0) + em * 0.6 * (cols - 1) + edge * (pair[1] ? 2 : 1),
        paths: string[] = [];
      let y = -a;
      rows.forEach((r, j) => {
        y += metrics[j].a;
        let x = edge;
        r.forEach((b, i) => {
          paths.push(...placed(b, x + (widths[i] - b.w) / 2, y));
          x += widths[i] + em * 0.6;
        });
        y += metrics[j].d + em * 0.4;
      });
      pair.forEach((c, i) => {
        if (!c) return;
        const g = font.glyph(c);
        if (!g) outlineText(c, font, em);
        else
          paths.push(
            glyphPath(
              g.commands,
              i ? w - edge : 0,
              (d - a) / 2 + (((font.ascender + font.descender) / (font.ascender - font.descender)) * h) / 2,
              em / font.unitsPerEm,
              -h / (font.ascender - font.descender),
            ),
          );
      });
      return { w, a, d, paths };
    }
    const b = text(ast.text ?? '', em);
    if (ast.kind === 'mo' || ast.kind === 'operator') {
      b.paths = placed(b, em * 0.12, 0);
      b.w += em * 0.24;
    }
    return b;
  };
  const ast = parseMath(source),
    b = layout(ast, size),
    path = placed(b, 0, b.a).join(''),
    width = Math.max(b.w, 0.01),
    height = Math.max(b.a + b.d, 0.01);
  return {
    mathML: markupText([mathTree(source, options.display, ast)]),
    path,
    width,
    height,
    baseline: b.a,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${mathXML(source)}"><path d="${path}" fill="${mathXML(options.color ?? 'currentColor')}"/></svg>`,
  };
}

/** Replace a figure HTML label with native MathML and retain the identical path layout for SVG/PNG/PDF exports. */
export function mathLabel(element: HTMLElement, source: string, options: MathOptions): MathLayout {
  const result = renderMath(source, options);
  renderMarkup(element, 'http://www.w3.org/1998/Math/MathML', [mathTree(source, options.display)]);
  element.dataset.scivizMath = JSON.stringify({ path: result.path, width: result.width, height: result.height });
  element.style.fontSize = `${options.size ?? 16}px`;
  return result;
}

/** A math overlay positioned in CSS pixels from the figure canvas's top-left. */
export interface FigureMathOptions extends MathOptions {
  readonly x: number;
  readonly y: number;
}
/** Adds a formula title or label to HTML and every figure export. Dispose to remove it early. */
export function addMathLabel(
  figure: Figure,
  source: string,
  options: FigureMathOptions,
): { readonly element: HTMLElement; dispose(): void; [Symbol.dispose](): void } {
  const canvas = (figure.engine as unknown as { canvas: HTMLCanvasElement }).canvas;
  const element = document.createElement('span'),
    parent = canvas.parentElement;
  if (!parent) throw fault('state', 'Attach the figure canvas before adding a math label.', 'sciviz');
  if (!Number.isFinite(options.x + options.y)) throw rangeError('Math label coordinates must be finite.', 'sciviz');
  mathLabel(element, source, options);
  element.style.cssText += `;position:absolute;left:${canvas.offsetLeft + options.x}px;top:${canvas.offsetTop + options.y}px;color:${options.color ?? figure.theme.text};pointer-events:none`;
  parent.append(element);
  const dispose = registerPublicationLabel(figure, element);
  return { element, dispose, [Symbol.dispose]: dispose };
}

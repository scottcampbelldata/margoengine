import type { OutlineFont, OutlineCommand } from '@margoengine/loaders/font';
import type { Figure } from './figure.js';
import { outlineText } from './math.js';
import { fault, rangeError } from '../../shared/errors.js';
import { parseXMLDocument, type XMLAttribute, type XMLElement } from '../../shared/xml-document.js';
import { escapeXML } from '../../shared/xml-escape.js';

/** Outline font, physical page size, document metadata and cancellation for PDF export. */
export interface PDFOptions {
  /** Caller-owned font with Unicode coverage for labels. Text is written as paths. */
  readonly font: OutlineFont;
  /** Select fonts for individual SVG text elements. Default: font. */
  readonly fontForText?: (family: string, weight: string) => OutlineFont;
  /** Page width in millimetres. Default SVG CSS width at 96 pixels/inch. */
  readonly widthMM?: number;
  readonly title?: string;
  readonly author?: string;
  readonly subject?: string;
  readonly keywords?: string;
  /** Additional JSON provenance, stored in the document information dictionary. */
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}
const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);
const number = (x: number): string => {
  if (!Number.isFinite(x))
    throw fault('unsupported', 'Non-finite SVG coordinate. Supply finite coordinates.', 'sciviz');
  return String(Math.round(x * 1e7) / 1e7);
};
const numbers = (s: string) => (s.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
function fail(s: string): never {
  throw fault('unsupported', s, 'sciviz');
}
const join = (parts: readonly Uint8Array[]) => {
  const b = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let i = 0;
  for (const p of parts) {
    b.set(p, i);
    i += p.length;
  }
  return b;
};
// PDF strings use UTF-16BE with BOM, not a lossy PDFDocEncoding conversion.
const pdfString = (s: string) =>
  '<FEFF' + Array.from({ length: s.length }, (_, i) => s.charCodeAt(i).toString(16).padStart(4, '0')).join('') + '>';

class PDF {
  objects: Uint8Array[] = [];
  reserve(): number {
    this.objects.push(bytes(''));
    return this.objects.length;
  }
  put(id: number, s: string | Uint8Array): void {
    this.objects[id - 1] = typeof s === 'string' ? bytes(s) : s;
  }
  add(s: string): number {
    const id = this.reserve();
    this.put(id, s);
    return id;
  }
  async stream(data: Uint8Array, dict = ''): Promise<number> {
    const compressed = new Uint8Array(
      await new Response(
        new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate')),
      ).arrayBuffer(),
    );
    const id = this.reserve();
    this.put(
      id,
      join([
        bytes(`<< /Length ${compressed.length} /Filter /FlateDecode ${dict} >>\nstream\n`),
        compressed,
        bytes('\nendstream'),
      ]),
    );
    return id;
  }
  finish(root: number, info: number): Blob {
    const parts = [bytes('%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n')],
      offsets = [0];
    let offset = parts[0].length;
    this.objects.forEach((o, i) => {
      const b = join([bytes(`${i + 1} 0 obj\n`), o, bytes('\nendobj\n')]);
      offsets.push(offset);
      offset += b.length;
      parts.push(b);
    });
    parts.push(
      bytes(
        `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
          .slice(1)
          .map((o) => String(o).padStart(10, '0') + ' 00000 n \n')
          .join(
            '',
          )}trailer\n<< /Size ${offsets.length} /Root ${root} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
      ),
    );
    return new Blob(parts as BlobPart[], { type: 'application/pdf' });
  }
}

/** @internal Exact quadratic-to-cubic conversion, preserving every figure path. */
function contentPath(commands: readonly OutlineCommand[]): string {
  const out: string[] = [];
  let x = 0,
    y = 0,
    sx = 0,
    sy = 0;
  for (const c of commands) {
    if (c[0] === 'M') {
      x = sx = c[1];
      y = sy = c[2];
      out.push(`${number(x)} ${number(y)} m`);
    } else if (c[0] === 'L') {
      x = c[1];
      y = c[2];
      out.push(`${number(x)} ${number(y)} l`);
    } else if (c[0] === 'Q') {
      out.push(
        `${[x + (2 / 3) * (c[1] - x), y + (2 / 3) * (c[2] - y), c[3] + (2 / 3) * (c[1] - c[3]), c[4] + (2 / 3) * (c[2] - c[4]), c[3], c[4]].map(number).join(' ')} c`,
      );
      x = c[3];
      y = c[4];
    } else if (c[0] === 'C') {
      out.push(
        `${c
          .slice(1)
          .map((v) => number(v as number))
          .join(' ')} c`,
      );
      x = c[5];
      y = c[6];
    } else {
      out.push('h');
      x = sx;
      y = sy;
    }
  }
  return out.join('\n');
}

function transform(s: string): string {
  const out: string[] = [];
  let consumed = '';
  for (const m of s.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    consumed += m[0];
    const a = numbers(m[2]);
    let b: number[];
    if (m[1] === 'matrix' && a.length === 6) b = a;
    else if (m[1] === 'translate' && (a.length === 1 || a.length === 2)) b = [1, 0, 0, 1, a[0], a[1] ?? 0];
    else if (m[1] === 'scale' && (a.length === 1 || a.length === 2)) b = [a[0], 0, 0, a[1] ?? a[0], 0, 0];
    else if (m[1] === 'rotate' && (a.length === 1 || a.length === 3)) {
      const r = (a[0] * Math.PI) / 180,
        c = Math.cos(r),
        v = Math.sin(r),
        x = a[1] ?? 0,
        y = a[2] ?? 0;
      b = [c, v, -v, c, x - c * x + v * y, y - v * x - c * y];
    } else if ((m[1] === 'skewX' || m[1] === 'skewY') && a.length === 1)
      b =
        m[1] === 'skewX'
          ? [1, 0, Math.tan((a[0] * Math.PI) / 180), 1, 0, 0]
          : [1, Math.tan((a[0] * Math.PI) / 180), 0, 1, 0, 0];
    else fail(`Unsupported SVG transform ${m[0]}.`);
    out.push(b.map(number).join(' ') + ' cm');
  }
  if (consumed.replace(/[\s,]/g, '') !== s.replace(/[\s,]/g, '')) fail('Malformed SVG transform.');
  return out.join('\n');
}
const inherited = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-opacity',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'font-size',
  'font-family',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'color',
  'visibility',
];
type Style = Record<string, string>;
const styleOf = (el: XMLElement, parent: Style): Style => {
  const s = { ...parent };
  for (const k of [...inherited, 'opacity', 'display', 'clip-path']) {
    const a = el.getAttribute(k);
    if (a !== null) s[k] = a;
  }
  for (const part of (el.getAttribute('style') ?? '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0) s[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return s;
};

/** Browser-side PDF 1.7 export for every SVG emitted by Figure.toSVG and exportVector.
 * Supports paths, text outlines, PNG images with alpha, axial colour gradients, clipping and transforms.
 * Unrecognised drawing operations fail explicitly. No raster conversion of vector shapes.
 */
export async function svgToPDF(svg: string, options: PDFOptions): Promise<Blob> {
  options.signal?.throwIfAborted();
  const doc = parseXMLDocument(svg, { fail: (reason) => fail(`Expected well-formed SVG: ${reason}.`) }),
    root = doc.documentElement;
  if (root.localName !== 'svg') fail('Expected well-formed SVG.');
  const view = numbers(root.getAttribute('viewBox') ?? ''),
    width = Number.parseFloat(root.getAttribute('width') ?? '') || view[2],
    height = Number.parseFloat(root.getAttribute('height') ?? '') || view[3];
  if (!(width > 0 && height > 0 && Number.isFinite(width + height))) fail('SVG needs finite positive dimensions.');
  const pageWidth = options.widthMM === undefined ? width * 0.75 : (options.widthMM * 72) / 25.4;
  if (!(pageWidth > 0 && Number.isFinite(pageWidth))) throw rangeError('Use a positive finite PDF widthMM.', 'sciviz');
  const scale = pageWidth / width,
    pdf = new PDF(),
    catalog = pdf.reserve(),
    pages = pdf.reserve(),
    page = pdf.reserve();
  const gs: string[] = [],
    shadings: string[] = [],
    images: string[] = [],
    out: string[] = [`q\n${number(scale)} 0 0 ${number(-scale)} 0 ${number(height * scale)} cm`];
  const alpha = new Map<string, string>();
  const setAlpha = (fill: number, stroke: number): string => {
    const key = [fill, stroke].map(number).join(' ');
    let name = alpha.get(key);
    if (!name) {
      name = 'G' + alpha.size;
      const id = pdf.add(`<< /Type /ExtGState /ca ${number(fill)} /CA ${number(stroke)} >>`);
      gs.push(`/${name} ${id} 0 R`);
      alpha.set(key, name);
    }
    return `/${name} gs`;
  };
  const { parseSVG } = await import('@margoengine/loaders/svg');
  // One shape element as outline commands: its geometry only, painted later, with percentages resolved.
  const commands = (
    name: string,
    attributes: readonly Pick<XMLAttribute, 'name' | 'value'>[],
    w: number,
    h: number,
  ): OutlineCommand[] => {
    const values = new Map<string, string>();
    for (const a of attributes) if (a.name !== 'transform' && a.name !== 'style') values.set(a.name, a.value);
    values.set('fill', '#000');
    values.set('stroke', 'none');
    let shape = `<${name}`;
    for (const [key, value] of values)
      shape += ` ${key}="${escapeXML(
        value.endsWith('%')
          ? String((Number.parseFloat(value) / 100) * (/^(y|height|cy|ry)$/.test(key) ? h : w))
          : value,
      )}"`;
    const r = parseSVG(`<svg xmlns="http://www.w3.org/2000/svg">${shape}/></svg>`);
    if (r.warnings.length) fail(r.warnings.join('; '));
    return r.paths[0]?.commands ?? [];
  };
  const color = (value: string): { rgb: number[]; a: number } => {
    const c = parseSVG(`<svg><rect width="1" height="1" fill="${escapeXML(value)}"/></svg>`);
    const p = c.paths[0];
    if (!p?.fill || c.warnings.length) fail(`Unsupported colour ${value}.`);
    return { rgb: p.fill, a: p.fillOpacity };
  };
  const ratio = (value: string | undefined, fallback: number) =>
    value === undefined ? fallback : Number.parseFloat(value) / (value.endsWith('%') ? 100 : 1);
  const gradient = (paint: string, cmd: readonly OutlineCommand[]): string => {
    const id = paint.match(/^url\(#([^)]*)\)$/)?.[1],
      el = id ? doc.getElementById(id) : null;
    if (el?.localName !== 'linearGradient') fail(`Unsupported SVG paint ${paint}.`);
    const stops = [...el.children]
      .filter((e) => e.localName === 'stop')
      .map((e) => {
        const s = styleOf(e, {});
        return {
          offset: Math.max(0, Math.min(1, ratio(e.getAttribute('offset') ?? undefined, 0))),
          c: color(s['stop-color'] ?? e.getAttribute('stop-color') ?? '#000'),
        };
      });
    if (stops.length < 2) fail('PDF gradients require at least two stops.');
    if (
      stops.some((s) => s.c.a !== 1) ||
      [...el.children].some((e) => Number(e.getAttribute('stop-opacity') ?? 1) !== 1)
    )
      fail('Gradient stop opacity is not emitted by figures.');
    for (let i = 1; i < stops.length; i++)
      if (stops[i].offset < stops[i - 1].offset) fail('Gradient offsets must not decrease.');
    if (stops[0].offset !== 0) stops.unshift({ ...stops[0], offset: 0 });
    if (stops.at(-1)!.offset !== 1) stops.push({ ...stops.at(-1)!, offset: 1 });
    const xs: number[] = [],
      ys: number[] = [];
    for (const c of cmd)
      for (let i = 1; i < c.length; i += 2) {
        xs.push(c[i] as number);
        ys.push(c[i + 1] as number);
      }
    const xmin = Math.min(...xs),
      ymin = Math.min(...ys),
      bw = Math.max(...xs) - xmin,
      bh = Math.max(...ys) - ymin;
    const user = el.getAttribute('gradientUnits') === 'userSpaceOnUse';
    const xy = ['x1', 'y1', 'x2', 'y2'].map((k, i) => {
      const v = ratio(el.getAttribute(k) ?? undefined, i === 2 ? 1 : 0);
      return user ? v : i % 2 ? ymin + v * bh : xmin + v * bw;
    });
    if (el.hasAttribute('gradientTransform')) fail('Gradient transforms are not emitted by figures.');
    // Equal SVG offsets are a colour discontinuity. PDF stitching represents it with
    // adjacent nonempty domains and independent endpoint colours, never a zero-width function.
    const segments = stops.slice(1).flatMap((to, i) => (to.offset > stops[i].offset ? [{ from: stops[i], to }] : []));
    const functions = segments.map(
      ({ from, to }) =>
        `<< /FunctionType 2 /Domain [0 1] /C0 [${from.c.rgb.map(number).join(' ')}] /C1 [${to.c.rgb.map(number).join(' ')}] /N 1 >>`,
    );
    const fn = pdf.add(
      `<< /FunctionType 3 /Domain [0 1] /Functions [${functions.join(' ')}] /Bounds [${segments
        .slice(0, -1)
        .map((s) => number(s.to.offset))
        .join(' ')}] /Encode [${functions.map(() => '0 1').join(' ')}] >>`,
    );
    const sh = pdf.add(
        `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${xy.map(number).join(' ')}] /Function ${fn} 0 R /Extend [true true] >>`,
      ),
      name = 'S' + shadings.length;
    shadings.push(`/${name} ${sh} 0 R`);
    return `/${name} sh`;
  };
  const paint = (cmd: readonly OutlineCommand[], s: Style, opacity: number) => {
    const p = contentPath(cmd);
    if (!p) return;
    const f = s.fill ?? '#000',
      st = s.stroke ?? 'none',
      fc = f === 'none' || f.startsWith('url(') ? undefined : color(f === 'currentColor' ? (s.color ?? '#000') : f),
      sc = st === 'none' ? undefined : color(st === 'currentColor' ? (s.color ?? '#000') : st);
    out.push(
      setAlpha(
        opacity * ratio(s['fill-opacity'], 1) * (fc?.a ?? 1),
        opacity * ratio(s['stroke-opacity'], 1) * (sc?.a ?? 1),
      ),
    );
    const even = s['fill-rule'] === 'evenodd';
    if (f.startsWith('url(')) out.push('q', p, even ? 'W* n' : 'W n', gradient(f, cmd), 'Q');
    else if (fc) out.push(fc.rgb.map(number).join(' ') + ' rg');
    if (sc) {
      out.push(
        sc.rgb.map(number).join(' ') + ' RG',
        `${number(ratio(s['stroke-width'], 1))} w`,
        `${s['stroke-linecap'] === 'round' ? 1 : s['stroke-linecap'] === 'square' ? 2 : 0} J`,
        `${s['stroke-linejoin'] === 'round' ? 1 : s['stroke-linejoin'] === 'bevel' ? 2 : 0} j`,
        `${number(ratio(s['stroke-miterlimit'], 4))} M`,
      );
      if (s['stroke-dasharray'] && s['stroke-dasharray'] !== 'none')
        out.push(
          `[${numbers(s['stroke-dasharray']).map(number).join(' ')}] ${number(ratio(s['stroke-dashoffset'], 0))} d`,
        );
    }
    if (fc || sc) out.push(p, fc ? (sc ? (even ? 'B*' : 'B') : even ? 'f*' : 'f') : 'S');
  };
  let visited = 0;
  const visit = async (
    el: XMLElement,
    parent: Style,
    w: number,
    h: number,
    opacity: number,
    depth: number,
  ): Promise<void> => {
    if (depth > 128) fail('SVG nesting exceeds 128.');
    if (++visited % 128 === 0) {
      options.signal?.throwIfAborted();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const name = el.localName,
      s = styleOf(el, parent);
    if (['defs', 'linearGradient', 'clipPath', 'metadata', 'title', 'desc'].includes(name) || s.display === 'none')
      return;
    const effective =
      opacity *
      ratio(el.getAttribute('opacity') ?? el.getAttribute('style')?.match(/(?:^|;)\s*opacity\s*:\s*([^;]+)/)?.[1], 1);
    out.push('q');
    if (el.hasAttribute('transform')) out.push(transform(el.getAttribute('transform')!));
    if (name === 'svg') {
      const length = (key: string, fallback: number) => {
        const v = el.getAttribute(key);
        return v === null
          ? fallback
          : ratio(v, fallback) * (v.endsWith('%') ? (key === 'width' || key === 'x' ? w : h) : 1);
      };
      const vw = length('width', w),
        vh = length('height', h),
        x = length('x', 0),
        y = length('y', 0),
        vb = numbers(el.getAttribute('viewBox') ?? '');
      out.push(`1 0 0 1 ${number(x)} ${number(y)} cm`, `0 0 ${number(vw)} ${number(vh)} re W n`);
      if (vb.length === 4) {
        if (!(vb[2] > 0 && vb[3] > 0)) fail('Invalid SVG viewBox.');
        let sx = vw / vb[2],
          sy = vh / vb[3],
          dx = 0,
          dy = 0;
        if (el.getAttribute('preserveAspectRatio') !== 'none') {
          const k = Math.min(sx, sy);
          dx = (vw - k * vb[2]) / 2;
          dy = (vh - k * vb[3]) / 2;
          sx = sy = k;
        }
        out.push(`${number(sx)} 0 0 ${number(sy)} ${number(dx - vb[0] * sx)} ${number(dy - vb[1] * sy)} cm`);
        w = vb[2];
        h = vb[3];
      } else {
        w = vw;
        h = vh;
      }
    }
    const clip = s['clip-path'];
    delete s['clip-path'];
    if (clip) {
      const id = clip.match(/^url\(#([^)]*)\)$/)?.[1],
        cp = id ? doc.getElementById(id) : null;
      if (cp?.localName !== 'clipPath') fail('Unknown clipping path.');
      const list = cp.children.flatMap((c) => commands(c.localName, c.attributes, w, h));
      out.push(contentPath(list), 'W n');
    }
    if (name === 'g' || name === 'svg') {
      for (const child of el.children) await visit(child, s, w, h, effective, depth + 1);
    } else if (s.visibility === 'hidden') {
    } else if (['rect', 'circle', 'ellipse', 'path', 'line', 'polyline', 'polygon'].includes(name))
      paint(commands(name, el.attributes, w, h), s, effective);
    else if (name === 'text') {
      if (el.children.length) fail('Nested text spans are not emitted by figures.');
      const size = ratio(s['font-size'], 16),
        font = options.fontForText?.(s['font-family'] ?? '', s['font-weight'] ?? 'normal') ?? options.font;
      const t = outlineText(el.textContent ?? '', font, size),
        x =
          ratio(el.getAttribute('x') ?? undefined, 0) -
          (s['text-anchor'] === 'middle' ? t.width / 2 : s['text-anchor'] === 'end' ? t.width : 0),
        y =
          ratio(el.getAttribute('y') ?? undefined, 0) +
          (s['dominant-baseline'] === 'central'
            ? (((font.ascender + font.descender) / font.unitsPerEm) * size) / 2
            : 0);
      out.push(`1 0 0 1 ${number(x)} ${number(y)} cm`);
      paint(commands('path', [{ name: 'd', value: t.path }], w, h), s, effective);
    } else if (name === 'image') {
      const href = el.getAttribute('href') ?? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '';
      if (!/^data:image\/(png|jpeg|webp);base64,/i.test(href))
        fail('PDF images must be embedded PNG, JPEG or WebP data URLs.');
      options.signal?.throwIfAborted();
      const response = await fetch(href, { signal: options.signal }),
        bitmap = await createImageBitmap(await response.blob());
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
          g = canvas.getContext('2d')!;
        g.drawImage(bitmap, 0, 0);
        const rgba = g.getImageData(0, 0, bitmap.width, bitmap.height).data,
          rgb = new Uint8Array(bitmap.width * bitmap.height * 3),
          a = new Uint8Array(bitmap.width * bitmap.height);
        let transparent = false;
        for (let i = 0; i < a.length; i++) {
          rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
          a[i] = rgba[i * 4 + 3];
          if (a[i] !== 255) transparent = true;
        }
        const dims = `/Type /XObject /Subtype /Image /Width ${bitmap.width} /Height ${bitmap.height} /BitsPerComponent 8`;
        const mask = transparent ? await pdf.stream(a, `${dims} /ColorSpace /DeviceGray`) : undefined,
          id = await pdf.stream(rgb, `${dims} /ColorSpace /DeviceRGB ${mask ? `/SMask ${mask} 0 R` : ''}`),
          key = 'I' + images.length;
        images.push(`/${key} ${id} 0 R`);
        const iw = ratio(el.getAttribute('width') ?? undefined, bitmap.width),
          ih = ratio(el.getAttribute('height') ?? undefined, bitmap.height),
          ix = ratio(el.getAttribute('x') ?? undefined, 0),
          iy = ratio(el.getAttribute('y') ?? undefined, 0);
        out.push(
          setAlpha(effective, effective),
          `${number(iw)} 0 0 ${number(-ih)} ${number(ix)} ${number(iy + ih)} cm`,
          `/${key} Do`,
        );
      } finally {
        bitmap.close();
      }
    } else fail(`Unsupported SVG element <${name}>.`);
    out.push('Q');
  };
  await visit(root, {}, width, height, 1, 0);
  out.push('Q');
  options.signal?.throwIfAborted();
  const stream = await pdf.stream(bytes(out.join('\n'))),
    info = pdf.add(
      `<< /Producer ${pdfString('Margo Engine clean-room PDF 1.7')} ${['title', 'author', 'subject', 'keywords'].map((k) => (options[k as keyof PDFOptions] === undefined ? '' : `/${k[0].toUpperCase() + k.slice(1)} ${pdfString(String(options[k as keyof PDFOptions]))}`)).join(' ')} ${options.provenance ? `/MargoProvenance ${pdfString(JSON.stringify(options.provenance))}` : ''} >>`,
    );
  pdf.put(catalog, `<< /Type /Catalog /Pages ${pages} 0 R >>`);
  pdf.put(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
  pdf.put(
    page,
    `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${number(pageWidth)} ${number(height * scale)}] /Resources << /ExtGState << ${gs.join(' ')} >> /Shading << ${shadings.join(' ')} >> /XObject << ${images.join(' ')} >> >> /Contents ${stream} 0 R /Group << /S /Transparency /CS /DeviceRGB >> >>`,
  );
  options.signal?.throwIfAborted();
  return pdf.finish(catalog, info);
}

/** Export a figure's current SVG, including raster fallback and HTML math labels, as PDF. */
export async function exportPDF(figure: Figure, options: PDFOptions): Promise<Blob> {
  options.signal?.throwIfAborted();
  return svgToPDF(await figure.toSVG(), options);
}

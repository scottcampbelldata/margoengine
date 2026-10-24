import test from 'node:test';
import assert from 'node:assert/strict';
import { LoaderError } from '../dist/index.js';
import { parseSVG } from '../dist/svg.js';

const svg = (body, attributes = 'viewBox="0 0 100 100"') =>
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attributes}>${body}</svg>`;
const round = (value) => (typeof value === 'number' ? Math.round(value * 1e6) / 1e6 + 0 : value);
const rounded = (commands) => commands.map((c) => c.map(round));
/** End point of each command (M L Q C), Z skipped. */
const ends = (commands) => commands.filter((c) => c[0] !== 'Z').map((c) => c.slice(-2).map(round));
function bounds(path) {
  const points = path.getPoints(16);
  return [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1])),
  ].map((v) => Math.round(v * 1000) / 1000 + 0);
}
/** Sum of triangle areas of a stroke geometry, and whether every triangle faces +z (counter-clockwise). */
function strokeArea(geometry) {
  const p = geometry.positions;
  let area = 0,
    ccw = true;
  for (let i = 0; i < geometry.indices.length; i += 3) {
    const [a, b, c] = [geometry.indices[i], geometry.indices[i + 1], geometry.indices[i + 2]].map((v) => v * 3);
    const twice = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[c] - p[a]) * (p[b + 1] - p[a + 1]);
    if (twice <= 0) ccw = false;
    area += Math.abs(twice) / 2;
  }
  return { area, ccw };
}
/** Union area of a stroke geometry's triangles, from a 400 x 400 grid of cell centres over their bounds. */
function coveredArea(geometry) {
  const p = geometry.positions,
    triangles = [];
  if (!p.length) return 0;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    x0 = Math.min(x0, p[i]);
    x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]);
    y1 = Math.max(y1, p[i + 1]);
  }
  for (let i = 0; i < geometry.indices.length; i += 3)
    triangles.push([0, 1, 2].map((k) => [p[geometry.indices[i + k] * 3], p[geometry.indices[i + k] * 3 + 1]]));
  const n = 400,
    dx = (x1 - x0) / n,
    dy = (y1 - y0) / n;
  let hits = 0;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = x0 + (i + 0.5) * dx,
        y = y0 + (j + 0.5) * dy;
      const inside = ([a, b, c]) => {
        const edge = (u, v) => (v[0] - u[0]) * (y - u[1]) - (v[1] - u[1]) * (x - u[0]);
        return edge(a, b) >= -1e-12 && edge(b, c) >= -1e-12 && edge(c, a) >= -1e-12;
      };
      if (triangles.some(inside)) hits++;
    }
  return (hits / (n * n)) * (x1 - x0) * (y1 - y0);
}

test('SVG path data: every command, absolute and relative, implicit repeats, S and T reflections', () => {
  const { paths, warnings } = parseSVG(
    svg('<path d="M10 10 20 10l0 10H5v-5h2V10zm5 5 c0 5 5 5 5 0s5 -5 5 0 Q30 20 35 15t10 0 L1e1-2.5.5.5"/>'),
  );
  assert.deepEqual(warnings, []);
  const c = rounded(paths[0].commands);
  assert.deepEqual(c.slice(0, 8), [
    ['M', 10, 10],
    ['L', 20, 10],
    ['L', 20, 20],
    ['L', 5, 20],
    ['L', 5, 15],
    ['L', 7, 15],
    ['L', 7, 10],
    ['Z'],
  ]);
  // m after Z is relative to the closed subpath's start (10, 10).
  assert.deepEqual(c[8], ['M', 15, 15]);
  assert.deepEqual(c[9], ['C', 15, 20, 20, 20, 20, 15]);
  // S reflects the previous second control point (20, 20) about (20, 15).
  assert.deepEqual(c[10], ['C', 20, 10, 25, 10, 25, 15]);
  assert.deepEqual(c[11], ['Q', 30, 20, 35, 15]);
  // T reflects (30, 20) about (35, 15).
  assert.deepEqual(c[12], ['Q', 40, 10, 45, 15]);
  // "1e1-2.5.5.5" is 10, -2.5, then .5 .5 as an implicit second L.
  assert.deepEqual(c.slice(13), [
    ['L', 10, -2.5],
    ['L', 0.5, 0.5],
  ]);
});

test('SVG arcs: center parameterization, radii scaled up when too small, packed flags', () => {
  for (const d of ['M0 0 A10 10 0 0 1 20 0', 'M0 0 A1 1 0 0 1 20 0', 'M0 0a10 10 0 0120 0']) {
    const [path] = parseSVG(svg(`<path d="${d}"/>`)).paths;
    // Sweep 1 runs through increasing angles: over the top (y = -10 in SVG's y-down frame).
    assert.deepEqual(ends(path.commands), [
      [0, 0],
      [10, -10],
      [20, 0],
    ]);
    assert.equal(path.commands[1][0], 'C');
  }
  const [large] = parseSVG(svg('<path d="M0 0 A10 10 0 1 0 10 10"/>')).paths;
  // Large arc, sweep 0: three quarters of the circle centred at (0, 10), in three 90-degree pieces.
  assert.deepEqual(ends(large.commands), [
    [0, 0],
    [-10, 10],
    [0, 20],
    [10, 10],
  ]);
  // Zero radius is a straight line; a bad flag stops the path with a warning and keeps what came before.
  assert.deepEqual(parseSVG(svg('<path d="M0 0 A0 5 0 0 1 5 5"/>')).paths[0].commands, [
    ['M', 0, 0],
    ['L', 5, 5],
  ]);
  const bad = parseSVG(svg('<path d="M0 0 L5 5 A5 5 0 2 1 9 9 L1 1"/>'));
  assert.deepEqual(bad.paths[0].commands, [
    ['M', 0, 0],
    ['L', 5, 5],
  ]);
  assert.match(bad.warnings[0], /arc flag/);
});

test('SVG basic shapes: rect (rounded), circle, ellipse, line, polyline, polygon', () => {
  const { paths, warnings } = parseSVG(
    svg(
      '<rect x="1" y="2" width="10" height="20"/><rect width="10" height="10" rx="2"/><circle cx="5" cy="6" r="4"/>' +
        '<ellipse cx="0" cy="0" rx="3" ry="2"/><line x1="0" y1="0" x2="5" y2="5"/>' +
        '<polyline points="0,0 10,0 10,10 5"/><polygon points="0 0 10 0 0 10"/><rect width="0" height="5"/>',
    ),
  );
  assert.deepEqual(
    paths.map((p) => p.element),
    ['rect', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'],
  );
  assert.deepEqual(rounded(paths[0].commands), [['M', 1, 2], ['L', 11, 2], ['L', 11, 22], ['L', 1, 22], ['Z']]);
  assert.equal(paths[1].commands.filter((c) => c[0] === 'C').length, 4);
  assert.deepEqual(bounds(paths[1].toShapes()[0]), [0, 0, 10, 10]);
  assert.deepEqual(bounds(paths[2].toShapes()[0]), [1, 2, 9, 10]);
  assert.deepEqual(bounds(paths[3].toShapes()[0]), [-3, -2, 3, 2]);
  assert.equal(paths[4].toShapes().length, 0, 'a line has no fill');
  // A polyline fills as if closed.
  assert.deepEqual(bounds(paths[5].toShapes()[0]), [0, 0, 10, 10]);
  assert.equal(paths[6].commands.at(-1)[0], 'Z');
  assert.ok(warnings.some((w) => /odd count/.test(w)));
});

test('SVG transforms: nested groups, every transform function, nested svg viewports, use and symbol', () => {
  const { paths } = parseSVG(
    svg(
      '<g transform="translate(10,20) scale(2)"><rect transform="rotate(90)" width="1" height="2"/></g>' +
        '<rect transform="rotate(90 5 5)" width="1" height="1"/>' +
        '<rect transform="skewX(45)" width="1" height="1"/><rect transform="skewY(45)" width="1" height="1"/>' +
        '<rect transform="matrix(1 0 0 1 5 6)" width="1" height="1"/><rect transform="scale(2 3)" width="1" height="1"/>' +
        '<svg x="10" y="10" width="20" height="10" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' +
        '<defs><rect id="r" width="1" height="1"/><symbol id="s" viewBox="0 0 2 2"><rect width="2" height="2"/></symbol></defs>' +
        '<use xlink:href="#r" x="5" y="5"/><use href="#s" x="1" y="1" width="4" height="4"/>',
    ),
  );
  const corners = paths.map((p) => ends(p.commands));
  assert.deepEqual(corners[0], [
    [10, 20],
    [10, 22],
    [6, 22],
    [6, 20],
  ]);
  assert.deepEqual(corners[1], [
    [10, 0],
    [10, 1],
    [9, 1],
    [9, 0],
  ]);
  assert.deepEqual(corners[2], [
    [0, 0],
    [1, 0],
    [2, 1],
    [1, 1],
  ]);
  assert.deepEqual(corners[3], [
    [0, 0],
    [1, 1],
    [1, 2],
    [0, 1],
  ]);
  assert.deepEqual(corners[4][0], [5, 6]);
  assert.deepEqual(corners[5][2], [2, 3]);
  // viewBox 10x10 in a 20x10 viewport, xMidYMid meet: scale 1, centred horizontally (offset 5).
  assert.deepEqual(corners[6], [
    [15, 10],
    [25, 10],
    [25, 20],
    [15, 20],
  ]);
  assert.deepEqual(corners[7][0], [5, 5]);
  // The symbol's 2x2 viewBox fills the use's 4x4 viewport at (1, 1).
  assert.deepEqual(corners[8], [
    [1, 1],
    [5, 1],
    [5, 5],
    [1, 5],
  ]);
  assert.equal(paths.length, 9, 'defs and symbols draw only through use');
});

test('SVG fill rules: evenodd by parity, nonzero by winding, toShapes flipY', () => {
  const outer = 'M0 0 H10 V10 H0 Z',
    same = 'M2 2 H8 V8 H2 Z',
    opposite = 'M2 2 V8 H8 V2 Z';
  const { paths } = parseSVG(
    svg(
      `<path fill-rule="evenodd" d="${outer} ${same}"/><path d="${outer} ${same}"/><path d="${outer} ${opposite}"/>` +
        `<path style="fill-rule: evenodd" d="${outer} ${same} M4 4 H6 V6 H4 Z"/>`,
    ),
  );
  assert.deepEqual(
    paths.map((p) => p.toShapes().map((s) => s.holes.length)),
    [[1], [0], [1], [1, 0]],
  );
  const [flipped] = paths[0].toShapes({ flipY: true });
  assert.deepEqual(bounds(flipped), [0, -10, 10, 0]);
  assert.deepEqual(bounds(flipped.holes[0]), [2, -8, 8, -2]);
});

test('SVG styles: colours, opacity, inheritance, <style> rules, currentColor, gradients, display and visibility', () => {
  const { paths, warnings } = parseSVG(
    svg(
      '<style>/* rules */ .blue { fill: blue } #big { stroke: #00ff00; stroke-width: 3 } rect.half { fill-opacity: 50% }' +
        ' g > rect { fill: red } @media print { rect { fill: red } }</style>' +
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" style="stop-color: #0000ff"/></linearGradient>' +
        '<linearGradient id="h" xlink:href="#g"/></defs>' +
        '<rect fill="#f00" width="1" height="1"/>' +
        '<rect fill="rgb(0, 51, 100%)" width="1" height="1"/>' +
        '<rect style="fill: hsl(120, 100%, 50%); fill-opacity: 0.5" width="1" height="1"/>' +
        '<g opacity="0.5" fill="#0f08" stroke="black" stroke-width="2"><rect fill-opacity="0.5" width="1" height="1"/></g>' +
        '<rect class="blue half" id="big" fill="red" width="1" height="1"/>' +
        '<g color="purple"><rect fill="currentColor" stroke="currentColor" stroke-linejoin="round" stroke-linecap="square" stroke-miterlimit="8" width="1" height="1"/></g>' +
        '<rect fill="none" fill-rule="evenodd" width="1" height="1"/>' +
        '<rect fill="url(#h)" width="1" height="1"/>' +
        '<rect fill="url(#missing) yellow" width="1" height="1"/>' +
        '<rect display="none" width="1" height="1"/><g style="display:none"><rect width="1" height="1"/></g>' +
        '<g visibility="hidden"><rect width="1" height="1"/><rect visibility="visible" id="shown" width="1" height="1"/></g>' +
        '<text>hi</text><image href="a.png"/>',
    ),
  );
  const fills = paths.map((p) => p.fill?.map((v) => Math.round(v * 1000) / 1000));
  assert.deepEqual(fills, [
    [1, 0, 0],
    [0, 0.2, 1],
    [0, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0.502, 0, 0.502],
    undefined,
    [0.5, 0, 0.5],
    [1, 1, 0],
    [0, 0, 0],
  ]);
  assert.equal(paths[2].fillOpacity, 0.5);
  // Group opacity 0.5 x fill-opacity 0.5 x colour alpha 0x88.
  assert.equal(round(paths[3].fillOpacity), round(0.25 * (0x88 / 255)));
  assert.deepEqual(paths[3].stroke, [0, 0, 0]);
  assert.equal(paths[3].strokeOpacity, 0.5);
  assert.equal(paths[3].strokeWidth, 2);
  // The style rule beats the presentation attribute; class, id and compound selectors all apply.
  assert.equal(paths[4].fillOpacity, 0.5);
  assert.deepEqual(paths[4].stroke, [0, 1, 0]);
  assert.equal(paths[4].strokeWidth, 3);
  assert.deepEqual(paths[5].stroke, paths[5].fill);
  assert.equal(paths[5].strokeLineJoin, 'round');
  assert.equal(paths[5].strokeLineCap, 'square');
  assert.equal(paths[5].strokeMiterLimit, 8);
  assert.equal(paths[6].fill, null);
  assert.equal(paths[6].fillRule, 'evenodd');
  assert.equal(paths[9].id, 'shown');
  assert.equal(paths.length, 10, 'display none and visibility hidden are not drawn');
  for (const pattern of [/selector "g > rect"/, /@media/, /gradient #h/, /url\(#missing\)/, /<text>/, /<image>/])
    assert.ok(
      warnings.some((w) => pattern.test(w)),
      `warning ${pattern}`,
    );
});

test('SVG strokes: butt, square and round caps; miter, bevel and round joins; miter limit; transforms', () => {
  const area = (attributes, d = 'M0 0 L10 0', options) =>
    strokeArea(
      parseSVG(
        svg(`<path fill="none" stroke="black" stroke-width="2" ${attributes} d="${d}"/>`),
      ).paths[0].toStrokeGeometry(options),
    );
  const geometry = (attributes, d = 'M0 0 L10 0', options) =>
    parseSVG(
      svg(`<path fill="none" stroke="black" stroke-width="2" ${attributes} d="${d}"/>`),
    ).paths[0].toStrokeGeometry(options);
  // Area of a regular n-gon inscribed in a circle of radius r: how round parts are tessellated.
  const ngon = (n, r = 1) => (n / 2) * r * r * Math.sin((2 * Math.PI) / n);
  const corner = 'M0 0 L10 0 L10 10';
  // [attributes, d, options, true covered (union) area, the area of the tessellated union]
  const cases = [
    ['', undefined, undefined, 20, 20],
    ['stroke-linecap="square"', undefined, undefined, 24, 24],
    ['stroke-linecap="round"', undefined, { divisions: 64 }, 20 + Math.PI, 20 + ngon(256)],
    // Two 10 x 2 bodies overlapping in a unit square, plus the 1 x 1 miter corner.
    ['', corner, undefined, 40, 40],
    ['stroke-linejoin="bevel"', corner, undefined, 39.5, 39.5],
    ['stroke-linejoin="round"', corner, { divisions: 64 }, 39 + Math.PI / 4, 39 + ngon(256) / 4],
    // The miter ratio of a right angle is sqrt(2) > 1, so the join falls back to a bevel.
    ['stroke-miterlimit="1"', corner, undefined, 39.5, 39.5],
    ['', 'M0 0 H10 V10 H0 Z', undefined, 80, 80],
    ['transform="scale(3 1)"', undefined, undefined, 60, 60],
    ['', undefined, { width: 4 }, 40, 40],
  ];
  for (const [attributes, d, options, union, tessellated] of cases) {
    const g = geometry(attributes, d, options);
    const label = `${attributes || 'default'} ${d ?? ''} ${JSON.stringify(options ?? {})}`;
    // Measured by sampling, so it does not depend on how the pieces are cut.
    const covered = coveredArea(g);
    assert.ok(Math.abs(covered - union) <= 0.01 * union, `${label}: covered ${covered}, expected ${union}`);
    // The pieces tile the stroke without overlap: their areas add up to the union exactly.
    const { area: sum, ccw } = strokeArea(g);
    assert.ok(Math.abs(sum - tessellated) < 1e-4, `${label}: triangle areas ${sum}, expected ${tessellated}`);
    assert.ok(ccw, `${label}: every triangle faces +z`);
  }
  // A full reversal with a round join draws a half disc beyond the turning point.
  const reversed = geometry('stroke-linejoin="round"', 'M0 0 L10 0 L5 0', { divisions: 64 });
  assert.ok(Math.abs(coveredArea(reversed) - (20 + Math.PI / 2)) < 0.01 * 21.6);
  assert.ok(Math.abs(Math.max(...reversed.positions.filter((_, i) => i % 3 === 0)) - 11) < 1e-6);
  // Zero-length subpaths draw only their caps: a disc, an axis-aligned square, or nothing for butt.
  assert.ok(
    Math.abs(strokeArea(geometry('stroke-linecap="round"', 'M5 5 L5 5', { divisions: 64 })).area - ngon(256)) < 1e-4,
  );
  assert.ok(Math.abs(strokeArea(geometry('stroke-linecap="square"', 'M5 5 Z')).area - 4) < 1e-9);
  assert.equal(geometry('', 'M5 5 L5 5').positions.length, 0);
  assert.equal(geometry('stroke-linecap="round"', 'M5 5').positions.length, 0, 'a lone moveto draws nothing');
  const round = area('stroke-linecap="round"', 'M0 0 L10 0', { divisions: 64 });
  assert.ok(round.ccw, 'every triangle faces +z');
  assert.equal(area('stroke-width="0"').area, 0);
  const flipped = parseSVG(svg('<path stroke="red" d="M0 0 L10 0 L10 10"/>')).paths[0].toStrokeGeometry({
    flipY: true,
  });
  assert.ok(strokeArea(flipped).ccw, 'flipped strokes still face +z');
  assert.ok(Math.max(...flipped.positions.filter((_, i) => i % 3 === 1)) <= 0.5 + 1e-9);
  assert.throws(() => parseSVG(svg('<path d="M0 0 L1 1"/>')).paths[0].toStrokeGeometry({ divisions: 0 }), RangeError);
});

test('SVG input: bytes, root size and viewBox, malformed documents', () => {
  const loaded = parseSVG(
    new TextEncoder().encode(svg('<path d="M0 0 L1 0 L1 1 Z"/>', 'width="2in" height="10mm" viewBox="0 0 4 2"')),
  );
  assert.deepEqual(loaded.viewBox, [0, 0, 4, 2]);
  assert.equal(loaded.width, 192);
  assert.equal(round(loaded.height), round(10 * (96 / 25.4)));
  assert.throws(
    () => parseSVG('<html></html>'),
    (e) => e instanceof LoaderError && e.code === 'header',
  );
  assert.throws(
    () => parseSVG('<svg><g></svg>'),
    (e) => e instanceof LoaderError && e.code === 'syntax',
  );
  const selfUse = parseSVG(svg('<g id="a"><use href="#a"/><rect width="1" height="1"/></g>'));
  assert.equal(selfUse.paths.length, 2);
  assert.ok(selfUse.warnings.some((w) => /refers to itself/.test(w)));
});

test('SVG cascade, switch, use cycles, unapplied features and the command limit', () => {
  const { paths, warnings } = parseSVG(
    svg(
      '<style>#a { fill: lime } .c { fill: red } rect { fill: blue } .c.d { fill: navy }</style>' +
        '<rect id="a" class="c" fill="yellow" width="1" height="1"/><rect class="c d" width="1" height="1"/>' +
        '<rect class="c" style="fill: white !important" width="1" height="1"/>' +
        '<switch><g requiredExtensions="urn:x"><rect width="1" height="1"/></g><circle r="1"/><ellipse rx="1" ry="1"/></switch>' +
        '<g id="p"><use href="#q"/></g><g id="q"><use href="#p"/></g>' +
        '<rect clip-path="url(#c)" stroke-dasharray="1 1" width="1" height="1"/>' +
        '<use href="other.svg#x"/>',
    ),
  );
  // id beats class beats type beats the presentation attribute; the style attribute beats them all.
  assert.deepEqual(
    paths.slice(0, 3).map((p) => p.fill),
    [
      [0, 1, 0],
      [0, 0, 128 / 255],
      [1, 1, 1],
    ],
  );
  // switch draws only its first child whose conditions hold.
  assert.deepEqual(
    paths.slice(3, -1).map((p) => p.element),
    ['circle'],
  );
  assert.equal(paths.length, 5, 'the use cycle draws nothing');
  for (const pattern of [/refers to itself/, /clip-path/, /stroke-dasharray/, /"other\.svg#x"/])
    assert.ok(
      warnings.some((w) => pattern.test(w)),
      `warning ${pattern}`,
    );
  assert.throws(
    () => parseSVG(svg(`<path d="M0 0${'h1'.repeat(4_000_001)}"/>`)),
    (e) => e instanceof LoaderError && e.code === 'limit',
  );
});

test('SVG arcs: rotated ellipses keep every piece end on the ellipse and end exactly on the target', () => {
  const [path] = parseSVG(svg('<path d="M10 0 A20 10 30 1 1 0 10"/>')).paths;
  const pieces = path.commands.filter((c) => c[0] === 'C');
  assert.ok(pieces.length >= 2 && pieces.length <= 4);
  assert.deepEqual(pieces.at(-1).slice(-2), [0, 10]);
  // Recover the centre from the first three end points' common distance in the ellipse frame.
  const phi = (30 * Math.PI) / 180;
  const frame = ([x, y], [cx, cy]) => {
    const dx = x - cx,
      dy = y - cy;
    return (
      ((Math.cos(phi) * dx + Math.sin(phi) * dy) / 20) ** 2 + ((-Math.sin(phi) * dx + Math.cos(phi) * dy) / 10) ** 2
    );
  };
  // F.6.5 centre for this arc, computed independently.
  const hx = 5,
    hy = -5,
    px = Math.cos(phi) * hx + Math.sin(phi) * hy,
    py = -Math.sin(phi) * hx + Math.cos(phi) * hy;
  // large-arc = sweep, so the centre takes the negative root.
  const k = -Math.sqrt((400 * 100 - 400 * py * py - 100 * px * px) / (400 * py * py + 100 * px * px));
  const qx = (k * 20 * py) / 10,
    qy = (-k * 10 * px) / 20;
  const centre = [Math.cos(phi) * qx - Math.sin(phi) * qy + 5, Math.sin(phi) * qx + Math.cos(phi) * qy + 5];
  for (const c of pieces) assert.ok(Math.abs(frame(c.slice(-2), centre) - 1) < 1e-9);
});

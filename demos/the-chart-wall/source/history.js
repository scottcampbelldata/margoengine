import { Lines, Line } from '@margoengine/lines';
import { axisScale } from '@margoengine/sciviz/maths';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import history from './tools/history.json';
import { date, fromYear, untilYear, methods } from './archive.mjs';

const namespace = 'http://www.w3.org/2000/svg';
const names = [1992, 2000, 2008, 2016, 2024];
const scale = axisScale('date', date(fromYear));
const domain = scale.forward(date(untilYear));
const plotTheme = { background: '#fcfaf2', axis: '#89907e', grid: '#deddd0', text: '#424a3e' };
const margins = { left: 66, right: 25, top: 33, bottom: 50 };

export function historySlice(cutoff) {
  const selected = history.slice(0, cutoff - fromYear + 1);
  let total = 0, plotted = 0, peak = 0, peakYear = fromYear;
  for (const [i, [transit, velocity, other, orbit]] of selected.entries()) {
    const yearly = transit + velocity + other;
    total += yearly;
    plotted += orbit;
    if (yearly > peak) {
      peak = yearly;
      peakYear = fromYear + i;
    }
  }
  return { cutoff, total, plotted, peak, peakYear, selected };
}

function layout(width, height, snapshot) {
  const plot = [margins.left, margins.top, width - margins.right, height - margins.bottom];
  const [left, top, right, bottom] = plot;
  const x = year => left + (right - left) * scale.forward(date(year)) / domain;
  const y = level => bottom - (bottom - top) * level / 1600;
  const ticks = {
    x: names.map(year => [x(year), String(year)]),
    y: [0, 500, 1000, 1500].map(value => [y(value), String(value)]),
  };
  const series = methods.map((_, method) => snapshot.selected.map((row, index) => [x(fromYear + index), y(row[method])]));
  return { plot, ticks, series };
}

function svgFor(width, height, view) {
  const doc = document.implementation.createDocument(namespace, 'svg');
  const root = doc.documentElement;
  function add(parent, tag, attrs, text) {
    const node = doc.createElementNS(namespace, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    parent.append(node);
    return node;
  }
  root.setAttribute('width', width);
  root.setAttribute('height', height);
  root.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  add(root, 'rect', { width, height, fill: plotTheme.background });
  const [left, top, right, bottom] = view.plot;
  const line = (ax, ay, bx, by, color, w, parent = root) =>
    add(parent, 'path', { d: 'M' + ax + ' ' + ay + 'L' + bx + ' ' + by, stroke: color, 'stroke-width': w });
  const text = (x, y, label, attrs = {}) => add(root, 'text', { x, y, fill: plotTheme.text, 'font-family': 'Segoe UI, Arial, sans-serif',
    'font-size': 12, 'dominant-baseline': 'central', 'text-anchor': 'middle', ...attrs }, label);
  for (const [x, label] of view.ticks.x) {
    line(x, top, x, bottom, plotTheme.grid, .85);
    line(x, bottom, x, bottom - 3, plotTheme.axis, 1.1);
    text(x, bottom + 14, label);
  }
  for (const [y, label] of view.ticks.y) {
    line(left, y, right, y, plotTheme.grid, .85);
    line(left, y, left + 3, y, plotTheme.axis, 1.1);
    text(left - 8, y, label, { 'text-anchor': 'end' });
  }
  add(root, 'rect', { x: left, y: top, width: right-left, height: bottom-top, stroke: plotTheme.axis, 'stroke-width': 1.1, fill: 'none' });
  const definitions = add(root, 'defs', {});
  const clip = add(definitions, 'clipPath', { id: 'discovery-plot' });
  add(clip, 'rect', { x: left, y: top, width: right-left, height: bottom-top });
  const traces = add(root, 'g', { 'clip-path': 'url(#discovery-plot)' });
  for (const [i, points] of view.series.entries()) {
    const method = methods[i];
    add(traces, 'polyline', { points: points.map(point => point.map(n => n.toFixed(2)).join(',')).join(' '),
      stroke: method.color, 'stroke-width': method.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' });
  }
  const middle = (top + bottom) / 2;
  text((left + right) / 2, bottom + 32, 'Discovery year', { 'font-weight': 600 });
  text(14, middle, 'Planet count', { 'font-weight': 600, transform: 'rotate(-90 14 ' + middle + ')' });
  [left-4, left+53, left+151].forEach((x, i) => {
    line(x, 13, x+15, 13, methods[i].color, 3);
    text(x+20, 13, methods[i].name, { 'text-anchor': 'start', 'font-size': 11 });
  });
  return new XMLSerializer().serializeToString(root);
}

export async function openHistory(canvas, options) {
  const { signal, fail } = options;
  const force = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const known = force || !navigator.gpu;
  const loadCompat = async () => {
    const compat = await import('@margoengine/webgl2-compat');
    return { install: () => compat.install({ force, signal }) };
  };
  if (known) await (await loadCompat()).install();
  let layer, frame, grid, traces;
  const engine = await autoEngine(canvas, async target => {
    target.scene.background = plotTheme.background;
    target.camera.position = [0,0,3];
    layer = Lines.attach(target);
    grid = layer.add(new Line({ positions: [], color: plotTheme.grid, mode: 'segments', width: .85 }));
    frame = layer.add(new Line({ positions: [], color: plotTheme.axis, mode: 'segments', width: 1.1 }));
    traces = methods.map(({color,width}) => layer.add(new Line({ positions: [], color, width, cap: 'round', join: 'round' })));
  }, { loadCompat, signal, backend: known ? 'webgpu' : undefined,
    exactSize: true, antialias: false, capacity: 24, startupTimeout: 8000, camera:{near:.05,far:10} });
  engine.onError = fail;
  canvas = engine.canvas;
  const chrome = document.createElement('div');
  chrome.className = 'history-axes';
  canvas.after(chrome);
  let view, width, height, selected;
  const nodes = {};
  function label(token, x, y, text) {
    const element = nodes[token] ??= document.createElement('span');
    if (!element.isConnected) chrome.append(element);
    element.className = token[0] === 'X' ? 'x' : token[0] === 'Y' ? 'y' : token;
    element.textContent = text;
    element.style.left = x+'px';
    element.style.top = y+'px';
  }
  const methodsLegend = document.createElement('div');
  methodsLegend.className = 'history-legend';
  methodsLegend.setAttribute('aria-label','Legend');
  for (const method of methods) {
    const row = document.createElement('span'), ink = document.createElement('i');
    ink.style.background = method.color;
    row.append(ink, document.createTextNode(method.name));
    methodsLegend.append(row);
  }
  chrome.append(methodsLegend);
  const hover = document.createElement('div');
  hover.className = 'history-hover';
  hover.hidden = true;
  chrome.append(hover);
  canvas.addEventListener('pointerleave', () => { hover.hidden = true; }, { signal });
  canvas.addEventListener('pointermove', event => {
    if (!view || event.pointerType === 'touch') return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const [left, top, right, bottom] = view.plot;
    const hit = Math.round((x-left)/(right-left)*(untilYear-fromYear));
    const row = selected?.[hit];
    hover.hidden = !row || y < top || y > bottom;
    if (hover.hidden) return;
    hover.textContent = (fromYear+hit)+' · '+methods.map((method,i)=>method.name+' '+row[i]).join(' · ');
    hover.style.left = Math.min(x+9,width-hover.offsetWidth-4)+'px';
    hover.style.top = Math.max(3,y-27)+'px';
  }, { signal });
  async function render(snapshot) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w !== width || h !== height) {
      width = w;
      height = h;
      const dpr = Math.min(1.7, Math.max(1, devicePixelRatio));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const camera = engine.camera, z = camera.far-camera.near;
      camera.project = (out, _, webgpu) => {
        out[0] = 2/w;
        out[5] = 2/h;
        out[10] = webgpu ? 1/z : -2/z;
        out[14] = webgpu ? camera.far/z : -(camera.far+camera.near)/z;
        out[15] = 1;
      };
    }
    view = layout(w,h,snapshot);
    selected = snapshot.selected;
    hover.hidden = true;
    const points = (array,z) => array.flatMap(([x,y]) => [x-w/2,h/2-y,z]);
    const [left,top,right,bottom] = view.plot;
    const guides = [], border = [[left,top],[right,top],[right,top],[right,bottom],[right,bottom],[left,bottom],[left,bottom],[left,top]];
    for (const [i, [x, text]] of view.ticks.x.entries()) {
      guides.push([x,top],[x,bottom]);
      border.push([x,bottom],[x,bottom-3]);
      label('X'+i, x, bottom+14, text);
    }
    for (const [i, [y, text]] of view.ticks.y.entries()) {
      guides.push([left,y],[right,y]);
      border.push([left,y],[left+3,y]);
      label('Y'+i, left-8, y, text);
    }
    label('x-title',(left+right)/2,bottom+32,'Discovery year');
    label('y-title',14,(top+bottom)/2,'Planet count');
    grid.setPositions(points(guides,0));
    frame.setPositions(points(border,.001));
    for (const [i, trace] of traces.entries()) trace.setPositions(points(view.series[i],.002+i*.0001));
    engine.render({delta:0});
    await engine.gpu.queue.onSubmittedWorkDone();
    signal.throwIfAborted();
  }
  return {
    canvas,
    renderer: engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu',
    render,
    export: () => svgFor(width,height,view),
    dispose: () => { chrome.remove(); engine.dispose(); },
  };
}

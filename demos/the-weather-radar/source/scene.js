import { Geometry, PbrMaterial } from '@margoengine/core';
import { beam, coordinates, elevationExaggeration, extent, geodesic, palette, readExtra, reflectivity } from './radar-data.js';

const rad = Math.PI / 180;
const bins = 35;
const colors = Array.from({length:bins}, (_, i) => {
  const p = i * (palette.length - 1) / (bins - 1);
  const lo = Math.floor(p), hi = Math.min(palette.length - 1, lo + 1);
  const rgb = [1, 3, 5].map(offset => {
    const a = parseInt(palette[lo].slice(offset, offset + 2), 16);
    const b = parseInt(palette[hi].slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * (p - lo)).toString(16).padStart(2, '0');
  });
  return new PbrMaterial({color:'#' + rgb.join(''), roughness:.86});
});

function sheet(points, indices) {
  const normals = new Float32Array(points.length);
  for (let p = 1; p < normals.length; p += 3) normals[p] = 1;
  return new Geometry(points, normals, indices);
}

function position([east, height, north]) {
  return [east / extent, height * elevationExaggeration / extent, -north / extent];
}

function attach(engine, shape, material, name) {
  const mesh = engine.createMesh().setGeometry(shape).setMaterial(material);
  mesh.name = name;
  return mesh;
}

function arc(x, z, r, y, a) {
  return [x + r * Math.sin(a), y, z - r * Math.cos(a)];
}

function rings(specification) {
  const points = [], indices = [];
  for (const [inner,outer,y,from=0,to=360] of specification) {
    const segments = Math.max(1, Math.ceil((to - from) / 2));
    for (let i = 0; i < segments; i++) {
      const a = (from + (to - from) * i / segments) * rad;
      const b = (from + (to - from) * (i + 1) / segments) * rad;
      const base = points.length / 3;
      points.push(...arc(0,0,inner,y,a), ...arc(0,0,outer,y,a), ...arc(0,0,outer,y,b), ...arc(0,0,inner,y,b));
      indices.push(base,base+1,base+2,base,base+2,base+3);
    }
  }
  return sheet(points, indices);
}

function floor(engine) {
  const deck = new PbrMaterial({color:'#1b3039',roughness:.8});
  const rim = new PbrMaterial({color:'#655d4b',roughness:.7});
  const line = new PbrMaterial({color:'#47626a',roughness:.85});
  const marker = new PbrMaterial({color:'#a59c82',roughness:.86});
  attach(engine, rings([[.0001,1.018,-.013]]), deck, 'Ground range disk');
  attach(engine, rings([[1.011,1.018,-.009],[.986,.989,-.009]]), rim, 'Outer instrument rim');
  attach(engine, rings([10,20,30,40].map(distance => [(distance-.09)/extent,(distance+.09)/extent,-.008])), line, '10 km range rings');
  const graduations = Array.from({length:72}, (_,i) => [i%6===0?.955:.972,.984,-.007,i*5-.12,i*5+.12]);
  attach(engine, rings(graduations), marker, 'Five degree bearing graduations');
  const spokes = Array.from({length:12}, (_,i) => [.039,.988,-.007,i*30-.13,i*30+.13]);
  attach(engine, rings(spokes), line, 'Thirty degree bearing grid');
}

function batches(grid, sweep) {
  const {bearingCount, gateCount, firstMetres, gateStepMetres} = grid;
  const step = gateStepMetres / 1000, begin = firstMetres / 1000 - step * .5;
  const locations = [];
  const stride = gateCount + 1;
  for (let boundary = 0; boundary <= bearingCount; boundary++) {
    const prior = (boundary + bearingCount - 1) % bearingCount;
    const next = boundary % bearingCount;
    const elevation = (sweep.elevations[prior] + sweep.elevations[next]) * .5;
    const azimuth = boundary * 360 / bearingCount - .5;
    for (let gate = 0; gate <= gateCount; gate++) {
      locations.push(position(coordinates(begin + step * gate, elevation, azimuth)));
    }
  }
  const grouped = Array.from({length:bins}, () => ({points:[], indices:[]}));
  for (let azimuth = 0; azimuth < bearingCount; azimuth++) {
    for (let gate = 0; gate < gateCount; gate++) {
      const value = reflectivity(grid, sweep, azimuth, gate);
      if (!(value >= 5)) continue;
      const bucket = Math.min(bins - 1, Math.floor((value - 5) * (bins - 1) / 65));
      const {points, indices} = grouped[bucket];
      const a = azimuth * stride + gate, b = a + stride;
      const vertex = points.length / 3;
      points.push(...locations[a], ...locations[a+1], ...locations[b+1], ...locations[b]);
      indices.push(vertex, vertex+1, vertex+2, vertex, vertex+2, vertex+3);
    }
  }
  return grouped.map(({points,indices}) => points.length ? sheet(points,indices) : null);
}

function setCamera(engine, view) {
  const {camera} = engine;
  const plan = view === 'plan';
  camera.position = plan ? [-.09,4,-.02] : [1.63,1.78,2.55];
  camera.target = plan ? [-.09,0,-.02] : [-.10,.22,-.03];
  camera.up = plan ? [0,0,-1] : [0,1,0];
  camera.project = (out, aspect, gpu) => {
    const half = plan ? 1.14 : 1.15;
    const width = half * Math.max(1, aspect), height = half * Math.max(1, 1 / aspect);
    out[0] = 1 / width;
    out[5] = 1 / height;
    const d = camera.far - camera.near;
    out[10] = (gpu ? 1 : 2) / d;
    out[14] = (gpu ? camera.far : camera.far + camera.near) / d;
    out[15] = 1;
  };
}

function marker(element, camera, point) {
  const m = camera.matrix;
  const [x,y,z] = point;
  element.style.left = 50 * (1 + m[0]*x + m[4]*y + m[8]*z + m[12]) + '%';
  element.style.top = 50 * (1 - m[1]*x - m[5]*y - m[9]*z - m[13]) + '%';
}

function clock(sweep) {
  return sweep.start.slice(11, 19) + '–' + sweep.end.slice(11, 19) + ' UTC';
}

export async function open({engine, grid, fit, status, notice, signal, fail}) {
  const {canvas} = engine;
  const elevation = document.querySelector('#elevation');
  const observed = document.querySelector('#observed');
  const result = document.querySelector('#return');
  const angles = [...document.querySelectorAll('[data-cut]')];
  const views = [...document.querySelectorAll('[data-view]')];
  const compass = document.querySelector('.coordinates');
  const probeLabel = document.querySelector('#probe-label');
  const annotation = document.querySelector('.map-annotations');
  const rangeLabels = [...document.querySelectorAll('[data-range]')];
  const places = [['station',[0,0,0]], ['moore',[35.3395,-97.4867]], ['city',[35.4676,-97.5164]]]
    .map(([id,where]) => {
      const [east,north] = where.length === 3 ? [0,0] : geodesic(grid.latitude, grid.longitude, ...where);
      return [document.getElementById(id), position([east,0,north])];
    });
  const sweeps = new Map(grid.sweeps.map(sweep => [sweep.cut,sweep]));
  let cut = 1, view = 'plan', version = 0, probe;
  let extra, mapped, requested = false;
  const meshes = colors.map((material,i) => {
    const mesh = engine.createMesh().setMaterial(material);
    mesh.name = 'Reflectivity band ' + i;
    return mesh;
  });
  const cache = new Map();
  const renderer = engine.gpu.adapterInfo?.vendor === 'margo-webgl2' ? 'compatibility' : 'webgpu';
  canvas.dataset.renderer = renderer;
  engine.onError = fail;
  engine.scene.background = '#101b22';
  engine.lighting.direction[3] = 0.13;
  engine.lighting.radiance[3] = .9;
  floor(engine);
  setCamera(engine,view);

  function meshSweep() {
    if (view === 'grid') {
      meshes.forEach(mesh => mesh.setGeometry(null));
      return;
    }
    if (!cache.has(cut)) {
      if (cache.size >= 2) cache.delete(cache.keys().next().value);
      cache.set(cut,batches(grid,sweeps.get(cut)));
    }
    const shape = cache.get(cut);
    meshes.forEach((mesh,i) => mesh.setGeometry(shape[i]));
  }

  function measure() {
    const sweep = sweeps.get(cut);
    if (!probe) {
      result.value = view === 'plan' ? 'Tap a return to inspect it' :
        view === 'grid' ? 'Curvilinear resampling · 4× vertical scale' : 'Beam height shown at 4× scale';
      probeLabel.hidden = true;
      return;
    }
    const azimuth = probe.bearing, spacing = grid.gateStepMetres / 1000, start = grid.firstMetres / 1000;
    const tilt = sweep.elevations[azimuth];
    let gate = Math.round((probe.range - start) / spacing);
    gate = Math.round((gate * spacing + probe.range - beam(start + gate * spacing, tilt)[0] - start) / spacing);
    if (gate < 0 || gate >= grid.gateCount) {
      result.value = 'Outside the sampled gates';
      probeLabel.hidden = true;
      return;
    }
    const slant = start + gate * spacing;
    const echo = reflectivity(grid, sweep, azimuth, gate);
    result.value = (Number.isFinite(echo) ? echo.toFixed(1) + ' dBZ' : 'No return') +
      ' · ' + azimuth + '° · ' + slant.toFixed(1) + ' km · ' + beam(slant, tilt)[1].toFixed(2) + ' km high';
    marker(probeLabel, engine.camera, position(coordinates(slant, tilt, azimuth)));
    probeLabel.hidden = false;
  }

  function render() {
    engine.render({delta:0});
    for (const [element,p] of places) marker(element, engine.camera, p);
    for (const label of rangeLabels) marker(label, engine.camera, position(coordinates(+label.dataset.range, 0, 139)));
    measure();
  }

  function syncButtons() {
    for (const button of angles) {
      button.disabled = !sweeps.get(Number(button.dataset.cut)).gates || requested;
      button.setAttribute('aria-pressed', String(+button.dataset.cut === cut));
    }
    for (const button of views) {
      button.disabled = requested;
      button.setAttribute('aria-pressed',String(button.dataset.view === view));
    }
  }

  function startExtra() {
    if (extra) return extra;
    extra = readExtra(grid, signal).then(() => { if (!signal.aborted) syncButtons(); return grid; });
    extra.catch(() => {
      if (!signal.aborted && view !== 'grid') result.value = 'Additional sweeps could not be opened.';
    });
    return extra;
  }

  async function shown(mark) {
    const current = ++version;
    engine.render({delta:0});
    await engine.gpu.queue.onSubmittedWorkDone();
    signal.throwIfAborted();
    if (current !== version) return;
    render();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    signal.throwIfAborted();
    if (current !== version) return;
    const sweep = sweeps.get(cut);
    canvas.dataset.cut = String(cut);
    canvas.dataset.view = view;
    canvas.dataset.peak = String(sweep.peak);
    performance.mark(mark);
  }

  async function select(next) {
    if (next === cut) return;
    cut = next;
    const sweep = sweeps.get(cut);
    elevation.value = sweep.elevation.toFixed(2) + '°';
    observed.textContent = clock(sweep);
    if (view === 'grid') mapped.select(cut);
    else meshSweep();
    syncButtons();
    await shown('weather-sweep-applied');
  }

  async function cameraView(next) {
    if (next === view || requested) return;
    if (next === 'grid' && !mapped) {
      requested = true;
      performance.mark('weather-grid-requested');
      syncButtons();
      result.value = 'Preparing the curved scan grid…';
      try {
        const load = import('./scan-grid.js');
        await startExtra();
        performance.mark('weather-grid-data');
        const {createScanGrid} = await load;
        performance.mark('weather-grid-module');
        signal.throwIfAborted();
        mapped = await createScanGrid(engine,grid,signal);
        performance.mark('weather-grid-created');
      } catch (reason) {
        if (signal.aborted) return;
        result.value = 'The scan grid could not be rendered on this device.';
        canvas.dataset.gridError = reason.message;
        return;
      } finally {
        requested = false;
        if (!signal.aborted) syncButtons();
      }
    }
    view = next;
    probe = undefined;
    compass.hidden = view !== 'plan';
    for (const label of rangeLabels) label.hidden = view !== 'plan';
    annotation.hidden = view === 'grid';
    setCamera(engine,view);
    mapped?.show(view === 'grid');
    if (view === 'grid') mapped.select(cut);
    meshSweep();
    syncButtons();
    await shown('weather-view-applied');
  }

  for (const button of angles) button.addEventListener('click', () => select(+button.dataset.cut).catch(fail), {signal});
  for (const button of views) button.addEventListener('click', () => cameraView(button.dataset.view).catch(fail), {signal});
  canvas.addEventListener('click', event => {
    if (view !== 'plan') return;
    const rect = canvas.getBoundingClientRect(), m = engine.camera.matrix;
    const east = (((event.clientX - rect.left) / rect.width * 2 - 1) - m[12]) / m[0] * extent;
    const north = -((1 - (event.clientY - rect.top) / rect.height * 2) - m[13]) / m[9] * extent;
    probe = {bearing:(360 + Math.round(Math.atan2(east,north) / rad)) % 360, range:Math.hypot(east,north)};
    measure();
    canvas.dataset.probe = result.value;
  }, {signal});
  canvas.addEventListener('keydown', event => {
    if (view !== 'plan' || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    probe ??= {bearing:275,range:18};
    const bearingChange = {ArrowLeft:-3,ArrowRight:3}[event.key] ?? 0;
    const rangeChange = {ArrowUp:1,ArrowDown:-1}[event.key] ?? 0;
    probe.bearing = (360 + probe.bearing + bearingChange) % 360;
    probe.range = Math.max(2.2, Math.min(47, probe.range + rangeChange));
    measure();
    canvas.dataset.probe = result.value;
  }, {signal});
  const observer = new ResizeObserver(() => { if (fit()) render(); });
  observer.observe(canvas);
  signal.addEventListener('abort', () => { observer.disconnect(); mapped?.dispose(); }, {once:true});
  meshSweep();
  await shown('margo-first-usable-frame');
  notice.hidden = true;
  syncButtons();
  status.ready();
  const timer = setTimeout(startExtra, 720);
  signal.addEventListener('abort', () => clearTimeout(timer), {once:true});
}

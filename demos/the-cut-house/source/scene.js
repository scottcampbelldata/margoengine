import { box, Geometry, PbrMaterial } from '@margoengine/core';
import { sectionIFC } from '@margoengine/ifc/section';
import { buildOpaqueHouse } from './section-body.js';

const viewOptions = {
  cross: { min: -3.60, max: 4.85, value: 1.38, normal: [0,0,-1], name: 'Section offset' },
  plan: { min: .055, max: 6.31, value: 1.52, normal: [0,-1,0], name: 'Cut elevation' },
};
const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function capGeometry(cuts, normal) {
  const positions = [], normals = [], indices = [];
  for (const cut of cuts) {
    const base = positions.length / 3;
    for (let i = 0; i < cut.positions.length; i += 3) {
      positions.push(cut.positions[i], cut.positions[i+1], cut.positions[i+2]);
      normals.push(...normal);
    }
    for (const index of cut.indices) indices.push(base + index);
  }
  return new Geometry(positions,normals,indices);
}

function outlineGeometry(cuts, normal) {
  const positions = [], normals = [], indices = [];
  for (const { edges } of cuts) for (let i = 0; i < edges.length; i += 6) {
    const a = edges.subarray(i, i+3), b = edges.subarray(i+3, i+6);
    const x = b[0]-a[0], y = b[1]-a[1], z = b[2]-a[2];
    const direction = [normal[1]*z-normal[2]*y, normal[2]*x-normal[0]*z, normal[0]*y-normal[1]*x];
    const length = Math.hypot(...direction);
    if (length < 1e-6) continue;
    const side = direction.map((n) => n * .011 / length);
    const base = positions.length/3;
    for (const [end, sign] of [[a,-1],[a,1],[b,1],[b,-1]]) {
      for (let axis=0;axis<3;axis++) positions.push(end[axis] + side[axis]*sign + normal[axis]*.004);
      normals.push(...normal);
    }
    indices.push(base,base+1,base+2,base,base+2,base+3);
  }
  return new Geometry(positions,normals,indices);
}

function pedestalGeometry() {
  const levels = [[8.1,5.91,-.64],[8.1,5.91,-.19],[7.93,5.74,-.025]];
  const rings = levels.map(([x,z,y]) => [
    [-x,y,-z],[x,y,-z],[x,y,z],[-x,y,z],
  ]);
  const points=[], normals=[], indices=[];
  const face = (p,n) => {
    const start = points.length/3;
    for (const item of p) { points.push(...item); normals.push(...n); }
    indices.push(start,start+1,start+2,start,start+2,start+3);
  };
  const sides = [[0,0,-1],[1,0,0],[0,0,1],[-1,0,0]];
  for (let k=1;k<rings.length;k++) {
    for (let side=0;side<4;side++) {
      const a=rings[k-1], b=rings[k], next=(side+1)%4, normal=sides[side];
      face([a[side],b[side],b[next],a[next]],k===1 ? normal : [normal[0]*Math.SQRT1_2,Math.SQRT1_2,normal[2]*Math.SQRT1_2]);
    }
  }
  face(rings[2].slice().reverse(),[0,1,0]);
  face(rings[0],[0,-1,0]);
  return new Geometry(points,normals,indices);
}

function stage(engine) {
  const surface = (color, roughness) => new PbrMaterial({ color, roughness });
  const make = (g,m,p) => engine.createMesh().setGeometry(g).setMaterial(m).setPosition(p);
  const floor = make(box(170,.50,170),surface('#40554e',.89),[0,-.95,0]);
  const pedestal = make(pedestalGeometry(),surface('#798379',.72),[0,0,0]);
  const inset = surface('#bcb9a3',.72);
  const accent = surface('#aa8156',.56);
  make(box(15.9,.04,.062),inset,[0,-.17,5.93]);
  make(box(15.9,.04,.062),inset,[0,-.17,-5.93]);
  make(box(.040,.027,10.94),accent,[7.91,-.04,.02]);
  make(box(.040,.027,10.94),accent,[-7.91,-.04,.02]);
  const engraving = box(.028,.026,.15);
  for(let mark=-7;mark<=7;mark++)make(engraving,accent,[mark,-.014,4.92]);
  return { floor, pedestal };
}

export async function open({ engine, model, fit, status, notice, signal, fail }) {
  const { canvas } = engine;
  const select = document.querySelector('#element');
  const slider = document.querySelector('#section');
  const distance = document.querySelector('#distance');
  const name = document.querySelector('label[for="section"]');
  const counter = document.querySelector('#cut-count');
  const record = document.querySelector('#element-id');
  const buttons = [...document.querySelectorAll('[data-view]')];
  const chip = document.querySelector('.key');
  const products = new Map(model.products.map(product => [product.id,product]));
  let view = 'cross', selection, raf, cutList = '', lightingTimer, glass;
  let dirty = true, sentInput = false, fencing = false;

  engine.onError = fail;
  engine.scene.background = '#293c36';
  engine.lighting.direction.set([-4.6,7.2,5.7,3.95]);
  engine.lighting.radiance.set([1,.93,.83,.29]);
  engine.lighting.ambient.set([.75,.90,1]);
  const { floor, pedestal } = stage(engine);
  const sources = model.placements.map(({ element, geometry, matrix, color }) => ({
    element, geometry: model.geometries.get(geometry), matrix, color,
  }));
  const house = buildOpaqueHouse(engine,sources);
  const caps = engine.createMesh().setMaterial(new PbrMaterial({ color: '#f09735', roughness: .89 }));
  const edges = engine.createMesh().setMaterial(new PbrMaterial({ color: '#71431f', roughness: .86 }));

  function placeCamera() {
    const ratio = canvas.width / canvas.height;
    const plan = view === 'plan';
    const halfVertical = Math.max((plan ? 8.2 : 8.7) / ratio, plan ? 6.66 : 5.65);
    const d = halfVertical / Math.tan((plan ? 37 : 34) * Math.PI / 360);
    engine.camera.fov = plan ? 37 : 34;
    engine.camera.target = [0,plan ? 0 : 1.82,0];
    engine.camera.up = [0,1,0];
    if (plan) engine.camera.position = [d*.018,d*.984,d*.175];
    else engine.camera.position = [d*.32,1.82+d*.47,d*.826];
  }
  function pickElement(id) {
    selection = id;
    const product = products.get(id);
    record.value = product ? product.type + '  #' + id + ' · ' + product.globalId : '';
    canvas.dataset.selected = product ? String(id) : '';
  }
  function populateCut(ids) {
    const stamp = ids.join('/');
    if (stamp === cutList) return;
    cutList = stamp;
    const options = ids.map(id => {
      const product = products.get(id);
      return new Option(product ? product.tag + ' · ' + product.name : '#' + id, id);
    });
    select.replaceChildren(new Option('All cut elements',''),...options);
    select.disabled = ids.length === 0;
    if (ids.includes(selection)) select.value = String(selection);
    else pickElement(undefined);
  }
  function updateGlass(settings) {
    if (!glass) return;
    glass.clippingPlanes = settings ? [[...settings.normal, settings.value]] : [];
    glass.select(selection !== undefined && glass.elements.includes(selection) ? [selection] : []);
  }
  function updateGeometry() {
    const settings = viewOptions[view];
    const planes = settings ? [[...settings.normal, settings.value]] : [];
    const normal = settings ? settings.normal.map((n)=>-n) : [0,1,0];
    const cuts = settings ? sectionIFC(sources, planes, { signal }) : [];
    caps.setGeometry(capGeometry(cuts,normal));
    edges.setGeometry(outlineGeometry(cuts,normal));
    const ids = cuts.map(slice=>slice.element);
    ids.sort((a,b)=>{
      const wallFirst = id => products.get(id)?.type === 'IfcWall' ? 0 : 1;
      return wallFirst(a)-wallFirst(b)||a-b;
    });
    populateCut(ids);
    house.update(settings,selection);
    updateGlass(settings);
    counter.value = String(ids.length);
    chip.hidden = !settings;
    distance.value = settings ? fmt.format(settings.value) + ' m' : 'Open';
    if (settings) slider.setAttribute('aria-valuetext',settings.name + ' ' + fmt.format(settings.value) + ' meters');
    Object.assign(canvas.dataset, {
      view, offset: settings?.value ?? '',
      sections: ids.length, capTriangles: cuts.reduce((total,c)=>total+c.indices.length/3,0),
      cutSegments: cuts.reduce((total,c)=>total+c.edges.length/6,0),
    });
    dirty = false;
  }
  function draw() {
    raf = undefined;
    if (signal.aborted) return;
    try {
      if (dirty) updateGeometry();
      engine.render({ delta: 0 });
      if (sentInput && !fencing) {
        sentInput = false;
        fencing = true;
        engine.gpu.queue.onSubmittedWorkDone().then(() => {
          if (signal.aborted) return;
          fencing = false;
          performance.mark('cut-house-section-applied');
          if (sentInput) schedule();
        }).catch(fail);
      }
    }catch(reason){fail(reason);}
  }
  function schedule() {
    if (raf === undefined && !signal.aborted) raf = requestAnimationFrame(draw);
  }
  function changeMode(next) {
    view = next;
    for (const button of buttons) button.setAttribute('aria-pressed',String(button.dataset.view===view));
    const settings = viewOptions[view];
    slider.disabled = !settings;
    name.textContent = settings?.name ?? 'Section plane';
    if (settings) {
      slider.min = settings.min;
      slider.max = settings.max;
      slider.step = '.01';
      slider.value = settings.value;
    }
    placeCamera();
    dirty = true;
    schedule();
  }

  const rooms = model.products.filter(product => product.type === 'IfcSpace').map(product => {
    const text = document.createElement('li');
    text.textContent = product.tag + ' · ' + product.name + '  (#' + product.id + ')';
    return text;
  });
  document.querySelector('#rooms').replaceChildren(...rooms);

  placeCamera();
  updateGeometry();
  engine.render({ delta: 0 });
  await engine.gpu.queue.onSubmittedWorkDone();
  if (signal.aborted) return;
  for (const button of buttons) {
    button.disabled = false;
    button.addEventListener('click',()=>changeMode(button.dataset.view),{signal});
  }
  slider.disabled = false;
  slider.addEventListener('input',() => {
    viewOptions[view].value = Number(slider.value);
    dirty = true;
    sentInput = true;
    schedule();
  },{signal});
  select.addEventListener('change',()=>{
    pickElement(select.value ? Number(select.value) : undefined);
    dirty = true;
    schedule();
  },{signal});
  const observer = new ResizeObserver(()=>{if (fit()) {placeCamera(); schedule();}});
  observer.observe(canvas);
  signal.addEventListener('abort',()=>{
    observer.disconnect();
    clearTimeout(lightingTimer);
    if (raf!==undefined) cancelAnimationFrame(raf);
    glass?.dispose();
  },{once:true});
  canvas.dataset.renderer = engine.gpu.adapterInfo?.vendor==='margo-webgl2' ? 'compatibility' : 'webgpu';
  if (status.ready()) notice.hidden = true;
  performance.mark('margo-first-usable-frame');
  lightingTimer = setTimeout(async () => {
    try {
      const [{ Shadows }, { addGlass }] = await Promise.all([import('@margoengine/shadows'), import('./glass.js')]);
      if (signal.aborted) return;
      glass = addGlass(engine,model);
      updateGlass(viewOptions[view]);
      const shadows = Shadows.attach(engine, {
        resolution: 1024, cascades: 1, filter: 'soft', samples: 10, blockerSamples: 6, lightSize: .12,
        bounds: { min: [-8.2,-.72,-6], max: [8.2,6.55,6] },
      });
      shadows.add(floor, { castShadow: false });
      shadows.add(pedestal);
      for (const mesh of house.meshes) shadows.add(mesh);
      engine.render({ delta: 0 });
      await engine.gpu.queue.onSubmittedWorkDone();
      if (!signal.aborted) canvas.dataset.finish = 'studio-light';
    } catch (reason) { fail(reason); }
  }, 700);
}

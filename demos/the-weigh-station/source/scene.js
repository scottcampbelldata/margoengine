import { box } from '@margoengine/core';
import { margoError } from '@margoengine/core/extension';
import { applyQualityTier } from '@margoengine/quality';
import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';

const vertexShader = /* wgsl */ `
struct Paint {
  @builtin(position) clip: vec4f,
  @location(0) point: vec3f,
  @location(1) normal: vec3f,
  @location(2) @interpolate(flat) part: f32,
}
@vertex fn vertex(a: Attributes) -> Paint {
  let p = mesh.world * vec4f(a.position, 1.0);
  return Paint(camera.viewProjection * p, p.xyz, normalize(mesh.normal * a.normal), a.part);
}
@fragment fn fragment(i: Paint) -> @location(0) vec4f {
  let p = i.point;
  let n = normalize(i.normal);
  let look = normalize(camera.position-p);
  let window = normalize(vec3f(-.54,.70,.40));
  let softbox = normalize(vec3f(.73,.45,-.50));
  let lit = max(dot(n,window),0.0);
  let fill = max(dot(n,softbox),0.0);
  let specular = pow(max(dot(n,normalize(look+window)),0.0),26.0);
  let grazing = pow(1.0-max(0.0,dot(n,look)),3.0);
  var color = vec3f(.026,.034,.026);
  if (i.part < 2.5) {
    let aluminium = vec3f(.34,.37,.39);
    let steel = vec3f(.115,.160,.191);
    let copper = vec3f(.48,.193,.089);
    let base = select(select(aluminium,steel,i.part>.5),copper,i.part>1.5);
    let circle = length(p.xz);
    let turned = .955 + .038 * cos(circle*1470.0) + .007 * sin(p.y*3900.0 + circle*220.0);
    let brush = select(.97 + .03 * sin(p.y*1520.0),turned,n.y>.50);
    let reflection = pow(max(dot(reflect(-look,n),window),0.0),4.0);
    color = base * brush * (.40+.79*lit+.21*fill);
    color += vec3f(.74,.82,.91) * (.33*specular+.17*reflection+.18*grazing);
    color += vec3f(.24,.13,.029) * fill * .17;
  } else if (i.part < 3.5) {
    let p2 = p.xz * vec2f(9.6,11.0);
    let stageShadow = exp(-dot(p2,p2)*3.6);
    let groove = 1.0-smoothstep(.06,.13,abs(fract(p.x*108.0+.5)-.5));
    let cut = pow(max(0.0,cos(p.z*1880.0)),5.0);
    color = vec3f(.126,.145,.123)*(.80+.41*lit-.24*stageShadow-.16*groove-.032*cut);
    color += vec3f(.29,.35,.28)*.22*specular;
  } else if (i.part < 4.5) {
    let lift = exp(-p.x*p.x*22.0-p.z*p.z*9.0);
    let contact = exp(-p.x*p.x*110.0-p.z*p.z*135.0);
    color = vec3f(.033,.048,.039)*(.56+.67*lift-.40*contact);
    color += vec3f(.030,.039,.027)*specular*.46;
  } else if (i.part < 5.5) {
    color = vec3f(.38,.25,.09)*(.39+.65*lit+.40*specular);
  } else {
    color = vec3f(.93,.45,.075)*(.76+.24*lit);
  }
  return margoDisplay(vec4f(color,1));
}
`;

const byId = name => document.getElementById(name);
const canvas = byId('part');
const notice = byId('status');
const errorOutput = byId('error');
const status = demoStatus(document.body, notice, errorOutput);
const operations = byId('operations');
const buttons = [...operations.querySelectorAll('button')];
const reset = byId('reset');
const metal = byId('metal');
const densities = [2700,7850,8960];
const separator = ' · ';
const number = new Intl.NumberFormat(undefined, {maximumFractionDigits:2, minimumFractionDigits:2});
const controller = new AbortController();
const { signal } = controller;
const url = new URL('./assets/bodies.bin', import.meta.url);
const dataReady = fetch(url,{signal}).then(response => {
  if (!response.ok) throw new Error('The measured bodies could not load.');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
});
dataReady.catch(() => {});
const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
const defaults = { yaw: .66, tilt: .63 };
let engine, raw, paint, states, casting, observer;
let witness = [];
let requestedMetal = 0;
let drawnMetal = -1;
let yaw = defaults.yaw;
let tilt = defaults.tilt;
let requested = 0;
let drawn = -1;
let frame = 0;
let busy = false;
let dirty = false;
let pointer;

function toAttributes(shape) {
  const point = new Float32Array(shape.vertices.length / 2);
  const normal = new Float32Array(point.length);
  for (let i = 0; i < point.length; i += 3) {
    point.set(shape.vertices.subarray(i * 2, i * 2 + 3), i);
    normal.set(shape.vertices.subarray(i * 2 + 3, i * 2 + 6), i);
  }
  return { position: point, normal, index: shape.indices };
}

function mount({ position, normal, index }, number, at = [0, 0, 0]) {
  const mesh = raw.add(new RawMesh({
    material: paint, index,
    attributes: {
      position: { data: Float32Array.from(position), type: 'vec3f' },
      normal: { data: Float32Array.from(normal), type: 'vec3f' },
      part: { data: new Float32Array(position.length / 3).fill(number), type: 'f32' },
    },
  }));
  mesh.matrix.set(at,12);
  return mesh;
}

function makeBed() {
  mount(toAttributes(box(3.1, .01, 3.1)),4,[0,-.048,0]);
  mount(toAttributes(box(.212, .030, .200)),3,[0,-.026,.006]);
  mount(toAttributes(box(.226, .003, .207)),5,[0,-.0162,.007]);
  mount(toAttributes(box(.177, .009, .165)),3,[0,-.0045,0]);
  for(const x of [-.088,.088]) {
    mount(toAttributes(box(.010,.016,.018)),3,[x,-.036,.068]);
    mount(toAttributes(box(.010,.016,.018)),3,[x,-.036,-.056]);
  }
}

function showCentroid({centroid:[x,,z],top}) {
  for (const marker of witness) marker.dispose();
  const y = top + .003;
  witness=[
    mount(toAttributes(box(.013,.0014,.0018)),6,[x,y,z]),
    mount(toAttributes(box(.0018,.0014,.013)),6,[x,y,z]),
  ];
}

function resize() {
  const dpr = Math.min(1.65, devicePixelRatio || 1);
  const width = Math.round(canvas.clientWidth*dpr) || 1;
  const height = Math.round(canvas.clientHeight*dpr) || 1;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const aspect = width / height;
  const focus = [0,.015,.008];
  const frame = .29;
  const distance = Math.max(frame,frame/Math.min(aspect,1.15));
  const xz = distance * Math.cos(tilt);
  engine.camera.position = [focus[0]+Math.sin(yaw)*xz, focus[1]+Math.sin(tilt)*distance, focus[2]+Math.cos(yaw)*xz];
  engine.camera.target = focus;
}

const rounded = value => number.format(Math.abs(value) < .005 ? 0 : value);

function updatePanel(part, grade) {
  const state=states[part];
  const density=densities[grade];
  byId('volume').value = number.format(state.volume * 1e6) + ' cm³';
  byId('density').value = density.toLocaleString() + ' kg/m³';
  byId('centre').value = state.centroid.map(axis=>rounded(axis*1000)).join(separator)+' mm';
  byId('scale').value = (state.volume*density).toFixed(3)+' kg';
  state.inertia.forEach((moment,index) => {
    const label=rounded(moment*density*1e4);
    byId('i'+index).textContent=label;
    if(index>2)byId('i'+index+'b').textContent=label;
  });
  for(const [index,button] of buttons.entries())button.setAttribute('aria-pressed',String(index===part));
}

async function draw() {
  frame = 0;
  if (signal.aborted) return;
  busy = true;
  dirty = false;
  const current = requested;
  const grade = requestedMetal;
  const change = drawn !== current || drawnMetal !== grade;
  try {
    resize();
    if (change) {
      casting?.dispose();
      casting = mount(states[current],grade);
      if(drawn!==current) showCentroid(states[current]);
    }
    engine.render({ delta: 0 });
    if (drawn===-1) {
      await raw.ready();
      if (paint.error) throw paint.error;
      engine.render({ delta: 0 });
    }
    await engine.gpu.queue.onSubmittedWorkDone();
    if (signal.aborted) return;
    if (change) {
      drawn = current;
      drawnMetal = grade;
      updatePanel(current,grade);
      document.body.dataset.modelStep = String(current);
      document.body.dataset.metal = String(grade);
      performance.mark('cad-model-applied');
    }
    if (!document.body.dataset.ready && status.ready()) {
      document.body.dataset.renderer = engine.gpu.adapterInfo?.vendor === 'margo-webgl2' ? 'webgl2' : 'webgpu';
      notice.hidden = true;
      operations.disabled = false;
      reset.disabled = false;
      performance.mark('margo-first-usable-frame');
    }
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    if (dirty) schedule();
  }
}

function schedule() {
  if (signal.aborted) return;
  dirty = true;
  if (!frame && !busy) frame = requestAnimationFrame(draw);
}

function dispose() {
  controller.abort();
  if (frame) cancelAnimationFrame(frame);
  observer?.disconnect();
  engine?.dispose();
}

function fail(error) {
  if (signal.aborted) return;
  status.error(error);
  notice.hidden = true;
  errorOutput.hidden = false;
  operations.disabled = true;
  reset.disabled = true;
  console.error(error);
  dispose();
}

async function compatibility() {
  const { install } = await import('@margoengine/webgl2-compat');
  return { install: () => install({ force:true,signal }) };
}

async function setup(target) {
  if (!target.gpu) throw margoError('unsupported','This exhibit requires the shader renderer.');
  engine = target;
  engine.onError = fail;
  engine.scene.background = '#192929';
  states = await dataReady;
  signal.throwIfAborted();
  raw = RawShaders.attach(engine);
  paint = new RawShaderMaterial({ name:'Weigh Station precision balance',vertexShader,cull:'none' });
  makeBed();
}

function connect() {
  operations.addEventListener('click', event => {
    const button = event.target.closest('[data-step]');
    if (!button) return;
    requested = Number(button.dataset.step);
    schedule();
  },{signal});
  metal.addEventListener('change', () => {
    requestedMetal = Number(metal.value);
    schedule();
  },{signal});
  reset.addEventListener('click', () => {
    yaw = defaults.yaw;
    tilt = defaults.tilt;
    schedule();
  },{signal});
  canvas.addEventListener('pointerdown', event => {
    if (pointer || !document.body.dataset.ready) return;
    pointer = { id:event.pointerId, x:event.clientX, y:event.clientY, yaw, tilt };
    canvas.setPointerCapture(event.pointerId);
  },{signal});
  canvas.addEventListener('pointermove', event => {
    if (!pointer || event.pointerId !== pointer.id) return;
    yaw = pointer.yaw - (event.clientX - pointer.x)*.012;
    tilt = Math.max(.10,Math.min(1.38,pointer.tilt + (event.clientY-pointer.y)*.012));
    schedule();
  },{signal});
  canvas.addEventListener('lostpointercapture', event => {
    if (pointer?.id === event.pointerId) pointer = undefined;
  },{signal});
  observer = new ResizeObserver(schedule);
  observer.observe(canvas);
}

async function open() {
  applyQualityTier();
  const options = { signal, exactSize:true, antialias:true, startupTimeout:3500, camera:{near:.01,far:3,fov:36} };
  if (forced || !navigator.gpu) {
    await (await compatibility()).install();
    await autoEngine(canvas,setup,{...options,backend:'webgpu'});
  } else {
    await autoEngine(canvas,setup,{...options,loadCompat:compatibility});
  }
  connect();
  schedule();
}

addEventListener('pagehide', event => { if (!event.persisted) dispose(); });
open().catch(fail);

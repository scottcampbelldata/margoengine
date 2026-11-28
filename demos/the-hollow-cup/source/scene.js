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
  let key = normalize(vec3f(-.34,.80,.54));
  let fill = normalize(vec3f(.76,.31,-.48));
  let facing = max(dot(n,key),0.0);
  let rim = pow(1.0-max(0.0,dot(n,look)),2.5);
  let shine = pow(max(dot(n,normalize(look+key)),0.0),22.0);
  let streaks = .985 + .015 * sin(p.x*1260.0+sin(p.y*870.0));
  var color = vec3f(.056,.084,.082);
  if (i.part < .5) {
    let grain = .989 + .011 * cos(p.y*970.0+p.z*280.0);
    let cool = vec3f(.54,.25,.103);
    color = cool * grain * (.49+1.12*facing);
    color += vec3f(.70,.63,.48) * (.37*shine+.10*max(0.0,dot(n,fill)));
    color += vec3f(.56,.70,.64) * rim * .17;
  } else if (i.part < 1.5) {
    let seat = exp(-p.x*p.x*320.0-p.z*p.z*310.0);
    let tick = abs(fract(p.x/.010 + .5)-.5);
    let pin = 1.0 - smoothstep(.014,.04,tick);
    color = vec3f(.16,.20,.18) * streaks * (.65 + .46*facing - .27*seat);
    color += vec3f(.18,.23,.19) * shine * .43;
    color += vec3f(.35,.41,.34) * pin * step(.059,abs(p.z)) * .18;
  } else if (i.part < 2.5) {
    let lift = exp(-p.x*p.x*17.0-p.z*p.z*13.0);
    let footing = exp(-p.x*p.x*26.0-p.z*p.z*57.0);
    color = vec3f(.067,.10,.095) * (.50+.50*lift-.27*footing);
  } else {
    color = vec3f(.38,.25,.080) * (.62+.40*facing+.61*shine+.10*rim);
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

const reset = byId('reset');
const number = new Intl.NumberFormat(undefined, {maximumFractionDigits:2, minimumFractionDigits:2});
const controller = new AbortController();
const { signal } = controller;
const files = import.meta.glob('./assets/cup-*.bin',{ eager:true, query:'?url', import:'default' });
const cached = new Map();
function modelAt(index) {
  if (!cached.has(index)) {
    const load = fetch(files['./assets/cup-'+index+'.bin'],{signal}).then(response => {
      if (!response.ok) throw new Error('The validated cup model could not load.');
      return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
    });
    cached.set(index,load);
  }
  return cached.get(index);
}
const dataReady = modelAt(12);
dataReady.catch(() => {});
const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
const defaults = { yaw: .61, tilt: .78 };
let engine, raw, paint, casting, observer;
let yaw = defaults.yaw;
let tilt = defaults.tilt;
let requested = 12;
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
  mount(toAttributes(box(.95, .01, .95)),2,[0,-.028,0]);
  mount(toAttributes(box(.207, .018, .183)),1,[0,-.013,.006]);
  mount(toAttributes(box(.191, .005, .167)),1,[0,-.0025,.006]);
  mount(toAttributes(box(.200, .0022, .175)),3,[0,-.0105,.006]);
}

function resize() {
  const dpr = Math.min(1.65, devicePixelRatio || 1);
  const width = Math.round(canvas.clientWidth*dpr) || 1;
  const height = Math.round(canvas.clientHeight*dpr) || 1;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const aspect = width / height;
  const distance = Math.max(.238, .256 / Math.min(aspect,1.15));
  const xz = distance * Math.cos(tilt);
  engine.camera.position = [Math.sin(yaw)*xz, .035 + Math.sin(tilt)*distance, Math.cos(yaw)*xz];
  engine.camera.target = [0,.033,.006];
}

function updatePanel(state) {
  byId('volume').value = number.format(state.volume * 1e6) + ' cm³';
  byId('check').value = 'Valid solid';
  byId('faces').value = String(state.faces);
  byId('feature').textContent = 'Draft · ' + state.deg + '° toward the opening';
  byId('wall').setAttribute('aria-valuetext',state.mm+' mm');
  byId('draft').setAttribute('aria-valuetext',state.deg+' degrees');
}

async function draw() {
  frame = 0;
  if (signal.aborted) return;
  busy = true;
  dirty = false;
  const current = requested;
  const change = drawn !== current;
  try {
    const state = change ? await modelAt(current) : undefined;
    if (signal.aborted || requested !== current) return;
    resize();
    if (change) {
      casting?.dispose();
      casting = mount(state,0);
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
      updatePanel(state);
      document.body.dataset.modelStep = String(current);
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
  engine.scene.background = '#2e2421';
  await dataReady;
  signal.throwIfAborted();
  raw = RawShaders.attach(engine);
  paint = new RawShaderMaterial({ name:'Cast cup and mould board',vertexShader,cull:'none' });
  makeBed();
}

function connect() {
  operations.addEventListener('input', event => {
    const mm = Number(byId('wall').value);
    const angle = Number(byId('draft').value);
    const index = angle / 2 * 5 + mm - 2;
    byId('wall-value').value = mm+' mm';
    byId('draft-value').value = angle+'°';
    requested = index;
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

import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { heightfieldGeometry } from '@margoengine/terrain';
import { randomPlacements } from '@margoengine/scatter';
import { fieldSize, relief, reliefScale, sceneSize } from './relief.js';

const extent = 'vec2f(' + sceneSize.map(n=>n.toFixed(3)).join(',') + ')';
const waterColor = '#193c51';
const terrainCode = `
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) elevation: f32,
}
@vertex fn vertex(a: Attributes) -> Out {
  return Out(camera.viewProjection * vec4f(a.position, 1), a.position, a.normal, a.altitude);
}
@fragment fn fragment(i: Out) -> @location(0) vec4f {
  let uv = i.world.xz / ${extent} + .5;
  let bands = textureSample(cover, coverSampler, uv);
  let noon = vec3f(-.51,.73,-.44);
  let n = normalize(i.normal);
  let h = i.elevation;
  if (h <= 0.0) {
    let deep = vec3f(.098,.235,.318);
    let middle = vec3f(.165,.389,.435);
    let shelved = smoothstep(-.13, .0, h);
    let bank = smoothstep(-.028, -.0015, h);
    let coast = smoothstep(-.0055, 0.0, h);
    var c = mix(deep, middle, shelved);
    c = mix(c, vec3f(.36,.64,.608), bank*.73);
    c = mix(c, vec3f(.72,.783,.642), coast*.74);
    let minor = min(abs(fract(uv.x*19.0+.5)-.5), abs(fract(uv.y*16.0+.5)-.5));
    let edge = min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
    c += vec3f(.016,.024,.028) * (1.0-smoothstep(.013,.025,minor)) * smoothstep(.02,.12,edge) * (1.0-bank);
    return vec4f(c, 1.0);
  }
  let mass = max(.001, bands.r+bands.g+bands.b+bands.a);
  let forest = vec3f(.349,.566,.376);
  let grass = vec3f(.738,.744,.454);
  let tundra = vec3f(.632,.748,.772);
  let desert = vec3f(.847,.610,.394);
  var c = (forest*bands.r + grass*bands.g + tundra*bands.b + desert*bands.a) / mass;
  let slope = 1.0-clamp(n.y,0.0,1.0);
  let snow = smoothstep(.40,.68,h)*bands.b/mass*(.9-.42*slope);
  let exposed = smoothstep(.035,.31,slope)*smoothstep(.22,.48,h)*.52;
  c = mix(c, vec3f(.55,.55,.53), exposed);
  c = mix(c, vec3f(.895,.923,.888), snow);
  let relief = clamp(dot(n,noon),-.35,1.0);
  c = c*(.74+.30*relief) + vec3f(.040,.065,.090)*(1.0-max(0.0,relief));
  let d = abs(fract(h*23.0+.5)-.5);
  c -= vec3f(.035,.033,.024) * (1.0-smoothstep(.011,.051,d)) * smoothstep(.015,.065,h);
  c = mix(vec3f(.764,.75,.579), c, smoothstep(.002,.014,h)*smoothstep(.02,.48,mass));
  return vec4f(c, 1.0);
}`;

const treeCode = `
struct Out { @builtin(position) clip: vec4f, @location(0) shade: f32, }
@vertex fn vertex(a: Attributes) -> Out {
  let coverAt = textureSampleLevel(cover, coverSampler, a.anchor.xz / ${extent} + .5, 0.0);
  let gain = smoothstep(a.chance-.075,a.chance+.075,coverAt.r);
  let p = a.anchor + a.position * gain * a.size;
  return Out(camera.viewProjection * vec4f(p,1), a.ink);
}
@fragment fn fragment(i: Out) -> @location(0) vec4f {
  return vec4f(mix(vec3f(.16,.31,.204),vec3f(.345,.505,.300),i.shade),1);
}`;

function makeTrees() {
  const [w, d] = sceneSize;
  const at = [], variation = [], factors = [];
  for (const [x,z,scale,yaw] of randomPlacements(4000, [-w*.49,-d*.49,w*.49,d*.49], [.025,.054], 4407)) {
    const altitude = relief(x/w+.5, z/d+.5) / reliefScale;
    if (altitude < .015) continue;
    at.push(x, altitude-.010, z);
    variation.push(.31 + .63*(yaw / (Math.PI*2)));
    factors.push(scale);
  }
  const positions = [], colors = [];
  const crowns = [[.16,.91,.32],[.43,1.28,.23]];
  for (const [bottom,tip,radius] of crowns) {
    for (let side=0; side<6; side++) {
      const a = side*Math.PI/3, b = (side+1)*Math.PI/3;
      positions.push(radius*Math.cos(a),bottom,radius*Math.sin(a),0,tip,0,radius*Math.cos(b),bottom,radius*Math.sin(b));
      const light = .60-.29*Math.cos(a+.70);
      colors.push(light*.72,light,light*.69);
    }
  }
  return {
    position: {data: new Float32Array(positions), type: 'vec3f'},
    ink: {data: new Float32Array(colors), type: 'f32'},
    anchor: {data: new Float32Array(at), type: 'vec3f', step: 'instance'},
    chance: {data: new Float32Array(variation), type: 'f32', step: 'instance'},
    size: {data: new Float32Array(factors), type: 'f32', step: 'instance'},
  };
}

export async function openAtlas(canvas, first, force, signal) {
  let engine, gpuError, raw, terrain, forest, map, mapDevice, current, closed = false;
  function close() {
    if (closed) return;
    closed = true;
    terrain?.material.dispose();
    forest?.material.dispose();
    terrain?.dispose();
    forest?.dispose();
    raw?.dispose();
    map?.destroy();
    engine?.dispose();
  }
  signal.addEventListener('abort', close, {once:true});
  const legacy = force || !navigator.gpu;
  const install = async () => (await import('./compatibility.js')).installCompatibility(force, signal);
  function upload() {
    mapDevice.queue.writeTexture({texture:map}, current, {bytesPerRow:fieldSize * 4}, [fieldSize,fieldSize,1]);
  }
  const getTexture = device => {
    if (device !== mapDevice) {
      mapDevice = device;
      map = device.createTexture({
        size: [fieldSize,fieldSize,1], format:'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      upload();
    }
    return map;
  };
  async function draw(compile = false) {
    signal.throwIfAborted();
    const ratio = Math.min(devicePixelRatio, 2, 1480 / Math.max(1, canvas.clientWidth));
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    engine.render({delta:0});
    if (compile) {
      await raw.ready();
      signal.throwIfAborted();
      if (gpuError) throw gpuError;
      engine.render({delta:0});
    }
    await engine.gpu.queue.onSubmittedWorkDone();
    signal.throwIfAborted();
    if (gpuError) throw gpuError;
  }
  const project = (out, aspect, webgpu) => {
    const span = Math.max(8.50, 10.9/aspect);
    const far = engine.camera.far, near = engine.camera.near, range = far - near;
    out[0] = 2/(span*aspect);
    out[5] = 2/span;
    out[10] = webgpu ? 1/range : -2/range;
    out[14] = webgpu ? far/range : -(far+near)/range;
    out[15] = 1;
  };
  function attach() {
    const [w,d] = sceneSize;
    const height = (x,z) => relief(x/w+.5,z/d+.5)/reliefScale;
    const shape = heightfieldGeometry((x,z)=>Math.max(0,height(x,z)), {size:sceneSize, resolution:152});
    const original = new Float32Array(shape.positions.length/3);
    for (let i=0; i<original.length; i++) original[i] = height(shape.positions[i*3],shape.positions[i*3+2]);
    const textures = {cover: {texture:getTexture, sampler:{minFilter:'linear',magFilter:'linear'}}};
    const material = new RawShaderMaterial({vertexShader: terrainCode, textures, cull:'back'});
    material.onError = error => {gpuError = error;};
    terrain = raw.add(new RawMesh({
      material, index:shape.indices, attributes:{
        position: {data:shape.positions,type:'vec3f'},
        normal: {data:shape.normals,type:'vec3f'},
        altitude: {data:original,type:'f32'},
      },
    }));
    const canopy = new RawShaderMaterial({vertexShader:treeCode,textures,cull:'none'});
    canopy.onError = error => {gpuError = error;};
    forest = raw.add(new RawMesh({material:canopy,attributes: makeTrees()}));
  }
  if (legacy) await install();
  try {
    engine = await autoEngine(canvas, async target => {
      if (!target.gpu) {
        const error = new Error('The relief atlas requires WebGPU or the full Margo WebGL2 compatibility layer.');
        error.code = 'unsupported';
        throw error;
      }
      engine = target;
      canvas = target.canvas;
      gpuError = undefined;
      engine.onError = error => {gpuError = error;};
      engine.scene.background = waterColor;
      engine.camera.project = project;
      raw = RawShaders.attach(engine);
      performance.mark('margo-device-open');
      current = (await first).weights;
      signal.throwIfAborted();
      attach();
      await draw(true);
    }, {
      backend: legacy ? 'webgpu' : undefined, loadCompat: async () => ({install}), signal,
      exactSize: true, antialias: true, capacity: 2, startupTimeout: 11000,
      camera: {position:[0,9.8,6.8],target:[0,.08,0],near:.7,far:50},
    });
  } catch (error) {
    close();
    throw error;
  }
  return {
    backend: engine.gpu.adapterInfo?.vendor === 'margo-webgl2' ? 'webgl2' : 'webgpu',
    draw, close,
    async update(weights) {
      signal.throwIfAborted();
      current = weights;
      upload();
      await draw();
    },
  };
}

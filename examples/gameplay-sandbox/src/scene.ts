import {Geometry, PbrMaterial, type EngineKernel, type Mesh} from '@margoengine/core';
import {engineRuntime} from '@margoengine/core/extension';
import {planeGeometry, computeVertexNormals, toGeometry, capsuleGeometry, sphereGeometry, icosahedronGeometry, wireframe, type GeometryData} from '@margoengine/geometry';
import {Noise} from '@margoengine/procedural';
import {Scatter} from '@margoengine/scatter';
import {Line, Lines} from '@margoengine/lines';
import type {Shadows} from '@margoengine/shadows';
declare const GPUTextureUsage: {TEXTURE_BINDING: number; COPY_DST: number};

const noise = new Noise(731);
export const ISLAND_SIZE = 160;
export function terrainHeight(x: number, z: number): number {
  const radius = Math.hypot(x, z);
  const shelf = 5.5 * Math.exp(-((radius / 57) ** 4)) - 3.4;
  const east = 21 * Math.exp(-(((x - 30) / 18) ** 2) - ((z + 25) / 24) ** 2);
  const west = 13 * Math.exp(-(((x + 34) / 19) ** 2) - ((z + 35) / 20) ** 2);
  const ridge = noise.perlin(x * 0.045, 0.3, z * 0.045) * 2.8 + noise.perlin(x * 0.14, 2, z * 0.14) * 0.55;
  return shelf + east + west + ridge * Math.exp(-((radius / 67) ** 4));
}

function terrainData(segments: number): GeometryData {
  const data = planeGeometry(ISLAND_SIZE, ISLAND_SIZE, segments, segments);
  for (let i = 0; i < data.positions.length; i += 3) {
    const x = data.positions[i], z = -data.positions[i + 1];
    data.positions[i + 1] = terrainHeight(x, z); data.positions[i + 2] = z;
  }
  computeVertexNormals(data); return data;
}

function grass(blades: number): Geometry {
  const p: number[] = [], n: number[] = [], indices: number[] = [];
  for (let blade = 0; blade < blades; blade++) {
    const angle = blade * Math.PI / blades, c = Math.cos(angle), s = Math.sin(angle), start = p.length / 3;
    p.push(-0.04*c, 0, -0.04*s, 0.04*c, 0, 0.04*s, 0.055*c, 0.32, 0.055*s, 0.08*c, 0.48, 0.08*s);
    for (let i = 0; i < 4; i++) n.push(-s, 0.25, c);
    indices.push(start, start+1, start+2, start+1, start+3, start+2);
  }
  return new Geometry(p, n, indices);
}

export function createLandscape(engine: EngineKernel, shadows: Shadows) {
  const data = terrainData(192);
  const mesh = engine.createMesh().setGeometry(toGeometry(data)).setMaterial(new PbrMaterial({color: '#536b49', roughness: 0.95}));
  mesh.name = 'Island terrain'; shadows.add(mesh, {static: true});
  // Blend the example's terrain colors in one draw; keep shader extensions outside frozen core.
  engineRuntime(engine).use({name: 'sandbox:terrain-colors', setup() {}, registerPasses(graph) {
    let source = '', shader = '';
    graph.add({name: 'sandbox:terrain-colors', order: -4, execute: c => {
      if (c.backend !== 'webgpu') return;
      if (source !== c.shader) {
        source = c.shader;
        shader = source.replace('o.color=i.color.rgb;', `o.color=i.color.rgb;
          if(i.factors.x>0.94){
            let h=p.y;let slope=normalize(o.normal).y;
            let variation=0.94+0.06*sin(p.x*0.8)*cos(p.z*0.6);
            let meadow=mix(vec3f(0.10,0.18,0.055),vec3f(0.19,0.26,0.09),smoothstep(3.0,12.0,h));
            let stone=mix(meadow,vec3f(0.28,0.30,0.23),max(smoothstep(13.0,20.0,h),1.0-smoothstep(0.58,0.85,slope)));
            let wet=mix(0.55,1.0,smoothstep(0.0,0.65,h));
            o.color=mix(vec3f(0.44,0.36,0.23),stone,smoothstep(0.4,1.7,h))*variation*wet;
          }`);
      }
      c.shader = shader;
    }});
  }});
  const debug = terrainData(64), edges = wireframe(debug), linePositions = new Float32Array(edges.length * 3);
  for (let i = 0; i < edges.length; i++) {
    const source = edges[i] * 3; linePositions[i*3] = debug.positions[source]; linePositions[i*3+1] = debug.positions[source+1] + 0.035; linePositions[i*3+2] = debug.positions[source+2];
  }
  const lines = new Lines(); engine.use(lines);
  const terrainWireframe = lines.add(new Line({positions: linePositions, mode: 'segments', color: '#daf6aa', width: 0.8, opacity: 0.65, visible: false, join: 'miter', cap: 'butt'}));
  let heightmap: GPUTexture | undefined;
  const heights = new Float32Array(256 * 256);
  for (let z = 0; z < 256; z++) for (let x = 0; x < 256; x++) heights[z*256+x] = terrainHeight(((x+0.5)/256-0.5)*ISLAND_SIZE, ((z+0.5)/256-0.5)*ISLAND_SIZE);
  // Restore the borrowed height texture before scatter rebuilds its bind groups.
  engine.use({name: 'sandbox:heightmap', setup(runtime) {
    const device = (runtime as unknown as {gpu: GPUDevice}).gpu;
    heightmap = device.createTexture({size: [256, 256], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
    device.queue.writeTexture({texture: heightmap}, heights, {bytesPerRow: 256*4}, [256, 256]);
  }, onDeviceRestored(runtime) {heightmap?.destroy(); this.setup(runtime);}, dispose() {heightmap?.destroy(); heightmap = undefined;}});
  Scatter.attach(engine, [grass(3), grass(2), grass(1)], {count: 110_000, area: [ISLAND_SIZE, ISLAND_SIZE], minHeight: 0.9, maxHeight: 13, maxSlope: 32, density: 0.86, scale: [0.6, 1.3], lod: [18, 42, 105], color: [0.19, 0.28, 0.09], seed: 37, heightmap: () => heightmap});
  // Reuse the smooth 80-triangle rock in every ring so its shading, silhouette and size stay consistent.
  Scatter.attach(engine, toGeometry(icosahedronGeometry(0.65, 1)), {count: 950, area: [ISLAND_SIZE, ISLAND_SIZE], minHeight: 0.25, maxSlope: 55, scale: [0.3, 1.6], lod: [24, 55, 130], color: [0.22, 0.25, 0.21], seed: 9, heightmap: () => heightmap});
  return {wireframe: terrainWireframe, heightmap: () => heightmap};
}

export function createCharacter(engine: EngineKernel, shadows: Shadows) {
  const root = engine.createMesh(), focus = engine.createMesh(root), joints: Mesh[] = [], knees: Mesh[] = [];
  root.name = 'Offline explorer rig'; focus.position.y = 1.5;
  const white = new PbrMaterial({color: '#d9e3d3', roughness: 0.38}), dark = new PbrMaterial({color: '#344b48', roughness: 0.65}), amber = new PbrMaterial({color: '#dae49a', metalness: 0.5, roughness: 0.15});
  const capsule = toGeometry(capsuleGeometry(1, 1, 4, 10)), orb = toGeometry(sphereGeometry(1, 16, 10));
  const part = (parent: Mesh, geometry: Geometry, material: PbrMaterial, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    const mesh = engine.createMesh(parent).setGeometry(geometry).setMaterial(material); mesh.position.set(x,y,z); mesh.scale.set(sx,sy,sz); shadows.add(mesh); return mesh;
  };
  part(root,capsule,white,0,1.4,0,0.3,0.32,0.22);
  part(root,orb,white,0,2.03,0,0.31,0.32,0.29);
  part(root,orb,amber,0,2.06,0.2,0.26,0.2,0.14);
  part(root,capsule,dark,0,1.45,-0.22,0.24,0.26,0.12);
  for (let i = 0; i < 4; i++) {
    const leg = i < 2, side = i % 2 ? 1 : -1;
    const joint = engine.createMesh(root); joint.position.set(side*(leg?0.16:0.39),leg?1.03:1.73,0); joints.push(joint);
    part(joint,capsule,leg?dark:white,0,-0.23,0,leg?0.105:0.085,0.19,0.105);
    const knee = engine.createMesh(joint); knee.position.y = -0.46; knees.push(knee);
    part(knee,capsule,white,0,-0.21,0,leg?0.105:0.075,0.17,0.105);
    if (leg) part(knee,orb,dark,0,-0.42,0.075,0.12,0.095,0.22);
  }
  return {root, focus, joints, knees};
}

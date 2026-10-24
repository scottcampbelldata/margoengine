// Depth texture demo: DepthTexture draws the scene's depth into textures of its own before the main pass, and a
// WgslMaterial water plane samples it: where the scene behind the water is close to the surface it turns to foam, and
// deeper water is darker. Shapes bob (held still under prefers-reduced-motion, used by the visual check).
import { createStage } from 'margoengine';
import { Texture, WgslMaterial, createMesh } from '@margoengine/materials';
import { DepthTexture } from '@margoengine/post/depth';
import { still } from './multi-view.js';

declare global {
  interface Window {
    depthDemo?: { depth: DepthTexture };
  }
}

const status = document.querySelector<HTMLParagraphElement>('#status')!,
  canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const life = new AbortController();
let dispose = () => {};
window.addEventListener(
  'pagehide',
  () => {
    life.abort();
    dispose();
  },
  { once: true },
);
// The water's own camera distance against the scene's at this pixel: the gap is the water depth there.
const water = /* wgsl */ `
fn shade(i:Out,s:Surface)->Surface {
  var o=s;
  let scene=textureLoad(sceneDistance,vec2i(i.clip.xy),0).r;
  let gap=select(100.0,scene-distance(f.eye.xyz,i.position),scene>0.0);
  let foam=1.0-smoothstep(0.0,uniforms.foam,gap);
  let deep=vec3f(0.02,0.12,0.22);let shallow=vec3f(0.1,0.55,0.6);
  o.base=vec4f(mix(mix(shallow,deep,clamp(gap/2.5,0.0,1.0)),vec3f(1),foam),1);
  o.roughness=mix(0.08,0.9,foam);
  return o;
}`;
try {
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 5, 9], target: [0, 0, 0] },
    onError: (error) => {
      if (!life.signal.aborted) status.textContent = String(error);
    },
  });
  dispose = () => stage.dispose();
  life.signal.throwIfAborted();
  const engine = stage.engine;
  // A sloping sea bed and rocks; the water plane cuts them at y = 0.
  stage.box({ size: [16, 0.4, 12], position: [0, -1.4, 0], rotation: [0.18, 0, 0], color: '#c8b48a', roughness: 1 });
  const rocks = [
    stage.box({ size: [1.6, 2, 1.6], position: [-3, -0.2, 0.5], rotation: [0, 0.6, 0], color: '#6c6a66' }),
    stage.box({ size: [1, 1.6, 2.4], position: [2.5, 0, -1], rotation: [0.3, 0.2, 0.1], color: '#76716a' }),
    stage.box({ size: [2.4, 1.4, 1], position: [0.5, -0.1, 2.2], rotation: [0, -0.4, 0], color: '#5f5d58' }),
  ];
  const depth = DepthTexture.attach(engine);
  // Until the first frame draws the depth, the material reads an empty (all far) texture.
  const material = new WgslMaterial({
    wgsl: water,
    uniforms: { foam: 0.35 },
    textures: { sceneDistance: new Texture({ data: new Float32Array(4), width: 1, height: 1, format: 'r32float' }) },
  });
  depth.onResize(() => (material.textures.sceneDistance = new Texture(depth.distance!)));
  const plane = createMesh(
    engine,
    {
      positions: [-8, 0, -6, 8, 0, -6, -8, 0, 6, 8, 0, 6],
      normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
      uvs: [0, 0, 1, 0, 0, 1, 1, 1],
      indices: [0, 2, 1, 1, 2, 3],
    },
    material,
  );
  plane.root.setPosition([0, 0, 0]);
  let time = 0;
  if (!still)
    stage.use({
      name: 'depth-demo',
      setup() {},
      onPreUpdate(delta) {
        time += delta;
        rocks.forEach((rock, i) => (rock.position.y = -0.2 + 0.35 * Math.sin(time * 0.8 + i * 2)));
      },
    });
  window.depthDemo = { depth };
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  status.textContent = 'The water material samples the scene depth: foam where rocks meet the surface.';
  canvas.dataset.ready = 'true';
} catch (error) {
  if (!life.signal.aborted) status.textContent = String(error);
}

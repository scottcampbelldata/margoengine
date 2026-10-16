import {
  Scene,
  WebGLRenderer,
  WebGLRenderTarget,
  PerspectiveCamera,
  Mesh,
  Object3D,
  BufferGeometry,
  BufferAttribute,
  BoxGeometry,
  MeshStandardMaterial,
  DirectionalLight,
  AmbientLight,
} from 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js';
import {EffectComposer} from 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/postprocessing/EffectComposer.js';
import {RenderPass} from 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/postprocessing/RenderPass.js';
import {OutputPass} from 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/postprocessing/OutputPass.js';
import { conveyorScene } from "./conveyor-scene.js";
import { installBenchmark } from "./frame-runner.js";
import {sceneSamples} from '../../packages/shared/quality.js';
try {
  const definition = conveyorScene(),
    canvas = document.querySelector("canvas"),
    renderer = new WebGLRenderer({ canvas, antialias: false }),
    scene = new Scene(),
    camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100),
    cylinder = new BufferGeometry();
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight, false);
  camera.position.set(5, 4, 7);
  camera.lookAt(0, 0.4, 0);
  cylinder.setAttribute(
    "position",
    new BufferAttribute(definition.cylinder.positions, 3),
  );
  cylinder.setAttribute(
    "normal",
    new BufferAttribute(definition.cylinder.normals, 3),
  );
  cylinder.setIndex(new BufferAttribute(definition.cylinder.indices, 1));
  const geometries = { box: new BoxGeometry(), cylinder },
    materials = definition.materials.map((value) => {
      const material = new MeshStandardMaterial({
        roughness: value.roughness,
        metalness: value.metalness,
      });
      material.color.setRGB(...value.color);
      return material;
    }),
    nodes = [];
  for (const part of definition.nodes) {
    const node = part.geometry
      ? new Mesh(geometries[part.geometry], materials[part.material])
      : new Object3D();
    node.name = part.name;
    node.position.set(...part.position);
    node.scale.set(...part.scale);
    node.frustumCulled = false;
    (part.parent < 0 ? scene : nodes[part.parent]).add(node);
    nodes.push(node);
  }
  const sun = new DirectionalLight(0xffffff, 1);
  sun.position.set(3, 5, 4);
  scene.add(sun, new AmbientLight(0xffffff, 0.15));
  const samples=sceneSamples(),composer=new EffectComposer(renderer,new WebGLRenderTarget(innerWidth,innerHeight,{samples:samples===4?4:0}));
  composer.addPass(new RenderPass(scene,camera));composer.addPass(new OutputPass());
  renderer.info.autoReset=false;
  let angle = 0;
  installBenchmark(
    (delta, counts, offset) => {
      angle = (angle + delta * Math.PI * 2) % (Math.PI * 2);
      nodes[definition.motor].rotation.z = angle;
      for (let i = 0; i < definition.shafts.length; i++)
        nodes[definition.shafts[i]].rotation.z = angle;
      renderer.info.reset();composer.render();
      counts[offset] = renderer.info.render.calls;
    },
    {
      engine: "Three.js 0.186.1",
      backend: "webgl2",
      msaaSamples:samples,
      entities: nodes.length,
      renderable: definition.nodes.filter((part) => part.geometry).length,
    },
  );
  window.addEventListener(
    "pagehide",
    () => {
      for (const geometry of Object.values(geometries)) geometry.dispose();
      for (const material of materials) material.dispose();
      for(const pass of composer.passes)pass.dispose();composer.dispose();renderer.dispose();
    },
    { once: true },
  );
} catch (error) {
  window.benchmark = { error: String(error) };
  throw error;
}

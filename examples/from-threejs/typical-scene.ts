// A typical application scene: a glTF model playing a clip on a ground, lit by an HDR environment and a shadowed sun,
// with orbit controls, ambient occlusion and bloom, and click to outline.
//
// In three.js this is a WebGLRenderer with shadow maps enabled, RGBELoader feeding scene.environment and background,
// a DirectionalLight with castShadow and a hand-sized shadow camera, castShadow and receiveShadow set on the meshes
// (after traversing the loaded model), GLTFLoader, an AnimationMixer, OrbitControls, an EffectComposer with
// RenderPass, SSAOPass, UnrealBloomPass and OutputPass, and a Raycaster with an OutlinePass for the selection.
//
// In Margo each of those is a plugin attached to the engine. Anything a feature should affect joins it with add().
import { Engine } from '@margoengine/core';
import {
  Environment,
  EnvironmentBackground,
  EnvironmentLighting,
  loadEnvironmentImage,
} from '@margoengine/environment';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { AnimationMixer } from '@margoengine/animation/mixer';
import { OrbitControls } from '@margoengine/controls/orbit';
import { planeGeometry } from '@margoengine/geometry';
import { createMesh, PbrMaterial } from '@margoengine/materials';
import { Bloom } from '@margoengine/post/bloom';
import { FXAA } from '@margoengine/post/fxaa';
import { SSAO } from '@margoengine/post/ssao';
import { PostStack } from '@margoengine/post/stack';
import { Picking, Selection } from '@margoengine/selection';
import { Shadows } from '@margoengine/shadows';
import { Tonemap } from '@margoengine/tonemap';
import type { Example } from './example.ts';

const typicalScene: Example = async (canvas, say) => {
  say('Loading the model and the environment…');
  const engine = await Engine.create(canvas, {
    camera: { position: [1.75, 0.85, 1.65], target: [0, 0.36, 0], fov: 38 },
  });

  // Image-based light and a soft backdrop from one HDR file.
  const image = await loadEnvironmentImage(new URL('../assets/skinning-ik-workshop.hdr', import.meta.url).href);
  const environment = await Environment.attach(engine, image, { intensity: 0.7 });
  EnvironmentBackground.attach(engine, environment, { blur: 0.45, exposure: 0.7 });
  const imageLight = EnvironmentLighting.attach(engine, environment);

  // The sun: core's one directional light.
  engine.lighting.direction.set([-2.5, 4, 2, 2.6]);
  engine.lighting.radiance.set([1, 0.93, 0.82, 0]);

  // The model and its clip. The file is authored 100 times larger than metres.
  const fox = await loadGLTF(engine, new URL('../assets/khronos/Fox/Fox.glb', import.meta.url).href);
  fox.root.setScale([0.01, 0.01, 0.01]);
  const mixer = AnimationMixer.attach(engine, fox);
  mixer.clipAction('Walk').play();

  // The ground: a textureless material mesh, laid flat.
  const ground = createMesh(engine, planeGeometry(80, 80), new PbrMaterial({ color: '#8d8478', roughness: 0.92 }));
  ground.root.setRotation([-Math.PI / 2, 0, 0]);

  // Shadows: add() makes a mesh or model cast and receive.
  const shadows = Shadows.attach(engine, { resolution: 2048, distance: 12 });
  shadows.add(fox);
  shadows.add(ground, { castShadow: false });
  imageLight.add(fox);
  imageLight.add(ground);

  const ambientOcclusion = new SSAO({ radius: 0.25 });
  PostStack.attach(engine, [
    ambientOcclusion,
    new Bloom({ strength: 0.15 }),
    new Tonemap({ curve: 'neutral' }),
    new FXAA(),
  ]);
  ambientOcclusion.add(fox);
  ambientOcclusion.add(ground);

  // Drag to orbit.
  const orbit = OrbitControls.attach(engine);
  orbit.enableDamping = true;
  orbit.minDistance = 1;
  orbit.maxDistance = 6;
  orbit.maxPolarAngle = Math.PI * 0.49; // stay above the ground

  // Click to outline what is under the pointer. The GPU pick sees the posed, animated surface.
  const picking = Picking.attach(engine);
  const outline = Selection.attach(engine, { color: [1, 0.55, 0.05], width: 3 });
  let pressed = [0, 0];
  let busy = false; // one pick waits at a time
  const select = async (x: number, y: number) => {
    const hit = await picking.pick(x, y);
    const name = hit?.model === fox ? 'fox' : hit?.model === ground ? 'ground' : undefined;
    outline.set(name === 'fox' ? [fox] : []);
    say(name === 'fox' ? 'Picked the fox.' : 'Click the fox. Drag to orbit.');
    return name;
  };
  canvas.addEventListener('pointerdown', (event) => {
    pressed = [event.clientX, event.clientY];
  });
  canvas.addEventListener('click', async (event) => {
    // The end of an orbit drag is not a click.
    if (busy || Math.hypot(event.clientX - pressed[0], event.clientY - pressed[1]) > 4) return;
    busy = true;
    try {
      await select(event.offsetX, event.offsetY);
    } finally {
      busy = false;
    }
  });

  engine.start();
  say('Click the fox. Drag to orbit. Fox by PixelMannen and tomkranis (CC0 and CC BY 4.0).');
  return { engine, fox, ground, mixer, orbit, shadows, select };
};

export default typicalScene;

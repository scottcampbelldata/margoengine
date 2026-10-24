// Animation formats demo: Khronos's Cesium Man (a textured Collada walk cycle, CC BY 4.0, Cesium) and AnimatedColorsCube
// (a KHR_animation_pointer sample, CC0), with our own generated files beside them: a Collada tube skinned to three joints (loaders parseDAE, bindDAESkin, daeKeyframeClip,
// played by animation Skeleton and Skin), and a glTF cube whose colour, glow and position move through
// KHR_animation_pointer (animation Animation with pointerChannels). Both loop over 2 s; under prefers-reduced-motion
// (the visual check) both hold their pose at 0.5 s.
import { createStage } from 'margoengine';
import { parseDAE, bindDAESkin, daeKeyframeClip } from '@margoengine/loaders';
import { Skeleton, Skin, Animation, createKeyframeClip, applyKeyframeClip, segmentTime } from '@margoengine/animation';
import { pointerChannels } from '@margoengine/animation/pointer';
import { loadGLTF } from '@margoengine/gltf-pro';
import { Material, createMesh, loadTexture } from '@margoengine/materials';
import { still } from './multi-view.js';

declare global {
  interface Window {
    animationDemo?: { warnings: readonly string[] };
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
try {
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 2.6, 9.5], target: [0, 1.1, 0] },
    onError: (error) => {
      if (!life.signal.aborted) status.textContent = String(error);
    },
  });
  dispose = () => stage.dispose();
  life.signal.throwIfAborted();
  const engine = stage.engine;
  stage.box({ size: [12, 0.2, 4], position: [0, -0.1, 0], color: '#3e4a5c', roughness: 0.9 });

  // Collada: skin bound in scene space, so the tube mesh stays at the scene root; the skeleton's root joint moves it.
  const text = await (await fetch(new URL('./assets/animation-formats/bend-tube.dae', import.meta.url))).text(),
    dae = parseDAE(text),
    binding = bindDAESkin(dae),
    skeleton = new Skeleton(binding.bones, binding.inverseBindMatrices);
  const tube = createMesh(engine, binding.geometry, new Material({ color: '#e0a050', roughness: 0.4 }));
  Skin.attach(tube, skeleton, binding.joints, binding.weights);
  skeleton.setPose(0, { translation: [-4, 0, 0] });
  const clip = createKeyframeClip(daeKeyframeClip(dae, { fps: 60 }));

  // Cesium Man: a 20-joint skin and its texture (the material names CesiumMan.jpg beside the file).
  const manDAE = parseDAE(
      await (await fetch(new URL('./assets/khronos-samples/CesiumMan.dae', import.meta.url))).text(),
    ),
    man = bindDAESkin(manDAE),
    manSkeleton = new Skeleton(man.bones, man.inverseBindMatrices),
    manMap = await loadTexture(new URL('./assets/khronos-samples/CesiumMan.jpg', import.meta.url));
  const body = createMesh(engine, man.geometry, new Material({ map: manMap, roughness: 0.7 }));
  Skin.attach(body, manSkeleton, man.joints, man.weights);
  const walk = createKeyframeClip(daeKeyframeClip(manDAE, { fps: 30 })),
    manRoot = manSkeleton.root;
  const placeMan = () => manSkeleton.setPose(manRoot, { translation: [-1.8, 0, 0] });

  // AnimatedColorsCube: pointer-animated base colour plus ordinary rotation and translation channels.
  const colours = await loadGLTF(engine, new URL('./assets/khronos-samples/AnimatedColorsCube.glb', import.meta.url));
  colours.root.setPosition([1.4, 0.35, 0]);
  colours.root.setScale([0.35, 0.35, 0.35]);
  const coloursAnimation = Animation.attach(colours, { pointers: pointerChannels });

  // glTF: KHR_animation_pointer channels on the material and the node.
  const cube = await loadGLTF(engine, new URL('./assets/animation-formats/pointer-cube.gltf', import.meta.url));
  cube.root.setPosition([4.2, 0, 0]);
  const animation = Animation.attach(cube, { pointers: pointerChannels });

  const pose = (seconds: number) => {
    applyKeyframeClip(clip, skeleton, segmentTime(seconds, clip.duration, { loop: true }));
    skeleton.setPose(0, { translation: [-4, 0, 0] });
    applyKeyframeClip(walk, manSkeleton, segmentTime(seconds, walk.duration, { loop: true }));
    placeMan();
  };
  if (still) {
    for (const each of [animation, coloursAnimation]) {
      each.playing = false;
      each.seek(0.5);
    }
    pose(0.5);
  } else {
    let time = 0;
    stage.use({
      name: 'animation-formats-demo',
      setup() {},
      onPreUpdate(delta) {
        time += delta;
        pose(time);
      },
    });
  }
  window.animationDemo = {
    warnings: [...dae.warnings, ...manDAE.warnings, ...animation.warnings, ...coloursAnimation.warnings],
  };
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  status.textContent = 'Collada skins (ours and Cesium Man) and KHR_animation_pointer glTFs (AnimatedColorsCube and ours).';
  canvas.dataset.ready = 'true';
} catch (error) {
  if (!life.signal.aborted) status.textContent = String(error);
}

// A glTF model with its clips, cross-faded, with orbit controls.
//
// In three.js you load the file with GLTFLoader, add its scene to yours, create an AnimationMixer on it, take actions
// with clipAction, call crossFadeTo between them, advance the mixer from a Clock in the render loop, and attach
// OrbitControls to the renderer's canvas, updating them each frame when damping is on.
//
// In Margo loadGLTF draws the model as soon as it resolves, and the mixer and the controls are engine plugins: the
// engine advances them before each frame, so there is no loop to write.
import { Engine } from '@margoengine/core';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { AnimationMixer } from '@margoengine/animation/mixer';
import { OrbitControls } from '@margoengine/controls/orbit';
import type { Example } from './example.ts';

const modelAnimation: Example = async (canvas, say) => {
  const engine = await Engine.create(canvas, { camera: { position: [1.7, 0.9, 1.9], target: [0, 0.4, 0], fov: 40 } });
  engine.scene.background = '#26303f';
  engine.lighting.direction.set([2, 4, 3, 3]);

  const fox = await loadGLTF(engine, new URL('../assets/khronos/Fox/Fox.glb', import.meta.url).href);
  fox.root.setScale([0.01, 0.01, 0.01]); // this file is authored 100 times larger than metres

  const mixer = AnimationMixer.attach(engine, fox);
  const walk = mixer.clipAction('Walk').play();
  const run = mixer.clipAction('Run');

  const orbit = OrbitControls.attach(engine);
  orbit.enableDamping = true;

  let running = false;
  const toggle = () => {
    const [from, to] = running ? [run, walk] : [walk, run];
    to.reset().play();
    from.crossFadeTo(to, 0.3);
    running = !running;
    say(`${running ? 'Running' : 'Walking'}. Click to switch, drag to orbit.`);
  };
  canvas.addEventListener('dblclick', toggle);
  say('Walking. Double-click to switch, drag to orbit.');
  engine.start();
  return { engine, fox, mixer, walk, run, orbit, toggle };
};

export default modelAnimation;

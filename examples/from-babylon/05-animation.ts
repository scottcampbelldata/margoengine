// Babylon.js, in words: a loaded glTF fills scene.animationGroups; you find one by name, call group.start(loop, speed),
// stop() or pause() it, blend two groups with enableBlending and blendingSpeed, and read group.animatables or
// onAnimationEndObservable. Skeletons and morph target managers are driven by those groups.
//
// Margo: `Animation.attach(model)` adds a player for the model's skins, morphs and clips; skinning runs in a compute
// pass. `play(name)` restarts a clip, `playing` pauses it, `seek` scrubs. Blending between clips is `@margoengine/animator`.
import { createStage } from 'margoengine';
import { Animation } from 'margoengine/animation';
import { loadGLTF } from 'margoengine/gltf/pbr';
import { Shadows } from 'margoengine/shadows';
import { fail, status } from './common';

const stage = await createStage('#scene', { camera: { position: [0, 2, 6], target: [0, 1.2, 0] } }).catch(fail);
const engine = stage.engine;
const robot = await loadGLTF(engine, '/examples/assets/robot-expressive.glb').catch(fail);
const b = robot.bounds;
engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]]);
const floor = stage.box({ size: [8, 0.1, 8], position: [0, -0.05, 0], color: '#d4d4cc' });
const shadows = Shadows.attach(engine, { resolution: 2048 });
shadows.add(robot);
shadows.add(floor, { castShadow: false });

// scene.animationGroups -> animation.clips
const animation = Animation.attach(robot);
const buttons = document.createElement('div');
buttons.style.cssText = 'position:fixed;bottom:8px;left:8px;right:8px;display:flex;gap:4px;flex-wrap:wrap';
for (const clip of animation.clips) {
  const button = document.createElement('button');
  button.textContent = clip.name;
  button.onclick = () => animation.play(clip.name); // group.start(true)
  buttons.append(button);
}
const pause = document.createElement('button');
pause.textContent = 'Pause / play';
pause.onclick = () => {
  animation.playing = !animation.playing; // group.pause() / group.restart()
};
buttons.append(pause);
document.body.append(buttons);

animation.play(animation.clips.find((clip) => clip.name === 'Walking')?.name ?? animation.clips[0].name);
status.textContent = `${animation.clips.length} clips. Pick one.`;
window.addEventListener('pagehide', () => stage.dispose(), { once: true });

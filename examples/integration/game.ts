// Composed from the package README calls listed in docs/integration-everything.md.
import { box, PbrMaterial } from '@margoengine/core';
import { loadGLTF as loadStatic } from '@margoengine/gltf';
import { loadGLTF } from '@margoengine/gltf-pro';
import { Animation } from '@margoengine/animation';
import { Physics } from '@margoengine/physics';
import { Crowd, NavMesh } from '@margoengine/navmesh';
import { Shadows } from '@margoengine/shadows';
import { PostStack } from '@margoengine/post/stack';
import { FXAA } from '@margoengine/post/fxaa';
import { AudioListener, PositionalAudio } from '@margoengine/audio';
import { Input } from '@margoengine/input';
import { OrbitControls } from '@margoengine/controls';
import { Ui, UiRenderer, HealthBar } from '@margoengine/ui';
import { saveGame, loadGame, memoryStorage } from '@margoengine/save';
import { check, expose } from './harness.ts';

expose('game', async (engine) => {
  await Physics.load({ signal: AbortSignal.timeout(30_000) });
  const physics = new Physics(engine);
  const floor = engine
    .createMesh()
    .setGeometry(box(8, 0.2, 6))
    .setPosition([0, -0.2, 0]);
  physics.addBody(floor, { type: 'fixed' });
  const crate = engine
    .createMesh()
    .setGeometry(box())
    .setPosition([2, 2, 0])
    .setMaterial(new PbrMaterial({ color: '#c08040' }));
  physics.addBody(crate, { colliders: { shape: 'box', restitution: 0 } });
  const model = await loadGLTF(engine, '/packages/animation/tests/fixtures/tentacle-rig.glb');
  const animation = Animation.attach(model);
  animation.play(0);
  animation.playing = false;
  animation.seek(0.5);
  const prop = await loadStatic(engine, '/examples/integration/prop.gltf');
  const shadows = Shadows.attach(engine, { resolution: 128, cascades: 1, distance: 20, filter: 'pcf' });
  shadows.add(floor);
  shadows.add(crate);
  shadows.add(model);
  const stack = PostStack.attach(engine, [new FXAA()]);
  const controls = OrbitControls.attach(engine);
  const input = new Input({ jump: [{ type: 'key', code: 'Space' }] });
  const crowd = new Crowd(
    new NavMesh(
      [
        [-3, 0, -2],
        [3, 0, -2],
        [3, 0, 2],
        [-3, 0, 2],
      ],
      [[0, 1, 2, 3]],
    ),
  );
  const guard = crowd.addAgent({ position: [-2, 0, 1], maxSpeed: 1 });
  guard.setTarget([2, 0, 1]);
  const marker = engine
    .createMesh()
    .setGeometry(box(0.25))
    .setMaterial(new PbrMaterial({ color: '#00b5df' }));
  const listener = AudioListener.attach(engine, { volume: 0 });
  const sound = new PositionalAudio(listener, { mesh: crate, refDistance: 2 });
  sound.setBuffer(listener.context.createBuffer(1, 800, 8000));
  sound.loop = true;
  await listener.resume();
  sound.play();
  const ui = new Ui();
  const renderer = UiRenderer.attach(engine, ui);
  ui.add(new HealthBar({ value: 0.8, width: 90, height: 20, anchor: 'top-left', margin: 8 }));
  const storage = memoryStorage();
  await saveGame(storage, 'game', {
    format: 'margo-save',
    version: 1,
    entities: [{ id: 'crate', transform: { position: [2, 2, 0] } }],
  });
  const loaded = await loadGame(storage, 'game');
  return {
    tick(delta) {
      input.update();
      crowd.update(delta);
      marker.setPosition(guard.position);
    },
    assert() {
      check(crate.position.y < 2 && crate.position.y > -0.2, 'physics did not move the crate onto the floor');
      check(guard.position[0] > -2, 'navmesh agent did not move');
      check(loaded?.entities[0].id === 'crate', 'save round trip failed');
      check(renderer.stats.rects > 0, 'UI did not draw');
      check(animation.clips.length > 0, 'animation clip missing');
      return {
        crateY: crate.position.y,
        agentX: guard.position[0],
        clips: animation.clips.length,
        saved: loaded.entities.length,
        uiRects: renderer.stats.rects,
      };
    },
    async dispose() {
      sound.dispose();
      listener.dispose();
      input.dispose();
      controls.dispose();
      crowd.dispose();
      ui.dispose();
      renderer.dispose();
      stack.dispose();
      shadows.dispose();
      animation.dispose();
      model.dispose();
      prop.dispose();
      physics.dispose();
    },
    assertDisposed() {
      check(physics.getBodies().length === 0 && crowd.agents.length === 0, 'simulation retained objects');
      check(listener.attachedEngine === null, 'audio listener retained engine');
    },
  };
});

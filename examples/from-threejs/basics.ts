// The first scene: a spinning box on a floor, one sun and some ambient light.
//
// In three.js this takes a WebGLRenderer that you size and re-size yourself, a Scene, a PerspectiveCamera turned with
// lookAt, two Mesh objects built from BoxGeometry and MeshStandardMaterial, a DirectionalLight and an AmbientLight
// added to the scene, and a setAnimationLoop callback that renders.
//
// In Margo the engine owns the scene, the sun and the drawing buffer size, so only @margoengine/core is needed.
import { box, Engine, PbrMaterial } from '@margoengine/core';
import type { Example } from './example.ts';

const basics: Example = async (canvas, say) => {
  // The camera is a position and a target; its aspect follows the canvas on every frame.
  const engine = await Engine.create(canvas, { camera: { position: [2.6, 2, 3.6], target: [0, 0.4, 0], fov: 45 } });
  engine.scene.background = '#1b2331';

  // xyz points toward the sun and w is its strength; radiance is its linear colour, w the ambient strength.
  engine.lighting.direction.set([3, 5, 2, 3]);
  engine.lighting.radiance.set([1, 0.95, 0.86, 0.25]);

  // Core's material defaults differ from three.js (see the guide's pitfalls), so each value is written out.
  const floor = engine
    .createMesh()
    .setGeometry(box(6, 0.1, 6))
    .setMaterial(new PbrMaterial({ color: '#8b9099', roughness: 0.9 }))
    .setPosition([0, -0.05, 0]);
  const crate = engine
    .createMesh()
    .setGeometry(box(1, 1, 1))
    .setMaterial(new PbrMaterial({ color: '#e8833a', roughness: 0.35 }))
    .setPosition([0, 0.5, 0]); // resting on the floor

  const stop = engine.onFrame((_, delta) => {
    crate.rotation.y += delta * 0.8; // radians per second
  });
  engine.start();
  say('A box on a floor: core only.');
  return { engine, crate, floor, stop };
};

export default basics;

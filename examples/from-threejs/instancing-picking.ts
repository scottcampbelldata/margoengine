// Many copies of one box in one draw, and clicking one of them.
//
// In three.js you create an InstancedMesh with a count, fill it with setMatrixAt and setColorAt, and on a click turn
// the pointer into normalized device coordinates, aim a Raycaster from the camera and read instanceId from the
// nearest intersection.
//
// In Margo createInstancedMesh is the counterpart. The BVH Raycaster takes canvas CSS pixels directly, and GPU
// picking answers the same question from what was actually drawn.
import { Engine } from '@margoengine/core';
import { Raycaster } from '@margoengine/bvh';
import { boxGeometry } from '@margoengine/geometry';
import { createInstancedMesh, PbrMaterial } from '@margoengine/materials';
import { Matrix4 } from '@margoengine/math/matrix4';
import { Picking } from '@margoengine/selection';
import type { Example } from './example.ts';

const instancingPicking: Example = async (canvas, say) => {
  const engine = await Engine.create(canvas, { camera: { position: [0, 8, 5], target: [0, 0, 0], fov: 45 } });
  engine.scene.background = '#161c26';
  engine.lighting.direction.set([3, 6, 4, 3]);
  engine.lighting.radiance.set([1, 0.96, 0.9, 0.35]);

  const side = 9;
  const crates = createInstancedMesh(
    engine,
    boxGeometry(0.5, 0.5, 0.5),
    new PbrMaterial({ roughness: 0.5 }),
    side * side,
  );
  const matrix = new Matrix4();
  for (let i = 0; i < side * side; i++) {
    const column = i % side,
      row = Math.floor(i / side);
    matrix.makeTranslation(column - 4, 0, row - 4);
    // Colour arrays are linear RGB.
    crates.instances.setMatrixAt(i, matrix.elements).setColorAt(i, [0.1 + column / 12, 0.35, 0.1 + row / 12]);
  }

  const raycaster = new Raycaster();
  const picking = Picking.attach(engine);
  const rayAt = (x: number, y: number) =>
    raycaster.setFromEngine(engine, x, y).intersectObjects(engine, [crates])[0]?.instanceId;
  const gpuAt = async (x: number, y: number) => (await picking.pick(x, y))?.instanceId;

  let selected: number | undefined;
  canvas.addEventListener('click', (event) => {
    if (selected !== undefined) crates.instances.setColorAt(selected, [0.1, 0.35, 0.6]);
    selected = rayAt(event.offsetX, event.offsetY);
    if (selected !== undefined) crates.instances.setColorAt(selected, [1, 0.5, 0.02]);
    say(selected === undefined ? 'Nothing there. Click a box.' : `Picked box ${selected}.`);
  });
  say(`${side * side} boxes in one draw. Click one.`);
  engine.start();
  return { engine, crates, side, rayAt, gpuAt };
};

export default instancingPicking;

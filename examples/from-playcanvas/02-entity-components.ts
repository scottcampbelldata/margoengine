// PlayCanvas, in words: an Entity is a node with a name, a transform, children (`entity.addChild`) and components
// (`entity.addComponent('render', {...})`, `'script'`, `'rigidbody'`). You find entities with `entity.findByName` or
// `app.root.findByTag`, and ask `entity.render` for a component's data. A parent's transform moves its children.
//
// Margo: a mesh is the node, and its children are meshes. There is no component bag on a node. Behaviour is data you
// hold in `@margoengine/ecs` (a sparse-set `World` with typed fields), or plain fields of your own objects. Here a
// `spin` component lives in a World, and one system walks every entity that has it.
import { createStage } from 'margoengine';
import { World } from 'margoengine/ecs';
import { fail, status } from './common';

const stage = await createStage('#scene', { camera: { position: [5, 4, 7], target: [0, 1, 0] } }).catch(fail);
const engine = stage.engine;
stage.box({ size: [10, 0.1, 10], position: [0, -0.05, 0], color: '#d8d8cf' });

// Entities: a pivot with two children. entity.addChild(child) is `child.setParent(parent)`.
const pivot = engine.createMesh().setPosition([0, 1, 0]); // a transform node: no geometry, so it draws nothing
const arm = stage.box({ size: [2.4, 0.15, 0.15], color: '#84d6bd' });
const tip = stage.sphere({ radius: 0.3, color: '#d9824c' });
arm.setParent(pivot);
tip.setParent(pivot);
tip.position.x = 1.2;

// Components: the data lives in a World; the entity id is the key to your own mesh table.
const world = new World(64);
const spin = world.component({ speed: Float32Array });
const meshOf = new Map<number, typeof pivot>();
const entity = world.create(); // new pc.Entity()
spin.add(entity, { speed: 1.2 }); // entity.addComponent(...)
meshOf.set(entity, pivot);

// The system: runs on every entity that has a `spin` component, once per frame.
const found = new Uint32Array(world.capacity);
stage.onTick((delta) => {
  const count = world.query([spin], found);
  for (let i = 0; i < count; i++) {
    const id = found[i];
    meshOf.get(id)!.rotation.y += spin.fields.speed[spin.index(id)] * delta;
  }
});
status.textContent = 'A pivot with two child meshes, turned by a system over an ECS World.';
window.addEventListener('pagehide', () => stage.dispose(), { once: true });

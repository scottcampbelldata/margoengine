// Owner/lifetime fixture for @margoengine/armies. The package's engine-facing entries are the three things that draw:
// a PersonCrowd (the skinned near draw and the vertex-animation far draw, two plugins the crowd owns), an army of
// foot soldiers (addArmy, one PersonCrowd) and an army with cavalry (addArmy, a PersonCrowd and the horse herd of
// @margoengine/horses/crowd with its coat atlas). Each is updated once with real members before it is disposed, so
// the instance buffers exist when the owner lets go. The person bake is CPU data (typed arrays), made once from a
// body built in code; the glTF model and animation it is baked from are disposed straight after, as a user does. The
// scene is captured before the bake is awaited and the crowd call runs in it, as an app calls from its own scene.
// Not entries: bakePerson, planCrowd, riderMatrix, stepPose and the settings rows hold nothing with a lifetime (they
// read and return numbers and typed arrays); bakePerson's AbortSignal is only polled.
import { Animation } from '../../animation/dist/index.js';
import { GLTFAsset, PBRModel } from '../../gltf/dist/pbr.js';
import { Army } from '../../navmesh/dist/formations.js';
import { captureScene } from '../../shared/scene-scope.js';
import { soldier } from './soldier.js';

export async function fixtures(load = (entry) => import(entry)) {
  const { bakePerson } = await load('../dist/bake.js');
  const { PersonCrowd } = await load('../dist/lod.js');
  const { addArmy } = await load('../dist/index.js');
  let baked;
  // One bake for every entry: the baked arrays are only read by the crowds.
  const person = (engine) =>
    (baked ??= (async () => {
      const { doc, buffers } = soldier({ rings: 2, sides: 6 }),
        model = new PBRModel(engine, new GLTFAsset(doc, buffers)),
        animation = new Animation(model);
      try {
        return await bakePerson(animation);
      } finally {
        animation.dispose();
        model.dispose();
      }
    })());
  const view = { position: [0, 2, -30], fov: 35 };
  const army = (cavalry) => {
    const value = new Army();
    value.add({ count: 12, shape: 'line', ranks: 2 }).march();
    if (cavalry)
      value.add({ count: 4, kind: 'cavalry', shape: 'line', ranks: 2, position: [0, -20] }).charge({ goal: [0, 200] });
    value.advanceTime(2);
    return value;
  };
  return [
    {
      name: 'PersonCrowd.attach',
      async create({ engine }) {
        const scope = captureScene(engine),
          bake = await person(engine);
        const crowd = await scope.run(() => PersonCrowd.attach(engine, bake));
        crowd.update(
          Array.from({ length: 6 }, (_, i) => ({
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i, 0, 10 + 20 * i, 1],
            clip: 1,
            offset: 0,
          })),
          view,
        );
        return { dispose: () => crowd.dispose() };
      },
    },
    {
      name: 'addArmy',
      async create({ engine }) {
        const scope = captureScene(engine),
          bake = await person(engine);
        const drawn = await scope.run(() => addArmy(engine, army(false), { person: bake, seed: 3 }));
        drawn.update(view);
        return { dispose: () => drawn.dispose() };
      },
    },
    {
      name: 'addArmy with cavalry',
      async create({ engine }) {
        const scope = captureScene(engine),
          bake = await person(engine);
        const drawn = await scope.run(() => addArmy(engine, army(true), { person: bake, seed: 3 }));
        drawn.update(view);
        return { dispose: () => drawn.dispose() };
      },
    },
  ];
}

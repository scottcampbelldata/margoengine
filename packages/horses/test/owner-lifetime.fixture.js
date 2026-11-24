// Owner/lifetime fixture for @margoengine/horses. The engine-facing entries are addHorse (a glTF model built in code, its
// Animation with dual quaternion skinning, strand-hair material features, and the shadows or occlusion it was added
// to) and addHorseCrowd (a baked skinned crowd and its coat atlas texture). Each is advanced once, so the pose and
// instance buffers exist when the owner lets go, and disposed twice (`dispose` is the owner's release and must be safe
// to call again). Not entries: anatomy, gaits, the model document, the seat follower, HorseMotion and the settings
// rows hold nothing with a lifetime (numbers, typed arrays and plain objects); the shadows and occlusion a horse is
// added to are owned by their own packages, whose fixtures cover them.
export async function fixtures(load = (entry) => import(entry)) {
  const { addHorse } = await load('../dist/index.js');
  const { addHorseCrowd } = await load('../dist/crowd.js');
  return [
    {
      name: 'addHorse',
      async create({ engine }) {
        const horse = await addHorse(engine, { type: 'cavalry', coat: 'bay' });
        horse.speed = 2;
        horse.advanceTime(0.1);
        return { dispose: () => horse.dispose() };
      },
    },
    {
      name: 'addHorse without hair',
      async create({ engine }) {
        const horse = await addHorse(engine, { coatHair: false, maneHair: false });
        horse.advanceTime(0.1);
        return { dispose: () => horse.dispose() };
      },
    },
    {
      name: 'addHorseCrowd',
      async create({ engine }) {
        const herd = await addHorseCrowd(engine, { type: 'cavalry', capacity: 8 });
        herd.update([
          { x: 0, z: 0, heading: 0, speed: 1.5, distance: 0 },
          { x: 3, z: 0, heading: 0, speed: 4, distance: 2 },
        ]);
        return { dispose: () => herd.dispose() };
      },
    },
  ];
}

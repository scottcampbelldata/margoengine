import { parseGLTF } from '../../gltf/dist/pbr.js';
import { riggedTestGLB } from './rigged-body.js';

// The model is the caller's, parsed synchronously so its draws, buffers and registration belong to the dependency and
// not to the owner under test. addPerson registers the person's Animation (and its Animator and hands when the model
// has clips) in the model's scene, and dressPerson registers the outfit model and its Animation there: those
// registrations are under test, so neither fixture hands back a plugin of its own (a person or a dressed outfit is no
// plugin). dressPerson's person is its dependency, made without hands so addPerson finishes synchronously inside the
// dependency's scope (with hands it awaits their module, and what it makes after that await would count as the
// outfit's); the person's own registrations are listed as dependencies, not as the outfit's.
export async function fixtures(load = (entry) => import(entry)) {
  const { addPerson } = await load('../dist/index.js');
  const { dressPerson } = await load('../dist/fit.js');
  const body = riggedTestGLB('T');
  const registered = (person) => [person.materials, person.animation, person.animator].filter(Boolean);
  return [
    {
      name: 'addPerson',
      warmUp: "materials' skin profile table (one 64x64 texture), made once per device on the first skin and kept",
      async create({ engine, dependency }) {
        const model = dependency(() => parseGLTF(engine, body));
        const person = await addPerson(engine, model);
        return { dependencies: [model], dispose: () => person.dispose(), cleanup: () => model.dispose() };
      },
    },
    {
      name: 'dressPerson',
      warmUp: "materials' skin profile table under the person (one 64x64 texture), made once per device and kept",
      async create({ engine, dependency }) {
        const model = dependency(() => parseGLTF(engine, body));
        const person = await dependency(() => addPerson(engine, model, { hands: false }));
        const dressed = await dressPerson(engine, person, 'townsman-1910');
        return {
          dependencies: [model, ...registered(person)],
          dispose: () => dressed.dispose(),
          cleanup() {
            person.dispose();
            model.dispose();
          },
        };
      },
    },
  ];
}

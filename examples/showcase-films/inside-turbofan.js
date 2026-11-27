import { loadCAD } from '@margoengine/cad';
import { PbrMaterial } from '@margoengine/core';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { ExplodedView } from '@margoengine/machinery/exploded';
import { Material } from '@margoengine/materials';
import { SSR } from '@margoengine/post/ssr';
import { ColorBackground } from '@margoengine/environment';
import { packedAsset } from '../live/asset-base.js';
import { finishTexture, shotAt } from './film.js';
import { compressorTravel, engineAxis as turningAxis, fanTravel, turbofanAssembly } from './turbofan-assembly.js';
import { turbofanFlow } from './turbofan-flow.js';
const standHeight = 0.77;
const inlet = 1.535;

export async function buildTurbofan(engine, shop, cluster, shadows) {
  const { group, box, ring, beam, sign } = shop;
  const transport = finishTexture(42312, { r: 156, grain: 23, streak: true, mottling: 12 });
  const poured = finishTexture(14111, { r: 192, grain: 41, mottling: 36 });
  const style = (color, roughness, metalness = 0, roughnessMap) =>
    new Material({ color, roughness, metalness, roughnessMap, doubleSided: true });
  const emitter = (color, power) => new Material({ color, roughness: 0.43, emissive: color, emissiveIntensity: power });
  const floor = style('#646b70', 0.53, 0, poured);
  const rubber = style('#242932', 0.82, 0, poured);
  const bare = style('#828c99', 0.36, 1, transport);
  const slate = style('#405262', 0.42, 0, transport);
  const panelBlue = style('#647680', 0.54, 0, transport);
  const yellow = style('#9e7129', 0.55, 0, transport);
  const white = emitter('#e7f2ff', 3.25);
  const apron = style('#424d55', 0.47, 0, poured);
  ColorBackground.attach(engine, { color: '#222d38', bottom: '#3b4b56' });

  // Engine display bay and load-bearing workshop cradle.
  box([29, 0.16, 30], floor, [0, -0.08, 0], undefined, undefined, 0.019);
  for (const x of [-5.6, 5.6]) {
    box([0.22, 5.25, 21], panelBlue, [x, 2.62, 0], undefined, undefined, 0.035);
    box([0.28, 0.22, 21], apron, [x, 0.12, 0], undefined, undefined, 0.035);
    for (let z = -9.5; z <= 10; z += 1.22) {
      box([0.31, 5.2, 0.094], slate, [x, 2.6, z], undefined, undefined, 0.012);
      if (z > -8.95)
        box([0.013, 1.36, 1.15], apron, [x - Math.sign(x) * 0.12, 1.1, z - 0.57], undefined, undefined, 0.008);
    }
    for (const z of [-4.8, 3.2]) {
      box([0.19, 0.51, 1.75], slate, [x - Math.sign(x) * 0.15, 3.45, z], undefined, undefined, 0.036);
      box([0.033, 0.13, 1.5], white, [x - Math.sign(x) * 0.251, 3.29, z], undefined, undefined, 0.012);
    }
  }
  for (const z of [-10.8, 11.1]) {
    box([11.1, 5.29, 0.19], slate, [0, 2.62, z], undefined, undefined, 0.037);
    for (let y = 0.7; y < 3.75; y += 0.31)
      box([5.9, 0.225, 0.041], apron, [0, y, z + (z > 0 ? -0.115 : 0.115)], undefined, undefined, 0.012);
  }
  for (const x of [-2.8, 2.8]) {
    box([0.34, 0.14, 12.5], slate, [x, 4.95, 0], undefined, undefined, 0.04);
    for (const z of [-3.8, 0, 3.6]) box([0.21, 0.034, 2.61], white, [x, 4.87, z], undefined, undefined, 0.007);
  }
  const cradle = group('Transport cradle');
  for (const z of [-1.02, 0.85]) {
    box([1.96, 0.14, 0.23], yellow, [0, 0.245, z], undefined, cradle, 0.025);
    for (const x of [-0.81, 0.81]) {
      ring([0.152, 0.152, 0.135], rubber, [x, 0.154, z], [0, 0, Math.PI / 2], cradle, 28);
      ring([0.074, 0.076, 0.149], bare, [x, 0.154, z], [0, 0, Math.PI / 2], cradle, 22);
      const arm = x * 0.67;
      beam([x, 0.29, z], [arm, 0.925, z], 0.122, yellow, cradle);
      box([0.172, 0.032, 0.177], rubber, [arm, 1.005, z], undefined, cradle, 0.012);
      for (const dx of [-0.065, 0.065])
        ring([0.022, 0.022, 0.017], bare, [x + dx, 0.324, z + 0.064], undefined, cradle, 6);
    }
  }
  for (const x of [-0.62, 0.62]) box([0.126, 0.126, 2.34], yellow, [x, 0.27, -0.085], undefined, cradle, 0.023);
  for (const x of [-2.13, 2.13]) {
    box([0.045, 0.002, 5.7], yellow, [x, 0.002, 0.03]);
    for (const z of [-2.85, 2.9]) box([0.6, 0.002, 0.044], yellow, [x * 0.865, 0.002, z]);
  }
  for (const z of [-3.7, 3.6]) box([10.7, 0.002, 0.022], rubber, [0, 0.002, z]);
  const toolStand = group('Inspection station', null, [-2.67, 0, -0.98]);
  box([0.56, 0.116, 0.48], slate, [0, 0.08, 0], undefined, toolStand, 0.032);
  box([0.087, 1.13, 0.092], bare, [0, 0.64, 0], undefined, toolStand, 0.01);
  box([0.63, 0.306, 0.089], rubber, [0, 1.261, 0.019], [-0.19, 0, 0], toolStand, 0.024);
  sign(['TRAINING CUTAWAY', 'HIGH-BYPASS TURBOFAN'], [0.554, 0.223], [0, 1.262, 0.071], [-0.19, 0, 0], toolStand, {
    background: '#294252',
    foreground: '#b5def1',
    lit: 0.63,
  });

  const [model, coverModel, saddles] = await Promise.all([
    loadGLTF(engine, packedAsset('showcase-films/assets/technical-films/turbofan.glb')),
    loadGLTF(engine, packedAsset('showcase-films/assets/technical-films/turbofan-inspection-cover.glb')),
    loadCAD(engine, packedAsset('showcase-films/assets/technical-films/transport-saddles.step'), {
      linearDeflection: 0.00023,
      signal: AbortSignal.timeout(30000),
    }),
  ]);
  if (saddles.failedFaces || saddles.meshes.length !== 4)
    throw Error('The transport fixture did not import all four support saddles.');
  const machined = new PbrMaterial({ color: '#667984', roughness: 0.58, metalness: 0.46 });
  for (const mesh of saddles.meshes) {
    mesh.setMaterial(machined);
    shadows.add(mesh);
  }
  model.root.setPosition([0, standHeight, 0]);
  const shell = model.nodes.find((node) => node.name === 'Original turbofan quarter cutaway');
  const lookup = new Map(model.nodes.map((node) => [node.name, node]));
  const assembly = (label, names) => {
    const root = group(label, shell);
    for (const name of names) {
      const node = lookup.get(name);
      if (!node) throw Error('Missing turbofan part ' + name);
      node.setParent(root);
    }
    return root;
  };
  const rotor = (name, root) => {
    const spin = group(name, root, [0, turningAxis, 0]);
    lookup.get(name).setParent(spin).setPosition([0, -turningAxis, 0]);
    return spin;
  };
  const nose = assembly('Fan and spinner assembly', ['Spinner']);
  const fanLift = group('Fan service lift', shell);
  nose.setParent(fanLift);
  const fan = rotor('Fan_20_blades', nose);
  const compression = assembly('Compression stage', ['Compressor_case']);
  const compressor = Array.from({ length: 7 }, (_, i) => rotor('Compressor_rotor_' + (i + 1), compression));
  assembly('Combustor assembly', ['Combustor_case', 'Perforated_combustor_liner']);
  const turbine = assembly('Power turbine stage', ['Turbine_case']);
  const wheels = [
    'High_pressure_turbine_1',
    'High_pressure_turbine_2',
    'Low_pressure_turbine_3',
    'Low_pressure_turbine_4',
  ].map((name) => rotor(name, turbine));
  const tail = assembly('Exhaust nozzle', ['Core_nozzle', 'Tail_cone']);
  const cowl = rotor('Nacelle', shell);
  const cover = coverModel.root.setParent(model.root);
  const exploded = ExplodedView.attach(engine, [
    { node: nose, offset: [0, 0, fanTravel] },
    { node: compression, offset: [0, 0, compressorTravel] },
    { node: turbine, offset: [0, 0, -0.67] },
    { node: tail, offset: [0, 0, -1.25] },
  ]);
  const flow = turbofanFlow(engine, standHeight + turningAxis);
  cluster.setLights([
    {
      position: [2.8, 3.95, 2.2],
      direction: [-0.62, -0.59, -0.31],
      color: [0.91, 0.96, 1],
      intensity: 88,
      range: 12,
      angle: 0.69,
      penumbra: 0.53,
    },
    {
      position: [-2.05, 3.3, -2.1],
      direction: [0.54, -0.48, 0.58],
      color: [1, 0.72, 0.43],
      intensity: 77,
      range: 10,
      angle: 0.74,
      penumbra: 0.8,
    },
    {
      position: [2.62, 3.37, -1.5],
      direction: [-0.74, -0.47, 0.29],
      color: [0.47, 0.74, 1],
      intensity: 74,
      range: 9,
      angle: 0.69,
      penumbra: 0.62,
    },
    {
      position: [-1.42, 3.76, 2.71],
      direction: [0.24, -0.47, -0.7],
      color: [0.73, 0.86, 1],
      intensity: 48,
      range: 9,
      angle: 0.62,
      penumbra: 0.57,
    },
  ]);
  const reflection = new SSR({ maxRoughness: 0.54, thickness: 0.07, maxDistance: 10, steps: 36 });
  const shots = [
    [5.4, [0.49, 1.77, 2.99], [0.91, 1.99, 2.69], [0, 1.54, inlet], [0.04, 1.54, 1.1], 40],
    [14.2, [3.97, 2.57, 4.18], [3.82, 2.72, 3.83], [0.16, 1.68, 0.03], [0.35, 1.9, 0.06], 39],
    [21.7, [1.6, 2.24, 2.74], [1.73, 2.4, 2.43], [0, 1.57, 1.12], [0.2, 1.59, 0.98], 39],
    [29.7, [2.1, 2.64, 1.43], [1.87, 2.59, 0.89], [0.26, 1.65, 0.56], [0.29, 1.64, 0.31], 42],
    [39.1, [1.48, 2.27, 1.01], [1.56, 2.17, 0.42], [0.05, 1.57, 0.74], [0.14, 1.56, 0.5], 38],
    [47.6, [1.3, 2.14, 0.17], [1.49, 2.26, -0.43], [0.1, 1.57, 0.03], [0.17, 1.53, -0.28], 39],
    [56.7, [1.76, 2.34, -0.51], [1.58, 2.2, -1.36], [0.06, 1.53, -0.61], [0.02, 1.53, -0.87], 41],
    [68.4, [4.68, 2.92, 2.42], [5.15, 3.33, 2.87], [0.13, 1.88, 0.05], [0.2, 2.2, 0.05], 45],
    [77.4, [4.6, 3.12, -2.51], [4.52, 2.82, -2.72], [0.1, 2.15, 0.0], [0.05, 2.03, -0.08], 46],
    [90, [3.8, 2.44, 3.62], [3.85, 2.22, 4.02], [0.24, 1.71, 0.05], [-0.12, 1.4, 0], 38],
  ];
  const cues = [
    [0.15, 4.55, 'One fan. Two paths for the air.'],
    [6.3, 12.2, 'Inside a civilian turbofan'],
    [15.23, 21.1, 'The fan splits the air into bypass and core streams.'],
    [22.2, 29.1, 'Blue traces the air that flows around the core.'],
    [31.0, 38.3, 'Teal traces the air through the compressor.'],
    [40.1, 43.9, 'Gold traces the separate fuel feed.'],
    [44.1, 47.3, 'Fuel and compressed air meet in the combustor.'],
    [49.3, 56.1, 'Hot gas drives the turbines and exits the nozzle.'],
    [58.0, 61.1, 'The fan and its housing slide forward together.'],
    [61.3, 67.7, 'The housing turns and lifts the fan assembly clear.'],
    [69.2, 76.6, 'Compressor • Combustor • Turbines • Nozzle'],
  ];
  function apply(time) {
    const { cover: coverPosition, inspection, turn, lift } = turbofanAssembly(time);
    cover.setPosition(coverPosition);
    exploded.amount = inspection;
    fanLift.setPosition([0, lift, 0]);
    cowl.setPosition([0, turningAxis + lift, fanTravel * inspection]).setRotation([0, 0, turn]);
    fan.setRotation([0, 0, time * -0.56]);
    for (const node of compressor) node.setRotation([0, 0, time * -1.33]);
    for (const [i, node] of wheels.entries()) node.setRotation([0, 0, time * (i < 2 ? -1.33 : -0.56)]);
    flow.apply(time);
    return shotAt(shots, time);
  }
  return {
    apply,
    cues,
    models: [model, coverModel],
    effects: [reflection],
    receivers: [reflection],
    dispose() {
      exploded.dispose();
      saddles.dispose();
      flow.dispose();
      coverModel.dispose();
      model.dispose();
      transport.dispose();
      poured.dispose();
    },
    inspection: { flowPaths: flow.count, rotorCount: compressor.length + wheels.length + 1 },
  };
}

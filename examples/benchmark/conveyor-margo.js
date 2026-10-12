import { Engine, Geometry, PbrMaterial, box } from "@margoengine/core";
import { conveyorScene, ENTITY_COUNT } from "./conveyor-scene.js";
import { installBenchmark } from "./frame-runner.js";
try {
  const scene = conveyorScene(),
    engine = await Engine.create(document.querySelector("canvas"), {
      backend: "webgpu",
      capacity: ENTITY_COUNT,
      camera: { position: [5, 4, 7], target: [0, 0.4, 0], near: 0.1, far: 100 },
    }),
    geometries = {
      box: box(),
      cylinder: new Geometry(
        scene.cylinder.positions,
        scene.cylinder.normals,
        scene.cylinder.indices,
      ),
    },
    materials = scene.materials.map((value) => new PbrMaterial(value)),
    nodes = [];
  for (const part of scene.nodes) {
    const node = engine.createMesh(part.parent < 0 ? null : nodes[part.parent]);
    node.name = part.name;
    node.setPosition(part.position).setScale(part.scale);
    if (part.geometry)
      node
        .setGeometry(geometries[part.geometry])
        .setMaterial(materials[part.material]);
    nodes.push(node);
  }
  let angle = 0;
  const options = { culling: false, delta: 0 };
  installBenchmark(
    (delta, counts, offset) => {
      angle = (angle + delta * Math.PI * 2) % (Math.PI * 2);
      nodes[scene.motor].rotation.z = angle;
      for (let i = 0; i < scene.shafts.length; i++)
        nodes[scene.shafts[i]].rotation.z = angle;
      options.delta = delta;
      engine.render(options);
      counts[offset] = engine.stats.drawCalls;
      counts[offset + 1] = engine.stats.drawCalls;
    },
    {
      engine: "Margo",
      backend: engine.backend,
      entities: nodes.length,
      renderable: scene.nodes.filter((part) => part.geometry).length,
    },
  );
  window.addEventListener("pagehide", () => engine.dispose(), { once: true });
} catch (error) {
  window.benchmark = { error: String(error) };
  throw error;
}

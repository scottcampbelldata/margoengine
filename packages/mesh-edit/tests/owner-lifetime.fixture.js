// Owner/lifetime fixture for @margoengine/mesh-edit. The editing entries (modeling, boolean, modifiers, remesh, sculpt
// sessions, bake, weights, section, repair, hull) work on typed arrays and plain objects; their sessions release a CPU
// snapshot only. The one entry with an engine lifetime is `@margoengine/mesh-edit/sculpt-view`: SculptView is a plugin
// that makes a gltf/pbr model (GPU vertex and index buffers, a draw) and follows its session every frame. The fixture
// draws a subdivided cube, sculpts it so the next frame uploads a range, then dynamic topology so it rewrites the whole
// mesh; disposal must remove the model and the view, leave the session usable, and a second dispose must do nothing.
export async function fixtures(load = (entry) => import(entry)) {
  const { createPrimitiveMesh } = await load('../dist/index.js');
  const { subdivideMesh } = await load('../dist/modeling.js');
  const { MeshSculptSession } = await load('../dist/sculpt.js');
  const { SculptView } = await load('../dist/sculpt-view.js');
  const session = (options) =>
    new MeshSculptSession(subdivideMesh(createPrimitiveMesh('cube', 'box'), { levels: 2 }).mesh, {
      radius: 0.4,
      ...options,
    });
  const stroke = (sculpt) => {
    const hit = sculpt.pick([0, 0, 4], [0, 0, -1]);
    if (!hit) throw new Error('OWNER_LIFETIME: the sculpt pick missed the mesh');
    sculpt.beginStroke({ brush: 'draw' });
    sculpt.dab(hit.point);
    sculpt.endStroke();
  };
  return [false, true].map((dynamicTopology) => ({
    name: 'SculptView.attach' + (dynamicTopology ? '.dynamic' : ''),
    create({ engine }) {
      const sculpt = session({ dynamicTopology });
      const plugin = SculptView.attach(engine, sculpt);
      stroke(sculpt);
      plugin.onPreUpdate();
      if (plugin.stats.uploadedVertices + plugin.stats.rewrites === 0)
        throw new Error('OWNER_LIFETIME: the sculpt view uploaded nothing after a stroke');
      return { plugin, dispose: () => plugin.dispose() };
    },
  }));
}

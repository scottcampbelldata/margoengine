// three.js side of the vs-three.js benchmark, shared by the WebGL2 and WebGPU entries. The WebGPU build aliases 'three'
// to 'three/webgpu' (run.mjs), as three's docs recommend, so both renderers draw the same scene objects.
// Best practice on three's side (see README "Fairness"): shared geometries and materials, static objects with
// matrixAutoUpdate off and scene.matrixWorldAutoUpdate off, and an InstancedMesh variant ('instanced') next to the
// one-Mesh-per-object variant ('mesh') that most three.js code uses.
import {Scene, PerspectiveCamera, Object3D, Mesh, InstancedMesh, BoxGeometry, BufferGeometry, BufferAttribute, MeshStandardMaterial, DirectionalLight, AmbientLight, Color, Matrix4, Euler, Quaternion, Vector3, DataTexture, RGBAFormat, FloatType, LinearFilter, EquirectangularReflectionMapping, ReinhardToneMapping, ACESFilmicToneMapping, SRGBColorSpace} from 'three';
import {LIGHT, CLEAR, PALETTE, CAD_MATERIALS, CANVAS, boxes, cad, HELMET, sky} from './scenes.js';

export async function threeScene(canvas, {scene: name, n, mode, move}, marks, renderer, backend) {
  renderer.setPixelRatio(1);renderer.setSize(CANVAS[0], CANVAS[1], false);
  renderer.toneMapping = name === 'helmet' ? ACESFilmicToneMapping : ReinhardToneMapping; // gltf-pro maps with ACES(x/0.6), core with Reinhard x/(1+x)
  renderer.outputColorSpace = SRGBColorSpace;
  const scene = new Scene(), sun = new DirectionalLight(0xffffff, LIGHT.intensity);
  scene.background = new Color().setRGB(...CLEAR, SRGBColorSpace);
  sun.position.set(...LIGHT.direction);scene.add(sun);
  if (name !== 'helmet') scene.add(new AmbientLight(0xffffff, LIGHT.ambient * Math.PI));
  let update = () => {}, def;const s = performance.now();
  const compose = (p, r, out = new Matrix4()) => out.compose(new Vector3(...p), new Quaternion().setFromEuler(new Euler(...r)), new Vector3(1, 1, 1));
  const freeze = () => {scene.updateMatrixWorld(true);scene.traverse(o => {o.matrixAutoUpdate = false;});scene.matrixWorldAutoUpdate = false;};
  if (name === 'boxes') {
    def = boxes(n);const geometry = new BoxGeometry(def.size, def.size, def.size), moving = Math.round(n * move);
    if (mode === 'instanced') {
      const mesh = new InstancedMesh(geometry, new MeshStandardMaterial(def.material), n), m = new Matrix4(), color = new Color();
      def.items.forEach((b, i) => {mesh.setMatrixAt(i, compose(b.position, b.rotation, m));mesh.setColorAt(i, color.set(PALETTE[b.color]));});
      scene.add(mesh);freeze();
      if (moving) update = t => {for (let i = 0; i < moving; i++) {const b = def.items[i];mesh.setMatrixAt(i, compose(b.position, [0, b.rotation[1] + t, 0], m));}mesh.instanceMatrix.clearUpdateRanges();mesh.instanceMatrix.addUpdateRange(0, moving * 16);mesh.instanceMatrix.needsUpdate = true;};
    } else {
      const materials = PALETTE.map(color => new MeshStandardMaterial({color, ...def.material}));
      const meshes = def.items.map(b => {const mesh = new Mesh(geometry, materials[b.color]);mesh.position.set(...b.position);mesh.rotation.set(...b.rotation);scene.add(mesh);return mesh;});
      if (moving) {scene.updateMatrixWorld(true);meshes.slice(moving).forEach(m => {m.matrixAutoUpdate = false;});update = t => {for (let i = 0; i < moving; i++) meshes[i].rotation.y = def.items[i].rotation[1] + t;};}
      else freeze();
    }
  } else if (name === 'cad') {
    def = await cad(n);
    const geometries = Object.fromEntries(Object.entries(def.shapes).map(([k, d]) => {const g = new BufferGeometry();g.setAttribute('position', new BufferAttribute(d.positions, 3));g.setAttribute('normal', new BufferAttribute(d.normals, 3));g.setIndex(new BufferAttribute(d.indices, 1));return [k, g];}));
    const materials = Object.fromEntries(Object.entries(CAD_MATERIALS).map(([k, v]) => [k, new MeshStandardMaterial(v)]));
    const objects = [];
    for (const node of def.nodes) {
      const o = node.shape && mode !== 'instanced' ? new Mesh(geometries[node.shape], materials[node.shape]) : new Object3D();
      o.position.set(...node.position);o.rotation.set(...node.rotation);(node.parent < 0 ? scene : objects[node.parent]).add(o);objects.push(o);
    }
    if (mode === 'instanced') { // Same hierarchy, world matrices baked into one InstancedMesh per part shape (static CAD best practice).
      scene.updateMatrixWorld(true);const byShape = {};def.nodes.forEach((node, i) => {if (node.shape) (byShape[node.shape] ??= []).push(objects[i].matrixWorld);});
      scene.remove(objects[0]);
      for (const [shape, list] of Object.entries(byShape)) {const mesh = new InstancedMesh(geometries[shape], materials[shape], list.length);list.forEach((w, i) => mesh.setMatrixAt(i, w));scene.add(mesh);}
    }
    freeze();
  } else if (name === 'helmet') {
    def = HELMET;const {GLTFLoader} = await import('three/addons/loaders/GLTFLoader.js');
    const env = sky(), texture = new DataTexture(env.data, env.width, env.height, RGBAFormat, FloatType);
    texture.mapping = EquirectangularReflectionMapping;texture.magFilter = texture.minFilter = LinearFilter;texture.needsUpdate = true;scene.environment = texture;
    const f = def.floor, floor = new Mesh(new BoxGeometry(...f.size), new MeshStandardMaterial({color: f.color, roughness: f.roughness, metalness: f.metalness}));
    floor.position.set(...f.position);floor.receiveShadow = true;scene.add(floor);
    const gltf = await new GLTFLoader().loadAsync(def.url);gltf.scene.traverse(o => {if (o.isMesh) o.castShadow = o.receiveShadow = true;});scene.add(gltf.scene);
    renderer.shadowMap.enabled = true;sun.castShadow = true;sun.shadow.mapSize.set(def.shadow.resolution, def.shadow.resolution);
    Object.assign(sun.shadow.camera, {left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 20});sun.shadow.camera.updateProjectionMatrix();sun.shadow.bias = -0.0005;sun.shadow.normalBias = 0.02;
    freeze();
  } else throw new Error(`unknown scene ${name}`);
  marks.buildMs = +(performance.now() - s).toFixed(1);
  const cam = def.camera, camera = new PerspectiveCamera(cam.fov, CANVAS[0] / CANVAS[1], cam.near, cam.far);
  const place = t => {camera.position.set(...cam.at(t));camera.lookAt(...cam.target);camera.updateMatrixWorld();};
  const gl = backend === 'webgl' ? renderer.getContext() : undefined, pixel = new Uint8Array(4);let counts = {};
  return {
    gl, samples: gl ? gl.getParameter(gl.SAMPLES) : 4,
    // Read right after the call: WebGPU Info counts drawCalls, WebGL Info counts calls, and either may reset later.
    render(t) {update(t);place(t);renderer.render(scene, camera);const r = renderer.info.render;counts = {drawCalls: r.drawCalls ?? r.calls, triangles: r.triangles};},
    idle: gl ? async () => {gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);} : () => renderer.backend.device.queue.onSubmittedWorkDone(),
    info: () => counts,
  };
}

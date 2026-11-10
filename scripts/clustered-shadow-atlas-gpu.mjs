import assert from 'node:assert/strict';
import { openBrowser } from './browser.js';
const browser = await openBrowser({startPath:'/tests/clustered-shadow.html',port:'free'});
try {
  const page=browser.page;
  await page.waitForFunction(()=>window.clusteredShadowFixture);
  const call=(name,...args)=>page.evaluate(({name,args})=>window.clusteredShadowFixture[name](...args),{name,args});
  const points=[[0,0,0,0,1,0],[3,0,0,0,1,0]],results=[];
  for(const kind of ['point','spot']){
    const light={position:[0,3,0],range:10,intensity:10,...(kind==='spot'?{direction:[0,-1,0],outerAngle:1.2}:{})};
    await call('scene',{meshes:['floor','block'],atlas:true,points:[light]});await call('render',2);
    const off=await call('probe',points);
    await call('scene',{meshes:['floor','block'],atlas:true,points:[{...light,castShadow:true}]});await call('render',2);
    const on=await call('probe',points),compiled=await call('compile');
    assert.deepEqual(compiled,{core:[],probe:[]});
    assert.ok(on[0][0]<off[0][0]*0.05,kind+' blocked');
    assert.ok(Math.abs(on[1][0]/off[1][0]-1)<0.02,kind+' clear');
    results.push({kind,visibility:on.map((p,i)=>p[0]/off[i][0])});
  }
  const spots=[{position:[0,3,0],color:[1,0,0],range:10,intensity:10,direction:[0,-1,0],outerAngle:1.2,shadow:{resolution:64}},
    {position:[3,3,0],color:[0,0,1],range:10,intensity:10,direction:[0,-1,0],outerAngle:1.2,shadow:{resolution:32}}];
  await call('scene',{meshes:['floor','block'],atlas:true,points:spots.map(({shadow:_shadow,...p})=>p)});await call('render',2);
  const separateOff=await call('probe',points);
  await call('scene',{meshes:['floor','block'],atlas:true,points:spots.map(p=>({...p,castShadow:true}))});await call('render',2);
  const separateOn=await call('probe',points);
  assert.ok(separateOn[0][0]<separateOff[0][0]*0.05,'first tile shadows its red light');
  assert.ok(Math.abs(separateOn[0][2]/separateOff[0][2]-1)<0.02,'adjacent smaller tile keeps blue light clear');
  assert.ok(Math.abs(separateOn[1][0]/separateOff[1][0]-1)<0.02,'first tile is clear away from blocker');
  // Rectangles and spheres share the same packed image and filtering without index collisions.
  await call('scene',{meshes:['floor','block'],atlas:true,
    areas:[{position:[0,3,0],direction:[0,-1,0],width:0.3,height:0.3,castShadow:true}],
    shapes:[{shape:'sphere',position:[0,3,0],radius:0.15,castShadow:true}]});
  await call('render',2);
  const area=await call('probe',points);
  assert.ok(area[0][0]<area[1][0]*0.05);
  assert.deepEqual(await page.evaluate(()=>window.clusteredShadowFixture.errors),[]);
  // Cached faces on a real GPU. A dark floor and a tall box under low, bright point and spot lights, seen from close,
  // keep the shadows large and in the steep part of the tone curve (a pale floor with a short box seen from afar
  // darkened the picture by a mean of only 0.6 of 255, too little to tell shadows from none). The atlas, with every
  // face at 512 texels, must match LocalShadows at 512 within rounding; a still frame re-renders no face and draws the
  // same picture; a moved box re-renders only the faces it reaches.
  const cache = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js'),
      core = await import('/packages/core/dist/extension.js'),
      { Clustered } = await import('/packages/clustered/dist/index.js'),
      { LocalShadows } = await import('/packages/clustered/dist/shadows.js'),
      { ShadowAtlas } = await import('/packages/clustered/dist/shadow-atlas.js');
    const width = 128, canvas = document.createElement('canvas');
    canvas.style.cssText = `width:${width}px;height:${width}px`;
    document.body.append(canvas);
    const instance = await EngineKernel.create(canvas, { backend: 'webgpu', capacity: 4,
        camera: { position: [0, 4, 3], target: [0, 0, 0], fov: 50, near: 0.1, far: 40 } }),
      engine = core.engineRuntime(instance), uncaptured = [];
    instance.stop();
    engine.gpu.addEventListener('uncapturederror', (event) => uncaptured.push(event.error.message));
    const grey = new core.PbrMaterial({ color: [0.25, 0.25, 0.25], roughness: 0.6 });
    const floor = instance.createMesh().setGeometry(core.box()).setScale([8, 0.2, 8]).setPosition([0, -0.1, 0]);
    floor.setMaterial(grey);
    const box = instance.createMesh().setGeometry(core.box()).setScale([0.8, 1.6, 0.8]).setPosition([0.3, 0.8, 0.2]);
    box.setMaterial(grey);
    const lit = Clustered.attach(instance);
    lit.setLights([
      { position: [1.5, 2.2, 1.3], range: 9, intensity: 30, castShadow: true },
      { position: [-1.8, 2.2, -0.4], range: 9, direction: [0.6, -1, 0.3], outerAngle: 0.7, intensity: 40, castShadow: true },
    ]);
    const device = engine.gpu, context = canvas.getContext('webgpu'), bytesPerRow = width * 4;
    let current;
    context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(),
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const getCurrentTexture = context.getCurrentTexture.bind(context);
    context.getCurrentTexture = () => (current = getCurrentTexture());
    const render = async () => {
      const read = device.createBuffer({ size: bytesPerRow * width, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      instance.render({ culling: false });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: current }, { buffer: read, bytesPerRow }, [width, width]);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const bytes = Array.from(new Uint8Array(read.getMappedRange()));
      read.destroy();
      return bytes;
    };
    const none = await render();
    const local = LocalShadows.attach(instance, { lights: lit, resolution: 512 });
    local.add(floor);
    local.add(box);
    await render();
    const reference = await render();
    local.dispose();
    // The camera is inside both ranges, so coverage is the view (128 px); density 8 asks more than the 512 cap.
    const atlas = ShadowAtlas.attach(instance, { lights: lit, resolution: 4096, maxResolution: 512, texelDensity: 8 });
    atlas.add(floor);
    atlas.add(box);
    const first = await render(), firstFaces = atlas.stats.layers, tiles = atlas.layout.map((t) => t.size),
      cached = await render(), cachedFaces = atlas.stats.layers;
    box.setPosition([0.3, 0.7, 0.2]);
    await render();
    const movedFaces = atlas.stats.layers;
    atlas.dispose();
    instance.dispose();
    canvas.remove();
    return { none, reference, first, cached, firstFaces, cachedFaces, movedFaces, tiles, uncaptured };
  });
  assert.deepEqual(cache.uncaptured, [], 'no validation error on the cached atlas engine');
  const compare = (a, b) => {
    let sum = 0, worst = 0;
    for (let i = 0; i < a.length; i += 4)
      for (let k = 0; k < 3; k++) {
        const d = Math.abs(a[i + k] - b[i + k]);
        sum += d;
        worst = Math.max(worst, d);
      }
    return { mean: sum / ((a.length / 4) * 3), worst };
  };
  assert.deepEqual(cache.tiles, [512, 512, 512, 512, 512, 512, 512], 'every face at 512 texels');
  assert.equal(cache.firstFaces, 7, 'six cube faces and one spot face on the first frame');
  assert.equal(cache.cachedFaces, 0, 'nothing moved: no face re-renders');
  assert.ok(cache.movedFaces >= 1 && cache.movedFaces < 7, `a moved box re-renders some faces: ${cache.movedFaces}`);
  const shadowed = compare(cache.reference, cache.none), match = compare(cache.first, cache.reference),
    same = compare(cache.cached, cache.first);
  assert.ok(shadowed.mean > 2, `LocalShadows darkens the scene: mean ${shadowed.mean}`);
  assert.equal(same.worst, 0, 'the cached frame draws the same picture');
  // Same maps and filter; only the UV mapping into the atlas differs (float32 rounding at shadow edges).
  assert.ok(match.mean < 0.05 * shadowed.mean && match.worst <= 64, `atlas vs LocalShadows: ${JSON.stringify(match)}`);
  results.push({ kind: 'cached', match, shadowed: shadowed.mean, faces: [cache.firstFaces, cache.cachedFaces, cache.movedFaces] });
  console.log(JSON.stringify(results));
}finally{await browser.close();}

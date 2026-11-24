import { SDFScene2D } from '/packages/lighting2d/dist/sdf.js';
import { GILighting2D, RadianceCascade2D } from '/packages/lighting2d/dist/gi.js';
import { Light2D } from '/packages/lighting2d/dist/index.js';
import { readHDR } from './emission-regressions.js';

async function readBuffer(device, source) {
  const copy = device.createBuffer({ size: source.size, usage: 1 | 8 });
  const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(source, 0, copy, 0, source.size);
  device.queue.submit([encoder.finish()]); await copy.mapAsync(1);
  const values = new Float32Array(copy.getMappedRange()).slice(); copy.destroy(); return values;
}

export async function giHistoryRegressions({ instance, engine, texture, frame, checks, errors }) {
  engine.gpu.pushErrorScope('validation');
  // Writable cached buffers are observed directly: a static frame must not trace/overwrite them.
  const device = engine.gpu, create = device.createBuffer.bind(device), cached = [];
  device.createBuffer = descriptor => {
    const cache = /^gi (cascade\d+|surface\d+)$/.test(descriptor.label ?? '');
    const buffer = create(cache ? { ...descriptor, usage: descriptor.usage | 4 } : descriptor);
    if (cache) cached.push(buffer);
    return buffer;
  };
  const target = texture('rgba16float', 2, 2);
  const pass = GILighting2D.attach(instance, { target, cascades: { cascades: 2, bounces: 2 },
    occluders: [{ shape: 'segment', from: [5, -2], to: [5, 2] }] });
  frame(); device.createBuffer = create;
  for (const buffer of cached) device.queue.writeBuffer(buffer, 0, new Float32Array(buffer.size / 4).fill(.125));
  frame();
  let preserved = 0;
  for (const buffer of cached) if ((await readBuffer(device, buffer)).every(v => v === .125)) preserved++;
  checks['GI temporal reuse preserves surface and probe intervals without recomputing'] = { wrong: cached.length === 3 && preserved === 3 ? 0 : 1 };
  pass.resetHistory(); frame();
  let cleared = 0;
  for (const buffer of cached) {
    const values = await readBuffer(device, buffer);
    // Empty cascades have radiance=0, transmittance either 0 or 1; opaque surfaces are all zero.
    if (values.every(v => v === 0 || v === 1)) cleared++;
  }
  checks['GI resetHistory rebuilds cached intervals'] = { wrong: cleared === cached.length ? 0 : 1 };
  pass.temporal = false;
  for (const buffer of cached) device.queue.writeBuffer(buffer, 0, new Float32Array(buffer.size / 4).fill(.125));
  frame();
  let rebuilt = 0;
  for (const buffer of cached) if ((await readBuffer(device, buffer)).every(v => v === 0 || v === 1)) rebuilt++;
  checks['GI temporal false recomputes every interval'] = { wrong: rebuilt === cached.length ? 0 : 1 };
  pass.dispose(); target.destroy();

  const width = 7, height = 7, bytes = new Uint8Array(width * height * 4), edges = [];
  const occupied = (x, y) => x >= 0 && x < width && y >= 0 && y < height && (x === 0 || x === 6 || y === 6);
  const faces = [
    [-1, 0, (x,y) => [[x,y],[x,y+1]]], [1, 0, (x,y) => [[x+1,y],[x+1,y+1]]],
    [0, -1, (x,y) => [[x,y],[x+1,y]]], [0, 1, (x,y) => [[x,y+1],[x+1,y+1]]],
  ];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (occupied(x,y)) {
    bytes.set([255, 255, 255, 255], (y * width + x) * 4);
    for (const [dx,dy,segment] of faces) if (!occupied(x+dx,y+dy)) {
      const [from,to] = segment(x,y); edges.push({ shape: 'segment', from, to });
    }
  }
  const source = texture('rgba8unorm', width, height), emission = texture('rgba8unorm', width, height);
  device.queue.writeTexture({ texture: source }, bytes, { bytesPerRow: width*4 }, [width,height]);
  const painted = new SDFScene2D({ source, emission });
  const emitters = [{ x: 3.5, y: 1.5, radius: .7, color: [1,.3,.1] }];
  let output = texture('rgba16float', 3, 3);
  const orders = [];
  for (const bounces of [0, 1, 2, 4]) {
    const options = { cascades: 2, baseRays: 8, baseDistance: 12, angularRatio: 2, bounces, albedo: .7 };
    const gi = GILighting2D.attach(instance, { target: output, painted, emitters,
      camera: { x: 2, y: 3, zoom: 1 }, cascades: options });
    frame();
    const values = await readHDR(device, output), rc = new RadianceCascade2D(options);
    let wrong = 0;
    for (let y=0;y<3;y++) for (let x=0;x<3;x++) {
      const cpu = rc.evaluateAt([x+2.5,y+3.5], undefined, { emitters, occluders: edges });
      if (cpu.some((v,c) => Math.abs(v-values[(y*3+x)*4+c]) > .001)) wrong++;
    }
    checks[`GI painted diffuse order ${bounces} matches independent analytic faces`] = { wrong };
    orders.push(values[0]);
    frame();
    const reused = await readHDR(device, output);
    checks[`GI painted diffuse order ${bounces} stable reuse`] = { wrong: reused.some((v,i)=>v!==values[i]) ? 1 : 0 };
    gi.dispose();
  }
  checks['GI painted surfaces transport distinct bounce orders'] = { wrong: orders.every((v,i)=>!i || v>orders[i-1]) ? 0 : 1, orders };

  // Two independent GI passes share one painted scene. Texel changes must invalidate both consumers.
  const a = texture('rgba16float', 1, 1), b = texture('rgba16float', 1, 1);
  const shared = [a,b].map(target => GILighting2D.attach(instance, { target, painted,
    camera: { x: 0, y: 0, zoom: 1 }, cascades: { cascades: 2, bounces: 0 } }));
  const em = new Uint8Array(width*height*4); em.set([255,0,0,255]);
  device.queue.writeTexture({ texture: emission }, em, { bytesPerRow: width*4 }, [width,height]);
  frame(); frame();
  em.set([0,255,0,255]);
  device.queue.writeTexture({ texture: emission }, em, { bytesPerRow: width*4 }, [width,height]);
  frame();
  const colors = await Promise.all([a,b].map(t=>readHDR(device,t)));
  checks['GI exact texel changes invalidate all painted consumers in one frame'] = { wrong: colors.every(c=>c[0]===0 && c[1]===1) ? 0 : 1 };
  for (const gi of shared) gi.dispose(); a.destroy(); b.destroy();

  const light = new Light2D({ x: 3.5, y: 2, radius: 15, height: 0, color: '#ff0000' });
  const gi = GILighting2D.attach(instance, { target: () => output, painted, lights: [light],
    camera: { x: 2, y: 3, zoom: 1 }, cascades: { cascades: 2, baseRays: 8, baseDistance: 12, angularRatio: 2, bounces: 2 } });
  const freshEqual = async name => {
    frame(); const reused = await readHDR(device, output); gi.resetHistory(); frame();
    const fresh = await readHDR(device, output);
    checks[name] = { wrong: reused.some((v,i)=>v!==fresh[i]) ? 1 : 0 };
    return reused;
  };
  frame(); frame(); light.color = '#00ff00';
  await freshEqual('GI direct light color invalidates bounce history');
  light.mask = { kind: 'polygon', points: [[0,0],[7,0],[7,7],[0,7]] };
  frame(); light.mask.points[1][0] = 0;
  await freshEqual('GI in-place polygon mask edits invalidate history');
  gi.camera.x = 2.25;
  await freshEqual('GI camera movement invalidates history without trails');
  painted.alphaThreshold = 1; painted.emissionIntensity = 3; painted.camera.x = -.125;
  await freshEqual('GI painted configuration invalidates interval history');
  bytes.set([0,0,0,0], (3*width)*4);
  device.queue.writeTexture({ texture: source }, bytes, { bytesPerRow: width*4 }, [width,height]);
  await freshEqual('GI painting alpha invalidates bounce history');
  // Changing albedo only also invalidates the field, even with identical occupancy/distance.
  bytes.set([64,128,192,255], (4*width)*4);
  device.queue.writeTexture({ texture: source }, bytes, { bytesPerRow: width*4 }, [width,height]);
  await freshEqual('GI painted albedo-only changes invalidate history');
  output.destroy(); output = texture('rgba16float', 2, 4);
  await freshEqual('GI target resize invalidates probe allocation/history');
  gi.dispose(); output.destroy(); source.destroy(); emission.destroy(); painted.dispose();
  const validation = await device.popErrorScope(); if (validation) errors.push(validation.message);
}

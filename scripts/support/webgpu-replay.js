// Replays one frame recorded by webgpu-trace.js with no engine code: the same objects (descriptors, shader text,
// buffer and texture bytes) and the same calls, `frames` times on a fresh device. After the last render pass that
// draws into a multisampled colour view, a compute pass copies the 4 samples of `pixel`; the result lists each
// distinct sample set and how often it came. `skip` (render pass numbers, from 0 in the frame's order) keeps those
// passes' clears and loads but drops their draws. `blendMask` sets that sample mask on every blended multisampled
// pipeline. `whole` also compares the whole canvas of each frame with the most common frame. Used by
// scripts/support/webgpu-replay.html.
import { fromBase64, revive, textureSize, toBase64 } from './webgpu-trace.js';

/** Creates the trace's objects on `device`; returns the id -> object map. */
export async function buildTrace(device, trace, { blendMask } = {}) {
  const made = new Map(),
    get = (id) => made.get(id),
    BU = GPUBufferUsage,
    TU = GPUTextureUsage;
  for (const id of Object.keys(trace.objects)
    .map(Number)
    .sort((a, b) => a - b)) {
    const o = trace.objects[id];
    if (o.t === 'commandBuffer' || o.t === 'encoder' || o.t === 'pass') continue;
    const desc = revive(o.desc, get);
    let r;
    switch (o.t) {
      case 'buffer':
        r = device.createBuffer({ ...desc, usage: desc.usage | BU.COPY_DST });
        if (trace.data[id]) device.queue.writeBuffer(r, 0, fromBase64(trace.data[id]));
        break;
      case 'texture': {
        const many = (desc.sampleCount ?? 1) > 1,
          depth = /depth|stencil/.test(desc.format);
        r = device.createTexture({
          ...desc,
          usage: desc.usage | (depth ? 0 : many ? TU.TEXTURE_BINDING : TU.COPY_DST),
        });
        const [w, h, layers] = textureSize(desc);
        trace.data[id]?.levels.forEach((level, m) => {
          const mh = Math.max(1, h >> m);
          device.queue.writeTexture(
            { texture: r, mipLevel: m },
            fromBase64(level.data),
            { bytesPerRow: level.row, rowsPerImage: mh },
            [Math.max(1, w >> m), mh, layers],
          );
        });
        break;
      }
      case 'canvasTexture':
        r = device.createTexture({ size: desc.size, format: desc.format, usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC });
        break;
      case 'view':
        r = get(o.texture).createView(desc);
        break;
      case 'autoLayout':
        r = get(o.pipeline).getBindGroupLayout(o.index);
        break;
      case 'bundle': {
        const encoder = device.createRenderBundleEncoder(desc);
        for (const [name, args] of o.calls) encoder[name](...revive(args, get));
        r = encoder.finish();
        break;
      }
      case 'createRenderPipeline':
        r = await device.createRenderPipelineAsync(
          blendMask !== undefined && desc.multisample?.count > 1 && desc.fragment?.targets?.some((t) => t?.blend)
            ? { ...desc, multisample: { ...desc.multisample, mask: blendMask } }
            : desc,
        );
        break;
      case 'createComputePipeline':
        r = await device.createComputePipelineAsync(desc);
        break;
      default:
        r = device[o.t](desc);
    }
    made.set(id, r);
  }
  return made;
}

/** Replays the trace's frame `frames` times; returns the distinct sample sets at `pixel` and the frames that differ from the first. */
export async function replayTrace(
  device,
  trace,
  { frames = 100, pixel = [0, 0], skip = [], blendMask, whole = false } = {},
) {
  const made = await buildTrace(device, trace, { blendMask }),
    get = (id) => made.get(id),
    skipped = new Set(skip);
  const multisampled = (view) =>
    Object.entries(trace.objects).some(
      ([id, o]) =>
        o.t === 'view' && made.get(Number(id)) === view && (trace.objects[o.texture].desc.sampleCount ?? 1) > 1,
    );
  const passes = trace.calls.filter((c) => c[0] === 'beginRenderPass'),
    drawing = new Set(trace.calls.filter((c) => /^draw|^executeBundles$/.test(c[0])).map((c) => c[1])),
    probed = passes.findLastIndex(
      (c) => drawing.has(c[3]) && multisampled(revive(c[2][0].colorAttachments[0].view, get)),
    );
  if (probed < 0 && !whole)
    throw new Error('webgpu-replay: the frame draws into no multisampled colour view; nothing to probe');
  const probedPass = passes[probed]?.[3],
    target = probed < 0 ? undefined : revive(passes[probed][2][0].colorAttachments[0].view, get);
  const probe = device.createComputePipeline({
    layout: 'auto',
    compute: {
      entryPoint: 'main',
      module: device.createShaderModule({
        code: `@group(0) @binding(0) var ms:texture_multisampled_2d<f32>;@group(0) @binding(1) var<storage,read_write> out:array<u32,4>;
@compute @workgroup_size(1) fn main(){for(var s=0u;s<4u;s++){out[s]=pack4x8unorm(textureLoad(ms,vec2i(${pixel[0]},${pixel[1]}),i32(s)));}}`,
      }),
    },
  });
  const ring = device.createBuffer({ size: frames * 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const live = new Map(),
    owner = new Map(),
    canvases = [];
  const canvasId = Object.keys(trace.objects).find((id) => trace.objects[id].t === 'canvasTexture');
  for (let f = 0; f < frames; f++) {
    let pass = -1,
      skipping = false;
    for (const [name, targetId, args, result] of trace.calls) {
      const a = revive(args, get);
      if (name === 'createCommandEncoder') live.set(targetId, device.createCommandEncoder());
      else if (name === 'beginRenderPass' || name === 'beginComputePass') {
        if (name === 'beginRenderPass') skipping = skipped.has(++pass);
        live.set(result, live.get(targetId)[name](...a));
        owner.set(result, targetId);
      } else if (name === 'finish') made.set(result, live.get(targetId).finish());
      else if (name === 'submit' || name === 'writeBuffer' || name === 'writeTexture') device.queue[name](...a);
      else if (skipping && /^draw|^executeBundles$/.test(name)) continue;
      else {
        live.get(targetId)[name](...a);
        if (name === 'end' && targetId === probedPass) {
          const p = live.get(owner.get(targetId)).beginComputePass();
          p.setPipeline(probe);
          p.setBindGroup(
            0,
            device.createBindGroup({
              layout: probe.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: target },
                { binding: 1, resource: { buffer: ring, offset: f * 256, size: 16 } },
              ],
            }),
          );
          p.dispatchWorkgroups(1);
          p.end();
        }
      }
    }
    if (whole) canvases.push(await readCanvas(device, made.get(Number(canvasId)), trace.objects[canvasId].desc));
    await device.queue.onSubmittedWorkDone();
  }
  const staging = device.createBuffer({ size: frames * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(ring, 0, staging, 0, frames * 256);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const words = new Uint32Array(staging.getMappedRange()).slice();
  staging.destroy();
  ring.destroy();
  const seen = new Map(),
    differ = [];
  let first;
  for (let f = 0; f < frames; f++) {
    const value = sampleSet(words.subarray(f * 64, f * 64 + 4));
    first ??= value;
    if (value !== first) differ.push(f);
    seen.set(value, (seen.get(value) ?? 0) + 1);
  }
  return {
    renderPasses: passes.length,
    probedPass: probed,
    values: [...seen],
    differ,
    ...(whole ? compareFrames(canvases) : {}),
  };
}

/** The canvas stand-in's bytes (4 per texel, rows tightly packed). */
async function readCanvas(device, texture, { size: [width, height] }) {
  const row = Math.ceil((width * 4) / 256) * 256,
    staging = device.createBuffer({ size: row * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow: row }, [width, height]);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(staging.getMappedRange()),
    bytes = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) bytes.set(mapped.subarray(y * row, y * row + width * 4), y * width * 4);
  staging.destroy();
  return { width, height, bytes };
}

/** How each frame differs from the most common frame: `{ frameSets, wholeDiffer: [{ frame, pixels, max, first }], reference }`. */
export function compareFrames(canvases) {
  const count = new Map();
  for (const c of canvases) {
    let h = 2166136261;
    for (let i = 0; i < c.bytes.length; i++) h = Math.imul(h ^ c.bytes[i], 16777619);
    const entry = count.get(h) ?? { n: 0, canvas: c };
    entry.n++;
    count.set(h, entry);
  }
  const common = [...count.values()].sort((a, b) => b.n - a.n)[0].canvas,
    wholeDiffer = [];
  canvases.forEach((c, frame) => {
    let pixels = 0,
      max = 0,
      first;
    for (let i = 0; i < c.bytes.length; i += 4) {
      const d = Math.max(
        Math.abs(c.bytes[i] - common.bytes[i]),
        Math.abs(c.bytes[i + 1] - common.bytes[i + 1]),
        Math.abs(c.bytes[i + 2] - common.bytes[i + 2]),
      );
      if (d) {
        pixels++;
        if (d > max) max = d;
        first ??= [(i / 4) % c.width, Math.floor(i / 4 / c.width)];
      }
    }
    if (pixels) wholeDiffer.push({ frame, pixels, max, first });
  });
  return {
    frameSets: count.size,
    wholeDiffer,
    reference: { width: common.width, height: common.height, bytes: toBase64(common.bytes) },
  };
}

/** Four packed RGBA8 samples as 'r.g.b|r.g.b|r.g.b|r.g.b'. */
export function sampleSet(words) {
  return [...words].map((u) => [u & 255, (u >>> 8) & 255, (u >>> 16) & 255].join('.')).join('|');
}

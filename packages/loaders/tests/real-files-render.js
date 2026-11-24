// The page of scripts/real-files-render.mjs: one engine, one parsed file at a time, one picture.
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { createMeshes } from '@margoengine/loaders';
import { createPBRMeshes } from '@margoengine/loaders/render';
import { Line, Lines } from '../../lines/dist/index.js';

const canvas = document.getElementById('view');
const engine = await Engine.create(canvas, { backend: 'webgpu' });
engine.stop();
const lines = Lines.attach(engine),
  errors = [];
engineRuntime(engine).gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

/** Reads the frame in the task that rendered it, before it is presented. */
function snapshot() {
  engine.render();
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const context = copy.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0);
  return { copy, pixels: context.getImageData(0, 0, copy.width, copy.height).data };
}

const empty = snapshot().pixels;

function unpack(buffer) {
  const size = new DataView(buffer).getUint32(0, true),
    head = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, size))),
    geometry = { kind: head.kind, groups: head.groups };
  let at = 4 + size;
  for (const [name, [type, length]] of Object.entries(head.arrays)) {
    geometry[name] = new (type === 'u32' ? Uint32Array : Float32Array)(buffer, at, length);
    at += length * 4;
  }
  return { geometry, radius: head.radius, pbr: head.pbr };
}

window.drawRealFile = async () => {
  const { geometry, radius, pbr } = unpack(await (await fetch('/real-files-payload')).arrayBuffer());
  errors.length = 0;
  let release;
  if (geometry.kind === 'lines') {
    const line = lines.add(new Line({ positions: geometry.positions, mode: 'segments', width: 1.5, color: '#3070d0' }));
    release = () => lines.remove(line);
  } else if (pbr) {
    const model = createPBRMeshes(engine, geometry);
    release = () => model.dispose();
  } else {
    const made = createMeshes(engine, geometry);
    release = made.dispose;
  }
  engine.camera.near = radius / 100;
  engine.camera.far = radius * 100;
  engine.camera.target = [0, 0, 0];
  engine.camera.position = [radius * 1.3, radius * 1.1, radius * 1.7];
  const { copy, pixels } = snapshot();
  let changed = 0;
  for (let i = 0; i < pixels.length; i += 4)
    if (Math.abs(pixels[i] - empty[i]) + Math.abs(pixels[i + 1] - empty[i + 1]) + Math.abs(pixels[i + 2] - empty[i + 2]) > 30)
      changed++;
  const png = copy.toDataURL('image/png');
  release();
  return { changed, png, errors: [...errors] };
};

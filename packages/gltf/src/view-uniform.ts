// The camera, light and target rows of the PBR shader, in one small uniform per view that every draw of the view binds.
// They used to live in each draw's own uniform: a moving camera changed every draw's block every frame, so 10,000
// meshes uploaded 10 MB a frame (and compared and copied all of it on the CPU). Now a draw's own block holds only what
// belongs to it (node matrices, material rows) and stays unchanged while the mesh and its material do.
import { currentFrame, retire } from '../../shared/frame-resources.js';
import { acquireUniform, onUniformsIdle, type UniformSlot } from './uniform-arena.js';

/** Floats in a view block: camera and view matrices, eye, light direction, radiance, flags (x: HDR target). */
export const viewFloats = 48;

/** Pipelines whose shader binds `margoView`. */
export const viewPipelines = new WeakSet<GPURenderPipeline>();

interface ViewBlock {
  slot: UniformSlot;
  /** The view it holds: the pass context's `view` (else the context) and, for a caller-supplied view, the drawer. */
  view: object;
  owner: object | undefined;
  /** The frame it was last written in. */
  frame: number;
}
const pools = new WeakMap<GPUDevice, ViewBlock[]>();

/**
 * The binding of the view block that `view`'s draws bind this frame on `device`, holding `data` (`viewFloats` floats).
 * Every draw of a view shares one block, as a draw's own uniform used to be shared by all its views' passes: a second
 * view of a frame (a viewport, a probe face) has a block of its own, and a later write from the same view replaces the
 * values, as before. `owner` separates draws with a caller-supplied view matrix (stereo eyes), each of which kept its
 * own uniforms. A view keeps its block frame after frame, so bind groups stay the same, a steady view uploads nothing
 * and a moving camera uploads its 192 bytes once.
 */
export function viewBinding(device: GPUDevice, data: Float32Array, view: object, owner?: object): GPUBufferBinding {
  let blocks = pools.get(device);
  if (!blocks) {
    const created: ViewBlock[] = (blocks = []);
    pools.set(device, created);
    // When the device's last draw lets go of its uniforms, the view blocks go too (after any frame still recording).
    onUniformsIdle(device, () => {
      if (pools.get(device) === created) pools.delete(device);
      for (const block of created) retire(device, block.slot);
      created.length = 0;
    });
  }
  const now = currentFrame(device, view);
  // This view's block; else, a block another view drew this frame with the same values (shared); else one no view drew
  // this frame (views made fresh every frame reuse blocks instead of growing the pool); else a new one.
  let block: ViewBlock | undefined, free: ViewBlock | undefined;
  for (let i = 0; i < blocks.length; i++) {
    const value = blocks[i];
    if (value.view === view && value.owner === owner) {
      block = value;
      break;
    }
    if (value.frame !== now) free ??= value;
    else if (!block) {
      const held = value.slot.contents;
      let same = true;
      for (let k = 0; same && k < viewFloats; k++) same = held[k] === data[k];
      if (same) block = value;
    }
  }
  if (block && (block.view !== view || block.owner !== owner)) return block.slot.binding;
  if (!block) {
    block = free ?? { slot: acquireUniform(device, viewFloats, true), view, owner, frame: now };
    if (!free) blocks.push(block);
    block.view = view;
    block.owner = owner;
  }
  block.frame = now;
  block.slot.write(data, view);
  return block.slot.binding;
}

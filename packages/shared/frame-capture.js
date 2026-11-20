// Drawing core's lit shader from another camera, for captures (`LightBounce` of @margoengine/clustered/bounce; the
// row to move LightProbes onto it is filed): the shader's `frame` is rebound to the capture's own Frame at `binding`,
// core's binding 0 stays statically used, a camera patch's clip transform gives way to the capture's camera, and the
// fragment's output (tone-mapped by core, or linear for a post stack) is replaced by `tail`.
import { fault } from './errors.js';

/**
 * Core's lit shader `shader`, with every surface patch kept, rebound to a Frame at `binding` of group 0 and ending in
 * `tail` (a WGSL statement in the fragment's `i`, `frame` and `linear`).
 * @throws MargoError `unsupported` when core's shader was replaced (no Frame at binding 0, no clip transform, or no
 * tone-mapped or linear return).
 */
export function frameCapture(shader, binding, tail, feature) {
  const code = shader
    .replace(
      '@group(0) @binding(0) var<uniform> frame:Frame;',
      `@group(0) @binding(0) var<uniform> margoMainFrame:Frame;\n@group(0) @binding(${binding}) var<uniform> frame:Frame;`,
    )
    .replace('@vertex fn vertex(i:Input)->Output {', '@vertex fn vertex(i:Input)->Output {_=margoMainFrame.eye;')
    // A patched clip transform (TAA's jittered `taaCamera`) gives way to the capture's camera; its uniform stays
    // statically used, so its binding stays in the bind group.
    .replace(/o\.clip=(?!frame\.camera\*)([A-Za-z_]\w*)\*p;/, 'o.clip=frame.camera*p;_=$1;')
    // Core tone-maps (`let mapped=...`) unless a post stack takes the linear radiance (`return vec4f(linear,1);`).
    .replace(/let mapped=[\s\S]*?return vec4f\([^\n]+\);|return vec4f\(linear,1\);/, () => `if(false){_=linear;}${tail}`);
  if (
    !code.includes('margoMainFrame:Frame') ||
    !code.includes('_=margoMainFrame') ||
    !code.includes('o.clip=frame.camera*p') ||
    !code.includes(tail)
  )
    throw fault(
      'unsupported',
      `${feature} requires the standard core lighting shader; remove the plugin that replaced core's shader`,
      'webgpu',
    );
  return code;
}

/**
 * The render pipeline that draws a capture: WGSL `code` (from {@link frameCapture}) with core's vertex `buffers`, one
 * `rgba16float` target, depth in `depthFormat` (reversed Z, as core draws), no culling (a capture sees back faces).
 */
export function capturePipeline(device, code, buffers, depthFormat) {
  const module = device.createShaderModule({ code });
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vertex', buffers },
    fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
    depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'greater-equal' },
    primitive: { cullMode: 'none' },
  });
}

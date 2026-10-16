import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import type { Shadows } from '@margoengine/shadows';

declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

/** One-shot, opt-in visualization of the real directional depth map, never a proxy scene render. */
export async function showShadowDebug(engine: EngineKernel, shadows: Shadows, parent: HTMLElement, layer = 0) {
  const device = engineRuntime(engine).gpu,
    texture = shadows.depthTexture;
  if (!device || !texture) throw new Error('Render the WebGPU shadow map before requesting its diagnostic view');
  if (!Number.isInteger(layer) || layer < 0 || layer >= texture.depthOrArrayLayers)
    throw new RangeError('Invalid shadow map layer');
  const width = texture.width,
    height = texture.height,
    bytesPerRow = Math.ceil((width * 4) / 256) * 256,
    stride = bytesPerRow / 4,
    buffer = device.createBuffer({
      label: 'one-shot shadow diagnostic readback',
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture, origin: [0, 0, layer], aspect: 'depth-only' },
      { buffer, bytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const depths = new Float32Array(buffer.getMappedRange());
    let left = width,
      top = height,
      right = -1,
      bottom = -1,
      occupied = 0,
      minDepth = Infinity,
      maxDepth = -Infinity;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const d = depths[y * stride + x];
        if (!Number.isFinite(d) || d < 0 || d >= 1 - 1e-6) continue;
        occupied++;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        minDepth = Math.min(minDepth, d);
        maxDepth = Math.max(maxDepth, d);
      }
    const bbox = occupied ? [left, top, right, bottom] : null,
      widthPercent = occupied ? ((right - left + 1) / width) * 100 : 0,
      heightPercent = occupied ? ((bottom - top + 1) / height) * 100 : 0,
      coveragePercent = (occupied / (width * height)) * 100,
      metrics = {
        sampledAt: new Date().toISOString(),
        layer,
        width,
        height,
        occupiedPixels: occupied,
        bbox,
        widthPercent,
        heightPercent,
        coveragePercent,
        minDepth: occupied ? minDepth : null,
        maxDepth: occupied ? maxDepth : null,
        matrix: Array.from(shadows.matrices.subarray(layer * 16, layer * 16 + 16)),
      },
      doc = parent.ownerDocument,
      panel = doc.createElement('section'),
      title = doc.createElement('div'),
      readout = doc.createElement('div'),
      canvas = doc.createElement('canvas');
    panel.dataset.shadowDebug = JSON.stringify(metrics);
    panel.setAttribute('aria-label', 'Actual GPU shadow depth map');
    panel.style.cssText =
      'position:absolute;left:16px;bottom:16px;z-index:30000;width:min(430px,calc(100% - 32px));padding:10px;background:#10191c;color:#ddf8f8;border:1px solid #68e2ef;border-radius:5px;font:11px/1.5 monospace;box-sizing:border-box;pointer-events:none';
    title.textContent = `ACTUAL SHADOW DEPTH · layer ${layer} · ${width} × ${height}`;
    readout.textContent = `Occupied bounds ${widthPercent.toFixed(1)}% × ${heightPercent.toFixed(1)}% · filled ${coveragePercent.toFixed(1)}%`;
    readout.style.cssText = 'font-size:10px;margin:3px 0 7px;color:#a9cbd0';
    canvas.width = Math.min(512, width);
    canvas.height = Math.max(1, Math.round((canvas.width * height) / width));
    canvas.style.cssText = 'display:block;width:100%;height:auto';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Depth readback, cyan occupied bounding box, dashed 75 percent map guide');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('A 2D canvas is required to show the shadow diagnostic');
    const image = context.createImageData(canvas.width, canvas.height),
      depthRange = Math.max(1e-6, maxDepth - minDepth);
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++) {
        const d =
            depths[
              Math.min(height - 1, Math.floor((y * height) / canvas.height)) * stride +
                Math.min(width - 1, Math.floor((x * width) / canvas.width))
            ],
          valid = Number.isFinite(d) && d >= 0 && d < 1 - 1e-6,
          value = valid ? Math.round(45 + (1 - (d - minDepth) / depthRange) * 195) : 18,
          offset = (y * canvas.width + x) * 4;
        image.data[offset] = value;
        image.data[offset + 1] = value;
        image.data[offset + 2] = value;
        image.data[offset + 3] = 255;
      }
    context.putImageData(image, 0, 0);
    context.lineWidth = 1;
    context.strokeStyle = '#f3d593';
    context.setLineDash([5, 4]);
    context.strokeRect(canvas.width * 0.125, canvas.height * 0.125, canvas.width * 0.75, canvas.height * 0.75);
    context.setLineDash([]);
    if (occupied) {
      context.strokeStyle = '#68e2ef';
      context.lineWidth = 1.5;
      context.strokeRect(
        (left / width) * canvas.width,
        (top / height) * canvas.height,
        ((right - left + 1) / width) * canvas.width,
        ((bottom - top + 1) / height) * canvas.height,
      );
    }
    panel.append(title, readout, canvas);
    parent.append(panel);
    buffer.unmap();
    return { metrics, element: panel, dispose: () => panel.remove() };
  } finally {
    buffer.destroy();
  }
}

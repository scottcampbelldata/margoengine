import { engineRuntime, Geometry, PbrMaterial } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import type { Mesh } from '@margoengine/core/extension';
import type { CADModel } from './cad.js';
import { maxBytes } from './cad-parser.js';
export type CADFormat = 'stl' | 'obj' | 'step' | 'iges';
export interface CADImportOptions {
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
  smoothing?: boolean;
  /** Most parts (OBJ objects and groups, STEP/IGES meshes) the file may have, each one a core mesh (default 100,000; up to core's 8,388,608 entities). */
  maxParts?: number;
  /**
   * The worker is terminated and the import rejects after this many milliseconds (default 120,000). OpenCascade can
   * spend minutes tessellating a malformed STEP or IGES file; a worker that never answers is never waited on.
   */
  timeoutMs?: number;
  /**
   * STEP and IGES only: the largest distance, in meters, that OpenCascade's tessellation may stray from the true surface
   * (its absolute linear deflection). Smaller values give finer triangles. Omitted, OpenCascade keeps its default
   * tessellation. STL and OBJ are already triangles and ignore it.
   */
  linearDeflection?: number;
}
export function parseCADAsync(
  instance: EngineKernel,
  buffer: ArrayBuffer,
  format: CADFormat,
  options: CADImportOptions = {},
): Promise<CADModel> {
  options.signal?.throwIfAborted();
  if (
    !(buffer instanceof ArrayBuffer) ||
    !buffer.byteLength ||
    buffer.byteLength > maxBytes ||
    !['stl', 'obj', 'step', 'iges'].includes(format)
  )
    throw new TypeError('Invalid CAD input');
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!(timeoutMs > 0 && timeoutMs <= 2 ** 31 - 1)) throw new RangeError('timeoutMs must be a positive number');
  const { linearDeflection } = options;
  if (
    linearDeflection !== undefined &&
    !(typeof linearDeflection === 'number' && linearDeflection > 0 && linearDeflection < Infinity)
  )
    throw new RangeError('linearDeflection must be a positive finite number of meters');
  const engine = engineRuntime(instance);
  if (engine.disposed) throw new Error('Engine is disposed');
  const workerURL = new URL(/* @vite-ignore */ './workers/cad-runtime.js?no-inline', import.meta.url),
    occtURL = new URL(/* @vite-ignore */ './workers/occt-import-js.js?no-inline', import.meta.url),
    wasmURL = new URL(/* @vite-ignore */ './workers/occt-import-js.wasm?no-inline', import.meta.url);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerURL),
      created: Mesh[] = [],
      meshes: Mesh[] = [],
      material = new PbrMaterial({ color: '#a6b9c8', roughness: 0.4, metalness: 0.3 });
    let root: Mesh | undefined;
    const timer = setTimeout(
      () => fail(new RangeError(`CAD import did not finish within ${timeoutMs} ms (raise the timeoutMs option)`)),
      timeoutMs,
    );
    const cleanup = () => {
        clearTimeout(timer);
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate();
        options.signal?.removeEventListener('abort', abort);
      },
      dispose = () => {
        for (let i = created.length - 1; i >= 0; i--) created[i].dispose();
      },
      fail = (error: unknown) => {
        cleanup();
        dispose();
        reject(error);
      },
      abort = () => fail(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    options.signal?.addEventListener('abort', abort, { once: true });
    // A worker that died (out of memory, an uncaught error) is reported by name; the next load starts a new one.
    worker.onerror = (event) => {
      event.preventDefault?.();
      fail(new Error(`CAD worker failed: ${event.message || 'unknown error'}`));
    };
    worker.onmessageerror = () => fail(new Error('CAD worker message failed'));
    worker.onmessage = (event) => {
      const message = event.data;
      if (!message || typeof message !== 'object') {
        fail(new TypeError('Invalid CAD worker message'));
        return;
      }
      if (message.error) {
        fail(new Error(message.error));
        return;
      }
      if (typeof message.progress === 'number') {
        try {
          options.onProgress?.(message.progress);
        } catch (error) {
          fail(error);
        }
        return;
      }
      try {
        options.signal?.throwIfAborted();
        if (engine.disposed) throw new Error('Engine is disposed');
        if (message.done) {
          if (!root || !meshes.length) throw new Error('CAD contains no geometry');
          root.visible = true;
          cleanup();
          resolve({ root, meshes, dispose });
          return;
        }
        if (!root) {
          root = engine.createMesh();
          root.visible = false;
          created.push(root);
        }
        const part = message.part as {
          name: string;
          reuse?: number;
          vertices: Float32Array;
          indices: Uint32Array;
          bounds: Float32Array;
        };
        // The owned worker validates geometry; adopt transferred buffers without remapping.
        const geometry =
          part.reuse === undefined
            ? Object.assign(Object.create(Geometry.prototype) as Geometry, {
                vertices: part.vertices,
                indices: part.indices,
                bounds: part.bounds,
              })
            : meshes[part.reuse]?.geometry;
        if (!geometry) throw new Error('Invalid CAD part reference');
        const mesh = engine.createMesh(root);
        created.push(mesh);
        mesh.name = part.name;
        meshes.push(mesh.setGeometry(geometry).setMaterial(material));
      } catch (error) {
        fail(error);
      }
    };
    try {
      worker.postMessage(
        {
          buffer,
          format,
          smoothing: options.smoothing ?? true,
          maxParts: options.maxParts,
          linearDeflection,
          occtURL: occtURL.href,
          wasmURL: wasmURL.href,
        },
        [buffer],
      );
    } catch (error) {
      fail(error);
    }
  });
}

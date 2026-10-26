import { engineRuntime, Geometry, PbrMaterial } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import type { Mesh } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { CADModel } from './cad.js';
import { capError, maxBytes } from './cad-parser.js';
/** A file format `parseCADAsync` and `loadCAD` read. */
export type CADFormat = 'stl' | 'obj' | 'step' | 'iges';
/**
 * Reads a STEP or IGES file in place of the bundled OpenCascade worker. It gets the same arguments as
 * {@link parseCADAsync} (the engine, the file's bytes, its format, the import options) and resolves with the model.
 * Every part it creates must belong to `engine`; if it throws or rejects, it must dispose what it created.
 */
export type CADImporter = (
  engine: EngineKernel,
  buffer: ArrayBuffer,
  format: 'step' | 'iges',
  options: CADImportOptions,
) => Promise<CADModel>;
/** Options for `parseCADAsync` and `loadCAD`; each one lists its default. */
export interface CADImportOptions {
  /** Cancels the import (and the download in `loadCAD`); the worker is terminated and the parts created so far are disposed. Default none. */
  signal?: AbortSignal;
  /** Called with 0 to 100 while the file is read. Default none. */
  onProgress?: (percent: number) => void;
  /**
   * Shading normals (default true). STEP/IGES: OpenCascade's own surface normals, smooth across each curved face and
   * hard at every B-rep edge. STL/OBJ: corners at the same point are welded, and each corner averages the normals of
   * the triangles there that meet its own within `creaseAngle` (weighted by area times corner angle). `false`: one flat
   * normal per triangle.
   */
  smoothing?: boolean;
  /**
   * STL and OBJ with smoothing: the largest angle, in degrees from 0 to 180, at which two triangles at a point share a
   * smooth normal (default 40). Sharper edges stay hard, as in the CAD model: a box keeps its 90 degree edges and a hex
   * nut its 60 degree corners, while a cylinder cut into 9 or more sides shades round. 180 averages every triangle at a
   * point, as earlier versions did. STEP and IGES ignore it: OpenCascade's surface normals already know every edge.
   */
  creaseAngle?: number;
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
   * tessellation. STL and OBJ are already triangles and ignore it. A custom `importer` receives the value as given.
   */
  linearDeflection?: number;
  /**
   * Reads STEP and IGES with your own function instead of OpenCascade (default none: the bundled OpenCascade worker).
   * It is called after the size and option checks, with the same engine, bytes, format and options, and its model is
   * returned as is. STL and OBJ never use it. Use it to plug in a reader the engine does not ship.
   *
   * @example
   * ```ts
   * const model = await loadCAD(engine, 'part.step', { importer: (engine, bytes, format, options) => myReader(engine, bytes, options) });
   * ```
   */
  importer?: CADImporter;
}
/**
 * Imports STL, OBJ, STEP or IGES bytes in a worker and resolves with the model. The buffer is transferred and detaches.
 * Rejects on `signal` abort, after `timeoutMs`, or if the file is invalid; nothing is left in the engine then.
 *
 * @example
 * ```ts
 * const model = await parseCADAsync(engine, bytes, 'step', { onProgress: (percent) => console.log(percent) });
 * ```
 */
export function parseCADAsync(
  instance: EngineKernel,
  buffer: ArrayBuffer,
  format: CADFormat,
  options: CADImportOptions = {},
): Promise<CADModel> {
  options.signal?.throwIfAborted();
  if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || !['stl', 'obj', 'step', 'iges'].includes(format))
    throw new TypeError(
      'CAD input must be a non-empty ArrayBuffer with format stl, obj, step or iges; pass the file bytes and one of those formats.',
    );
  if (buffer.byteLength > maxBytes)
    throw capError(`CAD exceeds 64 MiB (${buffer.byteLength} > ${maxBytes} bytes)`, format);
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!(timeoutMs > 0 && timeoutMs <= 2 ** 31 - 1)) throw new RangeError('timeoutMs must be a positive number');
  const { linearDeflection } = options;
  if (
    linearDeflection !== undefined &&
    !(typeof linearDeflection === 'number' && linearDeflection > 0 && linearDeflection < Infinity)
  )
    throw new RangeError('linearDeflection must be a positive finite number of meters');
  const { creaseAngle = 40 } = options;
  if (!(typeof creaseAngle === 'number' && creaseAngle >= 0 && creaseAngle <= 180))
    throw new RangeError('creaseAngle must be a number of degrees from 0 to 180');
  const engine = engineRuntime(instance);
  if (engine.disposed) throw new MargoError('disposed', 'Engine is disposed; create a new Engine before loading CAD.');
  const { importer } = options;
  if (importer !== undefined && typeof importer !== 'function') throw new TypeError('importer must be a function');
  if (importer && (format === 'step' || format === 'iges')) return importer(instance, buffer, format, options);
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
      fail(
        new MargoError('failed', `CAD worker failed: ${event.message || 'unknown error'}; try loading the file again.`),
      );
    };
    worker.onmessageerror = () =>
      fail(new MargoError('failed', 'CAD worker message failed; try loading the file again.'));
    worker.onmessage = (event) => {
      const message = event.data;
      if (!message || typeof message !== 'object') {
        fail(new TypeError('Invalid CAD worker message'));
        return;
      }
      if (message.error) {
        fail(
          new (message.kind === 'RangeError' ? RangeError : message.kind === 'TypeError' ? TypeError : Error)(
            message.error,
          ),
        );
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
        if (engine.disposed)
          throw new MargoError('disposed', 'Engine is disposed; create a new Engine before loading CAD.');
        if (message.done) {
          if (!root || !meshes.length)
            throw new MargoError(
              'failed',
              'CAD file contains no geometry; check that the file holds at least one solid or mesh.',
            );
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
        if (!geometry)
          throw new MargoError('failed', 'CAD worker reused a part that does not exist; try loading the file again.');
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
          creaseAngle,
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

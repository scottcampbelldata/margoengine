import type { EngineKernel } from '@margoengine/core';
import type { Texture } from '@margoengine/materials';
import type { Loader } from './hooks.js';
import type { AssetCache } from './assets.js';
const caches = new WeakMap<AssetCache, Map<string, Loader<Texture[]>>>();
/** Loader closures belong to their Canvas, so media and byte sources can be collected when it goes away. */
export function textureLoaders(cache: AssetCache): Map<string, Loader<Texture[]>> {
  let loaders = caches.get(cache);
  if (!loaders) caches.set(cache, (loaders = new Map()));
  return loaders;
}
let serial = 0;
const ids = new WeakMap<object, number>();
export function identity(value: object): number {
  let id = ids.get(value);
  if (id === undefined) ids.set(value, (id = serial++));
  return id;
}
function plain(value: unknown): unknown {
  if (typeof value === 'function') return `#${identity(value as object)}`;
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(plain);
  const prototype = Object.getPrototypeOf(value);
  // Textures, typed arrays and any other class instance count by identity; plain data by its content.
  if (prototype !== Object.prototype && prototype !== null) return `#${identity(value)}`;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
}
/** A key for an options object: plain numbers, strings, arrays and objects by value (an inline literal is no change), textures and other objects by identity. */
export function valueKey(value: unknown): string {
  return JSON.stringify(plain(value)) ?? 'undefined';
}
export function own(engine: EngineKernel, textures: Texture[], release?: () => void): void {
  if (engine.disposed) {
    textures.forEach((texture) => texture.dispose());
    release?.();
    throw new DOMException('Canvas disposed', 'AbortError');
  }
  engine.use({
    name: 'react:textures:' + nextId(),
    setup() {},
    dispose() {
      textures.forEach((texture) => texture.dispose());
      release?.();
    },
  });
}

export function nextId(): number {
  return serial++;
}

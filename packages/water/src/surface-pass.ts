import { surfacePasses } from './query-state.js';
import type { PassContext } from '@margoengine/core/extension';

// This registration code is only reachable from optional consuming entries.
export function surfacePass(
  source: object,
  order: number,
  draw: (context: Extract<PassContext, { backend: 'webgpu' }>) => boolean | void,
): () => void {
  const entries = surfacePasses.get(source) ?? [];
  const entry = { order, draw };
  entries.push(entry);
  entries.sort((a, b) => a.order - b.order);
  surfacePasses.set(source, entries);
  return () => {
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
    if (!entries.length) surfacePasses.delete(source);
  };
}

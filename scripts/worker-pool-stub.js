// A biome world worker is made with `workers: false`, so it never starts workers of its own; its bundle replaces the
// pool entry (which finds the worker script through import.meta.url, empty in the classic-worker format) with this.
export function defaultWorkers() {
  return 0;
}

export class BiomeWorkers {
  constructor() {
    throw new Error('A biome worker does not start workers of its own; create its world with workers: false');
  }
}

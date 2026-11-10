// Test instrumentation only. Device destruction releases its allocations (WebGPU section 5.4).
export function resourceLedger(prototype) {
  const live = new Map();
  const originals = new Map();
  let created = 0;
  for (const name of ['createBuffer', 'createTexture', 'createQuerySet']) {
    const original = prototype[name];
    originals.set(name, original);
    prototype[name] = function (...args) {
      const resource = original.apply(this, args);
      live.set(resource, { device: this, kind: name.slice(6), label: args[0]?.label ?? '' });
      created++;
      const destroy = resource.destroy.bind(resource);
      resource.destroy = () => {
        destroy();
        live.delete(resource);
      };
      return resource;
    };
  }
  const destroy = prototype.destroy;
  prototype.destroy = function () {
    destroy.call(this);
    for (const [resource, owner] of live) if (owner.device === this) live.delete(resource);
  };
  return {
    snapshot: () => ({ created, live: [...live.values()].map(({ kind, label }) => ({ kind, label })) }),
    restore() {
      for (const [name, original] of originals) prototype[name] = original;
      prototype.destroy = destroy;
    },
  };
}

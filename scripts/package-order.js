// Build order for the workspace packages, derived from package.json instead of a hand-written list: every package comes
// after the @margoengine/* (and margoengine) packages it names in dependencies, peerDependencies or devDependencies.
// manifests: Map of directory name -> parsed package.json, in workspace order (ties keep that order).
export function packageOrder(manifests) {
  const byName = new Map([...manifests].map(([dir, manifest]) => [manifest.name, dir])),
    order = [],
    state = new Map();
  const visit = (dir, path) => {
    if (state.get(dir) === 'done') return;
    if (state.get(dir) === 'visiting')
      throw new Error(`Package dependency cycle: ${[...path.slice(path.indexOf(dir)), dir].join(' -> ')}`);
    state.set(dir, 'visiting');
    const { dependencies, peerDependencies, devDependencies } = manifests.get(dir);
    for (const name of Object.keys({ ...dependencies, ...peerDependencies, ...devDependencies }))
      if (byName.has(name) && byName.get(name) !== dir) visit(byName.get(name), [...path, dir]);
    state.set(dir, 'done');
    order.push(dir);
  };
  for (const dir of manifests.keys()) visit(dir, []);
  return order;
}

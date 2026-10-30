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

// Directory name -> the set of workspace directories it must build after (the same edges packageOrder walks).
export function packageDependencies(manifests) {
  const byName = new Map([...manifests].map(([dir, manifest]) => [manifest.name, dir]));
  return new Map(
    [...manifests].map(([dir, { dependencies, peerDependencies, devDependencies }]) => [
      dir,
      new Set(
        Object.keys({ ...dependencies, ...peerDependencies, ...devDependencies })
          .filter((name) => byName.has(name) && byName.get(name) !== dir)
          .map((name) => byName.get(name)),
      ),
    ]),
  );
}

/**
 * Runs build(name) for every name, each one only after the names it depends on (dependencies: name -> Set of names;
 * a dependency that is not in `names` is ignored) have finished, with at most `jobs` running at once. A failed build
 * rejects once the builds already running have settled.
 */
export async function buildInDependencyOrder(names, dependencies, jobs, build) {
  const waiting = new Set(names),
    running = new Map();
  let failure;
  while (waiting.size || running.size) {
    if (!failure)
      for (const name of waiting)
        if (running.size < jobs && [...dependencies.get(name)].every((dep) => !waiting.has(dep) && !running.has(dep))) {
          waiting.delete(name);
          running.set(
            name,
            build(name).then(
              () => name,
              (error) => {
                failure ??= error;
                return name;
              },
            ),
          );
        }
    if (failure) waiting.clear();
    if (!running.size) break;
    running.delete(await Promise.race(running.values()));
  }
  if (failure) throw failure;
}

// Clean-room strength-2 construction. Research and scope: docs/integration-composition.md.
export const C2 = [
  'post',
  'taa',
  'dof',
  'tonemap',
  'oit',
  'shadows',
  'clustered',
  'pixel',
  'creative',
  'toon',
  'transitions',
  'scenery',
  'voxel-pathtracer',
  'water',
  'sky',
  'vfx',
  'lines',
  'points',
  'labels',
  'text',
  'sprites',
  'splats',
  'lighting2d',
  'xr',
];
export const implementedC2 = C2;
export const commonC2 = ['core', 'post', 'webgl2-compat'];

export function selectCompositionRows(matrix, packages) {
  const names = packages?.map((name) => name.replace('@margoengine/', ''));
  if (!names || commonC2.some((name) => names.includes(name))) return matrix.rows;
  return matrix.rows.filter((row) => row.members.some((member) => names.includes(member)));
}
export const pairKey = (a, b) => JSON.stringify([a, b].sort());

export function missingTuples(members, rows) {
  const missing = [];
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++)
      for (const a of [0, 1])
        for (const b of [0, 1])
          if (!rows.some((row) => +row.includes(members[i]) === a && +row.includes(members[j]) === b))
            missing.push([members[i], members[j], a, b]);
  return missing;
}

/** Sparse binary covering array: greedy positive pairs, then repair the other three states. */
export function coveringArray(members, width = 5) {
  if (
    members.length < 2 ||
    new Set(members).size !== members.length ||
    members.some((m) => typeof m !== 'string' || !m) ||
    !Number.isInteger(width) ||
    width < 2
  )
    throw new RangeError('Use distinct nonempty member names and a row width of at least two');
  const pending = new Map();
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++) pending.set(pairKey(members[i], members[j]), [members[i], members[j]]);
  const rows = [];
  while (pending.size) {
    const row = [...pending.values().next().value];
    while (row.length < Math.min(width, members.length)) {
      let best,
        gain = -1;
      for (const candidate of members) {
        if (row.includes(candidate)) continue;
        const score = row.filter((m) => pending.has(pairKey(m, candidate))).length;
        if (score > gain) {
          best = candidate;
          gain = score;
        }
      }
      if (gain === 0) break;
      row.push(best);
    }
    rows.push(members.filter((m) => row.includes(m)));
    for (const a of row) for (const b of row) pending.delete(pairKey(a, b));
  }
  for (const [a, b, x, y] of missingTuples(members, rows)) {
    if (rows.some((row) => +row.includes(a) === x && +row.includes(b) === y)) continue;
    rows.push([...(x ? [a] : []), ...(y ? [b] : [])]);
  }
  return rows;
}

export function pairCoverage(members, rows) {
  const covered = new Set();
  for (const row of rows)
    for (let i = 0; i < row.length; i++) for (let j = i + 1; j < row.length; j++) covered.add(pairKey(row[i], row[j]));
  const total = (members.length * (members.length - 1)) / 2;
  return { covered: covered.size, total };
}

// The order of a prim's specs, strongest first, read back from the `o<a>_<b>` values of `prim-stack-marks.js`: a spec
// counts as present when it wins a pair, and present specs sort by the pairs they win among themselves.
export function stackOrder(values) {
  const pairs = [];
  for (const [name, value] of Object.entries(values)) {
    const m = /^o(\d+)_(\d+)$/.exec(name);
    if (m) pairs.push([+m[1], +m[2], value]);
  }
  const present = new Set(pairs.map(([, , v]) => v));
  const wins = new Map([...present].map((s) => [s, 0]));
  for (const [a, b, v] of pairs) if (present.has(a) && present.has(b)) wins.set(v, wins.get(v) + 1);
  return [...present].sort((x, y) => wins.get(y) - wins.get(x) || x - y);
}

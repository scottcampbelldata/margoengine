// Clean-room deterministic trees, shared by the work-count regression and oracle runner.
export function chain(depth, measured = () => {}) {
  let leaf = { style: {}, children: [], rect: {}, measure: (width) => {
    measured(width);
    return { width: 20, height: 8 };
  } };
  const end = leaf;
  for (let i = 0; i < depth; i++) leaf = { style: { direction: 'row', align: 'center' }, children: [leaf], rect: {} };
  return { root: leaf, leaf: end };
}

export function corpus(seed) {
  let state = seed;
  const next = (n) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const make = (depth) => {
    const style = {
      direction: ['row', 'column', 'grid', 'stack'][next(4)],
      padding: next(4), margin: next(3), gap: [next(4), next(4)],
      align: ['start', 'center', 'end', 'stretch'][next(4)],
      justify: ['start', 'center', 'end', 'space-between'][next(4)],
      wrap: !!next(2), columns: 2,
      width: [undefined, '50%', 30, 'fill'][next(4)],
      height: [undefined, 20, 'fill'][next(3)],
      minWidth: next(6), maxWidth: 150, minHeight: next(5),
      overflow: ['visible', 'scroll', 'hidden'][next(3)],
      offset: [next(3), next(3)],
    };
    const natural = 12 + next(35);
    return { style, rect: {}, visible: next(17) !== 0, scrollX: 12, scrollY: 9,
      children: depth ? Array.from({length: 3}, () => make(depth - 1)) : [],
      measure: (width) => ({width: Math.min(natural, width), height: 8 * Math.max(1, Math.ceil(natural / Math.max(1, width)))}) };
  };
  const root = make(3);
  root.visible = true;
  return root;
}

export function layoutBytes(root) {
  const values = [];
  const visit = (node) => {
    const r = node.rect;
    values.push(r.x, r.y, r.width, r.height, node.contentWidth ?? -1, node.contentHeight ?? -1, node.scrollX ?? -1, node.scrollY ?? -1);
    node.children.forEach(visit);
  };
  visit(root);
  return Buffer.from(new Float64Array(values).buffer);
}

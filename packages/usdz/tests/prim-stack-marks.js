// Makes a prim's whole stack of specs visible in its values. Every prim spec of a stage (prims and variants, all
// layers, in file name order) gets a number s, and for every other spec t an attribute `o<a>_<b>` (a < b, the two
// numbers) set to s. Where both specs reach one prim, the composed value names the stronger of the two, so the values
// of a prim spell out the order of its specs. A stage's marked files go to OpenUSD and to Margo alike.

/** The marked text of every file of a stage, its specs numbered across the files in name order. */
export function markStage(files) {
  const names = Object.keys(files).sort();
  const opens = names.map((name) => scan(files[name]));
  const total = opens.reduce((n, list) => n + list.length, 0);
  const out = {};
  let next = 0;
  names.forEach((name, f) => {
    const text = files[name];
    let result = '',
      from = 0;
    for (const at of opens[f]) {
      const s = next++,
        lines = [];
      for (let t = 0; t < total; t++) if (t !== s) lines.push(`custom int o${Math.min(s, t)}_${Math.max(s, t)} = ${s}`);
      result += text.slice(from, at + 1) + '\n' + lines.join('\n') + '\n';
      from = at + 1;
    }
    out[name] = result + text.slice(from);
  });
  return out;
}

/** Offsets of the `{` that opens each prim or variant spec: the first `{` outside metadata after a spec's header. */
function scan(text) {
  const opens = [];
  let parens = 0,
    pending = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === '@' || c === '<') {
      const end = text.indexOf(c === '<' ? '>' : c, i + 1);
      if (c === '"' && parens === 0 && /^\s*"[^"\n]*"\s*$/.test(lineOf(text, i).replace(/[({].*$/, ''))) pending = true;
      i = end < 0 ? text.length : end;
      continue;
    }
    if (c === '(') parens++;
    else if (c === ')') parens--;
    else if (c === '{' && parens === 0 && pending) {
      opens.push(i);
      pending = false;
    } else if (parens === 0 && /[a-z]/.test(c) && (i === 0 || /\s/.test(text[i - 1]))) {
      const word = /^[a-zA-Z]+/.exec(text.slice(i))[0];
      if (word === 'def' || word === 'over' || word === 'class') pending = true;
      else if (word === 'variantSet') pending = false;
      i += word.length - 1;
    }
  }
  return opens;
}
const lineOf = (text, i) =>
  text.slice(text.lastIndexOf('\n', i) + 1, (text.indexOf('\n', i) + 1 || text.length + 1) - 1);

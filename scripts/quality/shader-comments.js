// Gate 6, shader-comments: shipped package files hold no shader comment text (KB-WGSL1). Every .js and .d.ts under each
// package's dist is read the way the build strip reads it (scripts/shader-comments.mjs); an item is a package with
// `n` comments left inside shader literals, counting each literal the strip had to leave whole as one. The baseline is
// empty once every package is stripped, so any shader comment that ships again fails here.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageAnchors, stripShaderLiterals } from '../shader-comments.mjs';

const distFiles = (directory, out = []) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) distFiles(path, out);
    else if (/\.(m?js|d\.ts)$/.test(entry.name)) out.push(path);
  }
  return out;
};

export async function shaderCommentsGate({ root, packages }) {
  const items = {},
    where = {};
  for (const pkg of packages) {
    const dist = join(root, 'packages', pkg.dir, 'dist');
    if (!existsSync(dist)) continue;
    const anchors = packageAnchors(join(root, 'packages', pkg.dir));
    let count = 0;
    for (const file of distFiles(dist)) {
      const { comments, kept } = stripShaderLiterals(readFileSync(file, 'utf8'), file, { anchors });
      count += comments + kept.length;
      if (comments + kept.length) (where[pkg.name] ??= []).push(`${file.slice(root.length + 1)} (${comments + kept.length})`);
    }
    if (count) items[pkg.name] = count;
  }
  return {
    items,
    owner: (key) => packages.find((p) => p.name === key)?.dir,
    summary: () =>
      Object.entries(where)
        .slice(0, 20)
        .map(([name, files]) => `  ${name}: ${files.slice(0, 4).join(', ')}`),
  };
}

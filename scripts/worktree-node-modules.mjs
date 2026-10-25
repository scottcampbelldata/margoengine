// Gives a git worktree of this repository a real node_modules folder:
// third-party entries are junctions to the main checkout's node_modules, and every @margoengine/* package (and the
// `margoengine` stage) is a junction to THIS worktree's own packages, so builds and tests use the worktree's code.
// Usage, from inside a worktree: node scripts/worktree-node-modules.mjs
// Never run a full `npm install` in a worktree; run it once in the main checkout.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const root = resolve(git('rev-parse', '--show-toplevel')),
  main = resolve(dirname(resolve(root, git('rev-parse', '--git-common-dir'))));
if (root === main) throw new Error('Run this in a worktree, not the main checkout');
if (!existsSync(join(main, 'node_modules'))) throw new Error(`Run npm install in the main checkout first: ${main}`);

const target = join(root, 'node_modules');
rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, '@margoengine'), { recursive: true });
for (const name of readdirSync(join(main, 'node_modules')))
  if (name !== '@margoengine' && name !== 'margoengine')
    symlinkSync(join(main, 'node_modules', name), join(target, name), 'junction');
for (const dir of readdirSync(join(root, 'packages'))) {
  const manifest = join(root, 'packages', dir, 'package.json');
  if (!existsSync(manifest)) continue;
  const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
  if (name.startsWith('@margoengine/') || name === 'margoengine')
    symlinkSync(join(root, 'packages', dir), join(target, name), 'junction');
}
console.log(`node_modules ready in ${target} (third-party from ${main})`);

// `node scripts/worktree-report.mjs`: lists every git worktree, local branch, remote branch and leftover sibling folder of this
// checkout, and what each one needs. The rule it serves (AGENTS.md, "Branches and folders"): a folder exists only while
// an agent is working in it, and finished work is on main and off the drive. The report changes nothing and exits 0.
// Usage: node scripts/worktree-report.mjs [--json]
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What a row needs, from its unlanded commits and uncommitted files.
 * @param {{ kind: 'main' | 'worktree' | 'branch' | 'remote' | 'folder', ahead?: number, dirty?: number }} row
 * @returns {string}
 */
export function verdict(row) {
  if (row.kind === 'main') return 'main checkout';
  if (row.kind === 'folder') return 'not a worktree: land what it holds or delete it';
  if (row.kind === 'remote') return 'remote branch: land it on main, then delete it';
  if ((row.ahead ?? 0) > 0 || (row.dirty ?? 0) > 0) return 'unlanded work: an agent finishes and lands it';
  return 'nothing unlanded: delete it unless an agent is working in it';
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tryGit = (cwd, args, fallback) => {
  try {
    return git(cwd, args);
  } catch {
    return fallback;
  }
};

/**
 * Collect the rows for the checkout at `root`.
 * @param {string} root
 */
export function collect(root) {
  const base = tryGit(root, ['rev-parse', '--verify', '--quiet', 'origin/main'], '') ? 'origin/main' : 'main';
  const ahead = (cwd, ref) => Number(tryGit(cwd, ['rev-list', '--count', `${base}..${ref}`], '0'));
  const top = resolve(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']), '..');
  const rows = [];
  const worktreePaths = new Set();
  const branchesInTrees = new Set();
  let current = null;
  for (const line of git(root, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: resolve(line.slice(9)), branch: '(detached)' };
      worktreePaths.add(current.path.toLowerCase());
      rows.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice(7).replace('refs/heads/', '');
      branchesInTrees.add(current.branch);
    }
  }
  for (const row of rows) {
    row.kind = row.path.toLowerCase() === top.toLowerCase() ? 'main' : 'worktree';
    row.ahead = ahead(row.path, 'HEAD');
    row.dirty = tryGit(row.path, ['status', '--porcelain'], '').split('\n').filter(Boolean).length;
    row.age = Number(tryGit(row.path, ['log', '-1', '--format=%ct'], '0'));
  }
  for (const branch of git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n')) {
    if (!branch || branch === 'main' || branchesInTrees.has(branch)) continue;
    rows.push({ kind: 'branch', branch, ahead: ahead(root, `refs/heads/${branch}`), dirty: 0, path: '' });
  }
  for (const ref of tryGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], '').split('\n')) {
    if (!ref || ref.endsWith('/HEAD') || ref.endsWith('/main') || !ref.includes('/')) continue;
    rows.push({ kind: 'remote', branch: ref, ahead: ahead(root, `refs/remotes/${ref}`), dirty: 0, path: '' });
  }
  const parent = dirname(top);
  const prefix = `${basename(top)}-`.toLowerCase();
  for (const name of readdirSync(parent)) {
    const path = join(parent, name);
    if (!name.toLowerCase().startsWith(prefix) || worktreePaths.has(path.toLowerCase())) continue;
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) continue;
    rows.push({ kind: 'folder', path, branch: '', ahead: 0, dirty: 0 });
  }
  for (const row of rows) row.verdict = verdict(row);
  return { base, rows };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { base, rows } = collect(root);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ base, rows }, null, 2));
  } else {
    console.log(`Compared with ${base}. ${rows.length} rows.`);
    for (const row of rows) {
      const where = row.path || row.branch;
      const counts = row.kind === 'folder' ? '' : `: ${row.branch}, ${row.ahead} unlanded commits, ${row.dirty} changed files`;
      console.log(`- [${row.kind}] ${where}${counts}: ${row.verdict}`);
    }
  }
}

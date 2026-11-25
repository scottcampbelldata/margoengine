// `npm run check:mass-deletion`: refuses a commit that deletes or reverts on a mass scale (Scott, 2026-11-25, after
// the ff88a70e7 sync, which copied a stale tree over main: 129 files and 115,527 lines gone, 242 commits undone, and no
// test failed because the tests went with their code).
//   npm run check:mass-deletion                       origin/main..HEAD
//   node scripts/check-mass-deletion.mjs --range A..B an explicit range
//   node scripts/check-mass-deletion.mjs --last N     the newest N commits of HEAD (CI on main)
// Per non-merge commit it fails on MASS-DELETION when the commit deletes more than 50 files (a rename into an ignored
// path counts as a deletion) or more than 20,000 lines (generated files below do not count), and on SYNC-REVERT when a
// `sync:` commit deletes or removes lines from more than 10 files. A commit body line
// `Mass-deletion-approved-by: Scott Campbell <reason>` (reason on the line or the next one) lets it through.
// It also fails on STALE-REVERT when a commit puts more than 2 files (generated ones not counted) back to the bytes
// they had before an earlier commit of the last 500 changed them, so it silently undoes that commit: the 3bcef614ed
// weather commit (2026-11-25) was a `git reset` onto a newer main with the working tree still on an older one, and it
// undid seven landed commits in 40 files with only 1,528 lines gone. A body line `Reverts: <sha> <why>` names a commit
// undone on purpose, as does the `This reverts commit <sha>` line git revert writes.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const MAX_FILES = 50;
export const MAX_LINES = 20_000;
export const MAX_SYNC_FILES = 10;
export const MAX_STALE_FILES = 2;
/** How far back an undone commit may be; older bytes coming back are a deliberate restore. */
export const STALE_WINDOW = 500;
const ABSENT = /^0+$/;
const GENERATED = [
  /^api\/[^/]+\.api\.md$/,
  /^site\/llms[^/]*\.txt$/,
  /^docs\/api-surface\.md$/,
  /^docs\/guides\/imports\.md$/,
  /^examples\/all-entries\//,
  /^scripts\/quality\/baselines\//,
  /^package-lock\.json$/,
  /^examples\/package-benchmarks\/results\//,
];
const generated = (file) => GENERATED.some((pattern) => pattern.test(file));

const git = (cwd, args, input) =>
  execFileSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 1 << 29, stdio: ['pipe', 'pipe', 'pipe'] });

/** True when the body carries Scott's approval line with a reason on it or on a later non-empty line. */
export function approved(body) {
  const rows = body.split(/\r?\n/);
  const at = rows.findIndex((row) => /^Mass-deletion-approved-by: Scott Campbell\b/.test(row));
  if (at < 0) return false;
  const rest = rows[at].replace(/^Mass-deletion-approved-by: Scott Campbell\b[\s:,;.–—-]*/, '');
  return rest.trim() !== '' || rows.slice(at + 1).some((row) => row.trim() !== '');
}

/** Paths among `paths` that git ignores (check-ignore exits 1 when none is). */
function ignoredAmong(cwd, paths) {
  try {
    return new Set(git(cwd, ['check-ignore', '--stdin', '-z'], paths.join('\0')).split('\0'));
  } catch {
    return new Set();
  }
}

/** Facts of one commit: files deleted, files that lost lines, lines deleted outside generated files. */
function measure(cwd, sha) {
  // -z name-status: "D\0path\0", "M\0path\0", "R100\0old\0new\0".
  const parts = git(cwd, ['show', '--format=', '-z', '-M', '--name-status', sha]).split('\0');
  const deleted = [];
  const renamed = [];
  for (let i = 0; i < parts.length && parts[i] !== ''; ) {
    const status = parts[i];
    if (status[0] === 'R' || status[0] === 'C') {
      if (status[0] === 'R') renamed.push([parts[i + 1], parts[i + 2]]);
      i += 3;
    } else {
      if (status === 'D') deleted.push(parts[i + 1]);
      i += 2;
    }
  }
  if (renamed.length) {
    const ignored = ignoredAmong(
      cwd,
      renamed.map((r) => r[1]),
    );
    for (const [from, to] of renamed) if (ignored.has(to)) deleted.push(from);
  }
  // -z numstat: "add\tdel\tpath\0" or "add\tdel\t\0old\0new\0" for a rename.
  const stat = git(cwd, ['show', '--format=', '-z', '-M', '--numstat', sha]).split('\0');
  let lines = 0;
  const lossy = new Set(deleted);
  for (let i = 0; i < stat.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(stat[i]);
    if (!m) continue;
    let file = m[3];
    if (file === '') {
      file = stat[i + 2];
      i += 2;
    }
    if (generated(file)) continue;
    const removed = m[2] === '-' ? 0 : Number(m[2]);
    lines += removed;
    if (removed > 0) lossy.add(file);
  }
  return {
    deleted: deleted.filter((file) => !generated(file)),
    lines,
    lossy: [...lossy].filter((file) => !generated(file)),
  };
}

/** Commits a body names as undone on purpose: `Reverts: <sha>` lines and git revert's `This reverts commit <sha>`. */
export function namedReverts(body) {
  const shas = [];
  for (const m of body.matchAll(/^(?:Reverts:\s*|This reverts commit\s+)([0-9a-f]{7,40})/gim))
    shas.push(m[1].toLowerCase());
  return shas;
}

/** Per-file entries of `git ... --raw -z`: { before, after, file } with full blob ids ("000..." for absent). */
function rawEntries(text) {
  const parts = text.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const m = /:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) [A-Z]\d*$/.exec(parts[i]);
    if (m) entries.push({ before: m[1], after: m[2], file: parts[++i], at: i });
  }
  return entries;
}

/**
 * Files `sha` puts back to the bytes they had before an earlier commit (within STALE_WINDOW of its parent) changed
 * them, each as { file, undone } with the newest such commit. An added file counts when the earlier commit deleted it;
 * a deleted one does not (removing what an earlier commit added is ordinary, and MASS-DELETION bounds deletions).
 */
export function undoneFiles(cwd, sha) {
  let parent;
  try {
    parent = git(cwd, ['rev-parse', '--verify', '-q', `${sha}^`]).trim();
  } catch {
    return [];
  }
  const window = new Set(
    git(cwd, ['rev-list', '-n', String(STALE_WINDOW), parent])
      .split('\n')
      .filter(Boolean),
  );
  const undone = [];
  for (const { after, file } of rawEntries(
    git(cwd, ['show', '--format=', '--raw', '-z', '--no-abbrev', '--no-renames', sha]),
  )) {
    if (generated(file) || ABSENT.test(after)) continue;
    // Each earlier commit that changed the file, newest first: "\x01<sha>\0\n:modes before after status\0path\0".
    const log = git(cwd, [
      'log',
      '-n',
      '20',
      '--format=%x01%H',
      '--raw',
      '-z',
      '--no-abbrev',
      '--no-renames',
      parent,
      '--',
      file,
    ]);
    for (const block of log.split('\x01').slice(1)) {
      const commit = block.slice(0, block.indexOf('\0')).trim();
      if (!window.has(commit)) break;
      const change = rawEntries(block).find((e) => e.file === file);
      if (change && change.before === after) {
        undone.push({ file, undone: commit });
        break;
      }
    }
  }
  return undone;
}

/** The offences in a range, one { sha, subject, code, message } each. */
export function scan(cwd, { range, last } = {}) {
  const args = ['log', '--no-merges', '--format=%H'];
  args.push(...(last ? ['-n', String(last), 'HEAD'] : [range ?? 'origin/main..HEAD']));
  const shas = git(cwd, args).split('\n').filter(Boolean);
  const bad = [];
  for (const sha of shas) {
    const [subject, body] = git(cwd, ['show', '-s', '--format=%s%x00%b', sha]).split('\0');
    if (approved(body)) continue;
    const { deleted, lines, lossy } = measure(cwd, sha);
    const found = (code, message) => bad.push({ sha, subject, code, message });
    if (deleted.length > MAX_FILES || lines > MAX_LINES)
      found(
        'MASS-DELETION',
        `deletes ${deleted.length} files (limit ${MAX_FILES}) and ${lines} lines (limit ${MAX_LINES}, generated files not counted)`,
      );
    else if (/^sync:/.test(subject) && lossy.length > MAX_SYNC_FILES)
      found(
        'SYNC-REVERT',
        `a sync: commit deletes or removes lines from ${lossy.length} files (limit ${MAX_SYNC_FILES})`,
      );
    const named = namedReverts(body);
    const stale = undoneFiles(cwd, sha).filter((u) => !named.some((n) => u.undone.startsWith(n)));
    if (stale.length > MAX_STALE_FILES) {
      const commits = [...new Set(stale.map((u) => u.undone.slice(0, 10)))];
      const files = stale.slice(0, 8).map((u) => u.file);
      found(
        'STALE-REVERT',
        `puts ${stale.length} files back to their bytes before earlier commits (limit ${MAX_STALE_FILES}), undoing ` +
          `${commits.join(', ')} (${files.join(', ')}${stale.length > 8 ? ', ...' : ''})`,
      );
    }
  }
  return { checked: shas.length, bad };
}

function main() {
  const argv = process.argv.slice(2);
  const value = (flag) => {
    const at = argv.indexOf(flag);
    return at < 0 ? undefined : argv[at + 1];
  };
  const { checked, bad } = scan(process.cwd(), { range: value('--range'), last: value('--last') });
  if (!bad.length) {
    console.log(
      `check:mass-deletion: ${checked} commit(s) checked, none deletes or reverts on a mass scale or undoes an earlier commit.`,
    );
    return;
  }
  for (const b of bad)
    console.error(
      `check:mass-deletion ${b.code}: ${b.sha.slice(0, 9)} "${b.subject}" ${b.message}.\n` +
        (b.code === 'STALE-REVERT'
          ? '  A reset onto a newer main with an older working tree does this: rebuild the commit from current main ' +
            '(cherry-pick your own changes onto it), or name each commit undone on purpose in a `Reverts: <sha> <why>` body line.'
          : '  Add the body line `Mass-deletion-approved-by: Scott Campbell <reason>` only with his yes; otherwise undo the commit.'),
    );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

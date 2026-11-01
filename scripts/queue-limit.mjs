// NEVER MORE THAN 6 IN THE QUEUE (Scott, 2026-11-01). With 6 waiting NOTHING gets built: no edit, no commit, no helper.
// Claude Code's PreToolUse hook in .claude/settings.json runs `--hook` before every edit, shell command and helper start;
// exit 2 refuses the call and the banner on stderr tells the agent why. No flag: prints the count, exit 2 at the limit.
// scripts/hooks/reference-transaction refuses a seventh branch in git, and scripts/integrate.mjs lands 6 per batch.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_QUEUE = 6;

/** Edit tools stopped at the limit, whichever checkout of this repository they aim at. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const START_TOOLS = new Set(['Agent', 'mcp__ccd_session__start_session']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const REPO_FILE = /[\\/]margoengine(-wt-[^\\/]+)?[\\/]/;
/** Notes and stop orders still get written with a full queue: a stop from Scott and a handoff are not building. */
const NOTES = /[\\/]private[\\/](handoffs[\\/]|RESUME\.md$|control\.json$)/;
const COMMIT = /\bgit\b[^\n;&|]*\scommit\b/;

/** READY entries, and every name counted against the limit: each local branch but main, each READY file, once. */
export function queueState(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(),
    root = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir')),
    queue = join(root, 'private', 'queue'),
    branches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean),
    ready = existsSync(queue)
      ? readdirSync(queue)
          .filter((name) => name.endsWith('.ready'))
          .map((name) => name.slice(0, -6))
      : [];
  return { ready, names: [...new Set([...branches, ...ready])].filter((name) => name !== 'main').sort() };
}

export const queueNames = (cwd = process.cwd()) => queueState(cwd).names;

/** The message nobody can miss. `what` says what the limit just stopped. */
export const queueBanner = (count, what) =>
  [
    '='.repeat(72),
    `NEVER MORE THAN ${MAX_QUEUE} IN THE QUEUE: ${count} unlanded right now.`,
    what,
    'Land what is waiting first. Rule: AGENTS.md and the playbook, Scott 2026-11-01.',
    '='.repeat(72),
  ].join('\n');

/** One line for a session's opening context, the banner at the limit. */
export function queueStatus(names) {
  return names.length >= MAX_QUEUE
    ? queueBanner(names.length, 'Nothing gets built and no helper starts until the queue drops.')
    : `queue: ${names.length} of ${MAX_QUEUE} unlanded`;
}

/**
 * What the hook says about one tool call: a refusal message, or null to let it run. A new helper counts every unlanded
 * name; edits and commits stop on READY entries, because the builders of a queue under the limit must still finish.
 */
export function refusal({ tool_name: tool, tool_input: input = {} }, { ready, names }) {
  if (START_TOOLS.has(tool))
    return names.length >= MAX_QUEUE ? queueBanner(names.length, `No new helper. Unlanded: ${names.join(', ')}`) : null;
  if (ready.length < MAX_QUEUE) return null;
  const waiting = `Nothing gets built with ${ready.length} waiting: ${ready.join(', ')}`;
  if (EDIT_TOOLS.has(tool)) {
    const file = input.file_path ?? input.notebook_path ?? '';
    return REPO_FILE.test(file) && !NOTES.test(file) ? queueBanner(names.length, waiting) : null;
  }
  if (SHELL_TOOLS.has(tool) && COMMIT.test(input.command ?? '')) return queueBanner(names.length, waiting);
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const state = queueState();
  if (process.argv.includes('--hook')) {
    const refused = refusal(JSON.parse(readFileSync(0, 'utf8')), state);
    if (refused) {
      console.error(refused);
      process.exit(2);
    }
  } else if (state.names.length >= MAX_QUEUE) {
    console.error(queueBanner(state.names.length, `Unlanded: ${state.names.join(', ')}`));
    process.exit(2);
  } else console.log(queueStatus(state.names));
}

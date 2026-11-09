// Positive classification of GPU leaves, never of aggregators that happen to contain one.
import { basename } from 'node:path';

export function gpuCommand(words) {
  const program = basename((words[0] ?? '').replaceAll('\\', '/'))
    .replace(/\.(exe|cmd)$/i, '')
    .toLowerCase();
  let leaf;
  if (/^(npm|pnpm|yarn)$/.test(program)) {
    const at = words.findIndex((word) => /^(run|run-script)$/.test(word));
    leaf = at < 0 ? words[1] : words[at + 1];
    if (/^(test:(gpu|browser|xr)(:|$)|check:readme-run$)/.test(leaf ?? '')) return 'gpu';
    if (/^(verify|lint|hygiene|build|typecheck|check|test)(:|$)/.test(leaf ?? '')) return 'cpu';
    return 'unknown';
  }
  if (/^(tsc|eslint|vitest|jest|mocha|cargo|rustc|cmake|make|cmd|powershell|pwsh|bash|sh)$/.test(program)) return 'cpu';
  if (/^node$/.test(program)) {
    if (words.some((word) => word === '--test' || word.startsWith('--test='))) return 'cpu';
    // Inline code is not a script identity. Its strings/arguments cannot classify the command.
    if (words.some((word) => /^(?:-e|-p|--eval|--print)(?:=|$)/.test(word))) return 'unknown';
    for (let i = 1; i < words.length; i++) {
      if (['--import', '--require', '-r', '--loader', '--experimental-loader', '--conditions'].includes(words[i])) {
        i++;
        continue;
      }
      if (words[i].startsWith('-')) continue;
      leaf = words[i].replaceAll('\\', '/');
      break;
    }
    if (!leaf) return 'unknown';
    const name = basename(leaf);
    if (
      /^(verify|lint|hygiene|build|typecheck|tsc|check-merge|run-unit-tests)\b/i.test(name) ||
      /\.test\.[cm]?[jt]s$/.test(name)
    )
      return 'cpu';
    if (
      /(^|[-_.])(gpu|browser|pixels?|capture|render|xr)([-_.]|$)/i.test(name) ||
      /^(run-readme-examples|gpu-package-tests)\./.test(name)
    )
      return 'gpu';
  }
  return 'unknown';
}

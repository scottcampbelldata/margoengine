// Does not require Git metadata or any pre-existing .lane files in the archived repository.
import assert from 'node:assert/strict';
import { decodePatch } from './decode-patch.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const bundle = fileURLToPath(new URL('.', import.meta.url));
decodePatch();
const arg = (name) => process.argv.find((v) => v.startsWith('--' + name + '='))?.slice(name.length + 3);
const repo = resolve(arg('repo') ?? '.');
const tag = arg('tag');
assert.match(tag ?? '', /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Supply a unique --tag using letters/digits/_/-');
const outputRelative = '.lane/p/' + tag, output = join(repo, outputRelative);
assert.ok(!existsSync(output), 'Never reuse or overwrite a reproduction output directory');
const baseline = JSON.parse(readFileSync(join(bundle, 'source-equivalence.json')));
const normalizedSha = (bytes) => createHash('sha256').update(bytes.toString('utf8').replaceAll('\r\n', '\n')).digest('hex');
for (const file of baseline.files) assert.equal(normalizedSha(readFileSync(join(repo, file.path))), file.normalizedLfSha256, 'Archive source mismatch: ' + file.path);
mkdirSync(output, { recursive: true });
for (const file of ['prepare.mjs', 'inspect.mjs', 'run-v2.mjs', 'summarize.mjs', 'lane_profile.rs', 'lane_profile_exports.rs']) {
  let text = readFileSync(join(bundle, 'templates', file), 'utf8');
  text = text.replaceAll('.lane/p/current-step-profile-v1', outputRelative);
  if (file === 'prepare.mjs') {
    const git = "execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()";
    assert.ok(text.includes(git));
    text = text.replace(git, JSON.stringify(baseline.commit));
  }
  writeFileSync(join(output, file), text);
}
const runner = join(bundle, 'job-run.mjs');
const runJobs = (file) => {
  const spec = JSON.parse(readFileSync(file));
  const jobs = Array.isArray(spec) ? spec : [spec];
  // Let each inner process-tree deadline fire before this supervisor's final bound.
  const supervisorDeadline = jobs.reduce((n, j) => n + j.timeout + 15000, 60000);
  const run = spawnSync(process.execPath, [runner, file], { cwd: repo, env: { ...process.env, LANE_PROFILE_OUTPUT: output }, stdio: 'inherit', timeout: supervisorDeadline, windowsHide: true });
  if (run.error || run.status !== 0) throw run.error ?? new Error('Hard-limited job runner failed: ' + file + ' code ' + run.status);
};
const job = (name, args, timeout = 180000, env = {}) => {
  const file = join(output, name + '-job.json');
  writeFileSync(file, JSON.stringify({ cmd: process.execPath, args, cwd: repo, timeout, env, log: join(output, name + '.log') }, null, 2) + '\n');
  runJobs(file);
};
job('u64-regression', [join(bundle, 'u64-regression.mjs')]);
job('prepare', [join(output, 'prepare.mjs')]);
writeFileSync(join(output, 'reproduction.json'), JSON.stringify({ verifiedArchiveCommit: baseline.commit, repository: repo, output: outputRelative, eolNormalization: 'CRLF to LF only', originalEvidence: 'evidence/', noExistingIgnoredFilesRequired: true, profileSelected: process.argv.includes('--profile'), stageOnly: process.argv.includes('--stage-only') }, null, 2) + '\n');
if (process.argv.includes('--stage-only')) {
  console.log('Source-equivalent diagnostic staged; no build or timing requested.');
  process.exit(0);
}
runJobs(join(output, 'build-jobs.json'));
job('inspect', [join(output, 'inspect.mjs')]);
if (!process.argv.includes('--profile')) {
  console.log('Matched artifacts built and calibration loop inspected. No profiling/calibration timing ran. Use a fresh tag with --profile to select a bounded profiling session.');
  process.exit(0);
}
const env = { MARGO_GPU_EXCLUSIVE: '1', ...(arg('firefox') ? { REPLAY_FIREFOX: resolve(arg('firefox')) } : {}) };
job('run-v2', [join(output, 'run-v2.mjs')], 900000, env);
job('summarize', [join(output, 'summarize.mjs')]);
console.log('Matched profile evidence saved in ' + relative(repo, output) + '; all physics/source/accuracy predicates unchanged.');

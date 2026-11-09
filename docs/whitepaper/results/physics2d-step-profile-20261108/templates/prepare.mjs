import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve, relative, basename } from 'node:path';

const root = resolve('.lane/p/current-step-profile-v1');
const source = join(root, 'source');
assert.ok(!existsSync(source), 'Never replace an existing frozen source');
const kernel = 'packages/physics2d/kernel';
const allowed = ['packages/physics2d/kernel', 'packages/physics/kernel-common', 'packages/physics2d/README.md'];
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const keep = (file) => !basename(file).startsWith('target') && basename(file) !== '.git';
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return !keep(p) ? [] : e.isDirectory() ? files(p) : [p];
  });
}
const originalFiles = allowed.flatMap((p) => p.endsWith('.md') ? [resolve(p)] : files(resolve(p)));
const inventory = originalFiles.map((file) => ({ path: relative(process.cwd(), file).replaceAll('\\', '/'), sha256: sha(file) }));
mkdirSync(source, { recursive: true });
for (const p of allowed) cpSync(p, join(source, p), { recursive: true, filter: keep });
for (const row of inventory) {
  assert.equal(sha(row.path), row.sha256, 'Live source changed while copying: ' + row.path);
  assert.equal(sha(join(source, row.path)), row.sha256);
}
const edits = [];
function edit(file, replacements, tail = '') {
  const full = join(source, kernel, file);
  const beforeSha256 = sha(full);
  let text = readFileSync(full, 'utf8').replaceAll('\r\n', '\n');
  for (const [old, next] of replacements) {
    assert.equal(text.split(old).length, 2, 'Exactly one marker required: ' + file + ' ' + old.slice(0, 90));
    text = text.replace(old, next);
  }
  writeFileSync(full, text + tail);
  edits.push({ file: kernel + '/' + file, beforeSha256, afterSha256: sha(full) });
}
const mark = (name, indent = '    ') => `${indent}#[cfg(feature = "lane-profile")] crate::lane_profile::mark(crate::lane_profile::${name});\n`;
const count = (i, v, indent = '    ') => `${indent}#[cfg(feature = "lane-profile")] crate::lane_profile::add_count(${i}, (${v}) as u64);\n`;
edit('Cargo.toml', [], '\n[features]\nlane-profile = []\n');
edit('wasm-check/Cargo.toml', [], '\n[features]\nlane-profile = ["margoengine-physics2d-kernel/lane-profile"]\n');
edit('src/lib.rs', [], '\n#[cfg(feature = "lane-profile")]\npub mod lane_profile;\n');
cpSync(join(root, 'lane_profile.rs'), join(source, kernel, 'src/lane_profile.rs'));
edit('src/world.rs', [
  ['    pub fn step(&mut self, dt: f32) -> Result<(), PhysicsError> {\n', '    pub fn step(&mut self, dt: f32) -> Result<(), PhysicsError> {\n        #[cfg(feature = "lane-profile")] let _profile_guard = crate::lane_profile::begin();\n'],
  ['        self.broad_phase()?;\n', mark('BROAD', '        ') + '        self.broad_phase()?;\n'],
  ['        self.narrow_phase()?;\n', mark('NARROW', '        ') + '        self.narrow_phase()?;\n'],
  ['        self.wake_and_join();\n', mark('ISLANDS', '        ') + '        self.wake_and_join();\n'],
  ['        solver::solve(self, dt)?;\n', mark('SETUP', '        ') + '        solver::solve(self, dt)?;\n' + mark('POST_SOLVE_VALIDATION', '        ')],
  ['        self.sleep(dt);\n', mark('SLEEP', '        ') + '        self.sleep(dt);\n' + mark('POST_SLEEP_VALIDATION', '        ')],
]);
edit('src/solver.rs', [
  ['    let mut support = core::mem::take(&mut world.scratch.support);\n', mark('PLANNER') + '    let mut support = core::mem::take(&mut world.scratch.support);\n'],
  ['    let mut support_plan = path_support::plan(world, &ids, &constraints, &bounces, &mut support);\n', '    let mut support_plan = path_support::plan(world, &ids, &constraints, &bounces, &mut support);\n' + count(0, 'substeps') + count(1, 'passes') + count(2, 'moving') + count(3, 'constraints.len()') + count(4, 'blocks.blocks.len()') + count(5, 'colouring.used()') + count(6, '1') + count(7, 'support_plan.is_some()')],
  ['    for _ in 0..substeps {\n', '    for _ in 0..substeps {\n' + mark('SUBSTEP_PREP', '        ') + count(8, 'support_plan.is_some()', '        ')],
  ['        wide::warm_start(&mut bodies, &blocks.blocks);\n', mark('WARM', '        ') + count(14, '1', '        ') + '        wide::warm_start(&mut bodies, &blocks.blocks);\n'],
  ['        for _ in 0..passes {\n            if joints {\n                write_velocities(world, &bodies, &ids);\n                joint::solve(\n', mark('BIASED', '        ') + count(10, 'passes', '        ') + count(11, 'passes as usize * order[single..].len()', '        ') + '        for _ in 0..passes {\n            if joints {\n                write_velocities(world, &bodies, &ids);\n                joint::solve(\n'],
  ['        if let Some(plan) = &support_plan {\n', mark('CORRECTION', '        ') + count(9, 'support_plan.is_some()', '        ') + '        if let Some(plan) = &support_plan {\n'],
  ['        for ((body, &id), start) in bodies[..moving].iter_mut().zip(&ids).zip(&start) {\n', mark('INTEGRATION', '        ') + '        for ((body, &id), start) in bodies[..moving].iter_mut().zip(&ids).zip(&start) {\n'],
  ['        fresh = true;\n        for _ in 0..passes {\n', mark('RELAX', '        ') + count(12, 'passes', '        ') + count(13, 'passes as usize * order[single..].len()', '        ') + '        fresh = true;\n        for _ in 0..passes {\n'],
  ['        for (observed, &substep) in pose_speed.iter_mut().zip(&substep_pose_speed) {\n', mark('OBSERVER', '        ') + '        for (observed, &substep) in pose_speed.iter_mut().zip(&substep_pose_speed) {\n'],
  ['    world.counts.block = block;\n', mark('FINALIZE') + '    world.counts.block = block;\n'],
]);
edit('wasm-check/src/lib.rs', [], '\n#[path = "lane_profile_exports.rs"]\nmod lane_profile_exports;\n');
cpSync(join(root, 'lane_profile_exports.rs'), join(source, kernel, 'wasm-check/src/lane_profile_exports.rs'));
const phases = ['preflight', 'broad', 'narrow', 'islands', 'solver-setup', 'support-planner', 'substep-preparation', 'warm-start', 'biased-solve', 'support-correction', 'pose-integration', 'relax-solve', 'substep-observer', 'solver-finalization', 'post-solve-validation', 'sleep', 'post-sleep-validation'];
const counts = ['substeps', 'passes-per-substep', 'moving-bodies', 'constraints', 'simd-blocks', 'colours', 'planner-calls', 'eligible-plan', 'snapshot-calls', 'correction-calls', 'wide-biased-calls', 'scalar-biased-contact-visits', 'wide-relax-calls', 'scalar-relax-contact-visits', 'warm-start-calls'];
const publicCounts = ['compared', 'pairs', 'manifolds', 'cold-points', 'constraints', 'block', 'sequential', 'colours', 'overflow', 'islands', 'awake-bodies'];
const expected = ['9ffefc83c3a99be4', '95a47530df180011', '92db6847c4e919d4'];
const buildJobs = ['control', 'instrumented'].map((name) => ({ cmd: 'cargo', args: ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', join(source, kernel, 'wasm-check/Cargo.toml'), ...(name === 'instrumented' ? ['--features', 'lane-profile'] : [])], timeout: 600000, env: { RUSTFLAGS: '-C target-feature=+simd128', CARGO_TARGET_DIR: join(root, 'target-' + name) }, log: join(root, name + '-build.log') }));
writeFileSync(join(root, 'build-jobs.json'), JSON.stringify(buildJobs, null, 2) + '\n');
writeFileSync(join(root, 'manifest.json'), JSON.stringify({ sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), copiedBeforeEdits: inventory, edits, phases, counts, publicCounts, expected, profileReleaseRequired: true, buildJobs, artifactPaths: ['control', 'instrumented'].map((name) => ({ name, file: join(root, 'target-' + name, 'wasm32-unknown-unknown/release/margoengine_physics2d_wasm_check.wasm') })) }, null, 2) + '\n');
console.log('Prepared frozen matched source; no checks or timings run.');

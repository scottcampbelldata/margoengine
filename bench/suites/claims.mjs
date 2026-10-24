// Published-claim mode (opt-in: `npm run bench -- claims --engines=all`): each engine's own benchmark harness, run where
// it lives in engine-bench under this run's gate and GPU lock, so its published numbers are recorded beside the shared
// scenes, on the same machine and in the same result file. An engine opts in with a `harness` entry in
// engine-bench/margo-bench/engines.json:
//   "harness": {"command": "npm run bench:render", "cwd": "wasmgpu-repo", "results": ["wasmgpu-repo/bench/out.json"]}
// `command` is one shell command line
// `cwd` and `results` are relative to engine-bench. The result files are copied into benchmarks/runs/<id>/claims/ and
// kept (JSON up to 1 MB) in the case's info, labelled as that engine's own harness, not the shared scenes.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export default {
  name: 'claims',
  title: "Other engines' own harnesses (published-claim mode)",
  uses: 'gpu',
  async cases(ctx) {
    return Object.entries(ctx.external ?? {})
      .filter(([name, e]) => e.harness && ctx.engines.includes(name))
      .map(([name, e]) => ({
        id: `own-harness@${name}`,
        title: `${name}${e.version ? ` ${e.version}` : ''}: its own harness, ${e.harness.command}`,
        engine: name,
        runs: 1,
        warmup: 0,
        metrics: { seconds: { unit: 's', better: 'lower' } },
        async run() {
          const cwd = resolve(e.root, e.harness.cwd ?? '.'),
            out = join(ctx.shots, 'claims', name),
            start = Date.now();
          const r = spawnSync(e.harness.command, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, shell: true });
          mkdirSync(out, { recursive: true });
          writeFileSync(join(out, 'harness.log'), `${r.stdout ?? ''}${r.stderr ?? ''}`);
          if (r.status !== 0) throw new Error(`${name} harness exit ${r.status}; log ${join(out, 'harness.log')}`);
          const results = {};
          for (const file of e.harness.results ?? []) {
            const path = resolve(e.root, file);
            if (!existsSync(path)) throw new Error(`${name} harness did not write ${file}`);
            cpSync(path, join(out, basename(path)));
            results[file] =
              path.endsWith('.json') && statSync(path).size < 2 ** 20
                ? JSON.parse(readFileSync(path, 'utf8'))
                : `copied to ${join(out, basename(path))}`;
          }
          return {
            values: { seconds: (Date.now() - start) / 1000 },
            info: { label: `${name}'s own harness, not the shared scenes`, results },
          };
        },
      }));
  },
};

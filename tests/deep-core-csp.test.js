import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// A fresh process gives each test a fresh compiled-module cache and contains the browser compilation stub.
for (const method of ['compile', 'instantiate'])
  for (const kind of ['CompileError', 'EvalError'])
    for (const mode of ['throw', 'reject'])
      test(`core transform kernel reports CSP-blocked ${method}: ${kind} ${mode}`, () => {
        const url = new URL('../packages/core/dist/extension.js', import.meta.url).href;
        const result = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
        import assert from 'node:assert/strict';
        const { TransformStore } = await import(${JSON.stringify(url)});
        const cause = new ${kind === 'CompileError' ? 'WebAssembly.CompileError' : 'EvalError'}('WebAssembly blocked by Content Security Policy');
        WebAssembly.${method} = ${mode === 'reject' ? 'async ' : ''}() => { throw cause; };
        await assert.rejects(TransformStore.create(1), error => {
          assert.equal(error.name, 'MargoError');
          assert.equal(error.code, 'failed');
          assert.equal(error.cause, cause);
          assert.ok(error.message.includes("'wasm-unsafe-eval'"));
          assert.ok(error.message.includes('script-src'));
          assert.ok(error.message.endsWith('https://margoengine.com/llms/docs/csp.md'));
          return true;
        });
      `,
          ],
          { encoding: 'utf8', timeout: 30_000 },
        );
        assert.equal(result.error, undefined, String(result.error));
        assert.equal(result.status, 0, result.stdout + result.stderr);
      });

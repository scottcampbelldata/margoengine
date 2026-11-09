import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Each loader gets a fresh process: module caches and global compilation stubs cannot affect another path.
export function blockedLoad(url, expression, kind) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    const blocked = new ${kind}("WebAssembly compilation blocked by Content Security Policy");
    WebAssembly.compile = WebAssembly.instantiate = WebAssembly.instantiateStreaming = async () => { throw blocked; };
    const api = await import(${JSON.stringify(url.href)});
    await assert.rejects(async () => { ${expression} }, error => {
      assert.equal(error.name, 'MargoError');
      assert.equal(error.code, 'failed');
      assert.match(error.message, /'wasm-unsafe-eval'.*script-src/);
      assert.ok(error.message.endsWith('https://margoengine.com/llms/docs/csp.md'));
      return true;
    });
  `,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

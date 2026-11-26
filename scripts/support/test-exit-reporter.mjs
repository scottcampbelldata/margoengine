// A `node --test` reporter: the spec reporter's output, plus a line for each test file whose process ended without a
// result. Node reports such a file as a bare 'test failed' (no subtest, no stderr) whether it was killed from outside
// or crashed (KB-TEST-FILEEXIT1, flood bounds 2026-11-26); the event does carry the child's exit code and signal and
// the elapsed time, which this prints. Used through NODE_OPTIONS=--test-reporter=<this file> (see testExitEnv).
import { Readable } from 'node:stream';
import { spec } from 'node:test/reporters';

/** The report line for a failed test event when it is a file that ended without a result, else ''. */
export function exitLine(data) {
  const error = data.details?.error;
  if (data.nesting !== 0 || error?.code !== 'ERR_TEST_FAILURE' || String(error.cause) !== 'test failed') return '';
  const file = (data.file ?? data.name).replaceAll('\\', '/');
  return (
    `test file ended without a result: ${file}, exit code ${error.exitCode ?? 'none'}, ` +
    `signal ${error.signal ?? 'none'}, after ${Math.round(data.details.duration_ms)} ms ` +
    '(ended from outside or crashed with no output; see KB-TEST-FILEEXIT1)\n'
  );
}

/** `env` with this reporter set for every `node --test` below it, the nested ones of a package's test script included. */
export function testExitEnv(env = process.env) {
  const flag = `--test-reporter=${import.meta.url}`;
  return {
    ...env,
    NODE_OPTIONS: [env.NODE_OPTIONS, flag].filter(Boolean).join(' '),
  };
}

export default async function* reporter(source) {
  const lines = [];
  async function* tapped() {
    for await (const event of source) {
      if (event.type === 'test:fail') {
        const line = exitLine(event.data);
        if (line) lines.push(line);
      }
      yield event;
    }
  }
  yield* Readable.from(tapped(), { objectMode: true }).pipe(spec());
  yield* lines;
}

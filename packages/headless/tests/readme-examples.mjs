// The README examples tests/node-check.mjs runs in Node: every `ts` example that imports the `webgpu` binding. Their
// number is the README's, not a constant here, so a new example joins the check by being written; what is refused is
// an import of the binding outside a `ts` example, which the check would silently never run.
const BINDING = "from 'webgpu'";

const count = (text) => text.split(BINDING).length - 1;

/** The code of each `ts` example in `readme` that imports the binding. Throws when there is none, or one is missed. */
export function nodeExamples(readme) {
  const text = readme.replaceAll('\r\n', '\n'),
    examples = [...text.matchAll(/```ts\n(.*?)```/gs)]
      .map((match) => match[1])
      .filter((code) => code.includes(BINDING));
  if (!examples.length) throw new Error('the README has no ts example that imports the webgpu binding');
  const missed = count(text) - examples.reduce((sum, code) => sum + count(code), 0);
  if (missed)
    throw new Error(
      `${missed} import(s) of the webgpu binding in the README are outside a ts example, so no check runs them`,
    );
  return examples;
}

/** What an example needs that the check must bring: ffmpeg on the path, or a reference picture to compare against. */
export function needs(code) {
  return {
    ffmpeg: code.includes("from '@margoengine/headless/ffmpeg'"),
    reference: code.includes('compareImages('),
  };
}

export { referenceMaker } from '../../../scripts/support/headless-readme.mjs';

/**
 * Why `examples` cannot all run on this machine, or undefined when they can: an example that pipes to ffmpeg needs it
 * on the path. Said in the repository's words for a check that did not run, which is never a pass (AGENTS.md: no
 * skipped tests), so node-check.mjs fails with it instead of skipping the example.
 */
export function cannotRun(examples, { ffmpeg }) {
  const missing = examples.flatMap((code, index) => (needs(code).ffmpeg && !ffmpeg ? [index] : []));
  if (!missing.length) return undefined;
  return (
    `README example ${missing.join(', ')} did not run (this is not a pass): it pipes frames to ffmpeg, which is not ` +
    "on this machine's path. Install ffmpeg (https://ffmpeg.org/download.html) and run the check again."
  );
}

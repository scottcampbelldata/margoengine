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

/**
 * The example cut before its comparison, writing the picture it would compare instead: run first, in its own process,
 * it makes the reference the example then reads. Throws when the example has no `const result = await compareImages(`.
 */
export function referenceMaker(code, file = 'reference.png') {
  const cut = code.indexOf('const result = await compareImages(');
  if (cut < 0)
    throw new Error('the comparing example no longer starts its comparison with `const result = await compareImages(`');
  return `${code.slice(0, cut)}await writeFile('${file}', await encodePNG(await readPixels(engine)));\n`;
}

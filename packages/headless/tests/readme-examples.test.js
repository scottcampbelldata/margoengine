// Which README examples node-check.mjs runs, on the CPU: the README decides how many, and none can hide from the check.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { cannotRun, needs, nodeExamples, referenceMaker } from './readme-examples.mjs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8'),
  example = (body) => `\`\`\`ts\nimport { create } from 'webgpu';\n${body}\n\`\`\`\n`;

test('every README example on the binding is run, however many the README has', () => {
  // The check once held a count of three and failed when the README grew a fourth, fifth and sixth real example.
  const examples = nodeExamples(readme);
  assert.equal(examples.length, readme.split("from 'webgpu'").length - 1);
  assert.ok(examples.length >= 6);
  assert.equal(nodeExamples(`# A\n\n${example('one();')}\ntext\n\n${example('two();')}`).length, 2);
  assert.equal(nodeExamples(example('one();').replaceAll('\n', '\r\n')).length, 1, 'Windows line ends');
});

test('an import of the binding the check would not run, or none at all, is refused', () => {
  assert.throws(
    () => nodeExamples(`${example('one();')}\`\`\`js\nimport { create } from 'webgpu';\n\`\`\`\n`),
    /1 import\(s\).*outside a ts example/,
  );
  assert.throws(
    () => nodeExamples(`Run \`import { create } from 'webgpu'\` first.\n\n${example('one();')}`),
    /outside a ts example/,
  );
  assert.throws(() => nodeExamples('```ts\nconst a = 1;\n```\n'), /no ts example/);
});

test('the ffmpeg and comparing examples say what they need, and the reference is the example cut before its comparison', () => {
  const examples = nodeExamples(readme),
    ffmpeg = examples.filter((code) => needs(code).ffmpeg),
    compared = examples.filter((code) => needs(code).reference);
  assert.equal(ffmpeg.length, 1);
  assert.equal(compared.length, 1);
  const maker = referenceMaker(compared[0]);
  assert.ok(compared[0].startsWith(maker.slice(0, maker.indexOf("await writeFile('reference.png'"))));
  assert.match(
    maker,
    /engine\.render\(.*\n+await writeFile\('reference\.png', await encodePNG\(await readPixels\(engine\)\)\);\n$/s,
  );
  assert.doesNotMatch(maker, /compareImages\(await/);
  assert.throws(() => referenceMaker('const same = compareImages(a, b);'), /no longer starts its comparison/);
});

test('an example the machine cannot run fails the check as not run, never a skip', () => {
  // node-check.mjs once printed "skip README example ..." and passed where ffmpeg was missing (AGENTS.md: no skips).
  const examples = nodeExamples(readme),
    index = examples.findIndex((code) => needs(code).ffmpeg);
  assert.equal(cannotRun(examples, { ffmpeg: true }), undefined);
  assert.match(
    cannotRun(examples, { ffmpeg: false }),
    new RegExp(`^README example ${index} did not run \\(this is not a pass\\): it pipes frames to ffmpeg`),
  );
  const check = readFileSync(new URL('./node-check.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(check, /\bskip\b/i, 'node-check.mjs skips nothing');
  assert.match(check, /cannotRun\(examples, \{ ffmpeg: hasFFmpeg \}\)/);
});

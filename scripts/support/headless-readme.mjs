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

/** Prepare a caller-named PNG reference for the documented headless comparison shape. */
export function headlessReference(code) {
  if (!/from ['"]@margoengine\/headless\/compare['"]/.test(code)) return undefined;
  const cut = code.indexOf('const result = await compareImages(');
  if (cut < 0) throw new Error('Headless comparison reference needs const result = await compareImages(');
  const file = /await readFile\(['"]([\w./-]+\.png)['"]\)/.exec(code.slice(cut))?.[1];
  if (!file) throw new Error('Headless comparison reference needs a literal PNG file path');
  return referenceMaker(code, file);
}

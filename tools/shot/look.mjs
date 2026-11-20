// The look checks of a rendered shot (P4): @margoengine/headless/look's checkShot over the probe frames the manifest
// names, with the shot's lookBounds, and its report beside manifest.json: look.md (the table), look.json and look.png
// (the contact sheet, each probe framed green or red). docs/shots.md, Look checks.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodePNG } from '@margoengine/headless';
import { checkShot } from '@margoengine/headless/look';

/** The report files lookShot writes into the shot folder. */
export const LOOK_FILES = Object.freeze(['look.md', 'look.json', 'look.png']);

/**
 * Runs the look checks of the shot rendered into `out` (its manifest given) and writes look.md, look.json and
 * look.png there. Resolves checkShot's report; `report.pass` is false when any check of any probe fails.
 */
export async function lookShot(out, manifest, { signal } = {}) {
  const report = await checkShot({ manifest, read: (path) => readFile(join(out, path)), signal });
  await writeFile(join(out, 'look.md'), report.markdown);
  await writeFile(join(out, 'look.json'), JSON.stringify(report.json, null, 2) + '\n');
  await writeFile(join(out, 'look.png'), await encodePNG(report.sheet));
  return report;
}

/** One line per failing check, `probe check: value unit, bound low to high`, for the console. */
export function lookFailures(report) {
  return report.json.probes.flatMap((probe) =>
    probe.results.filter((row) => !row.pass).map((row) => `${probe.name} ${row.check}: ${row.missing ? `needs ${row.missing}` : `${row.value} ${row.unit}`}, bound ${row.bound.join(' to ')}`),
  );
}

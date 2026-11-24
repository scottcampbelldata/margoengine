#!/usr/bin/env node
// node tools/shot/cli.mjs <shot.json> [--day YYYY-MM-DD] [--out <dir>] [--seconds <s>] [--once] [--production] [--check] [--encode] [--stills] [--cameras] [--measure]
// Renders a shot file to PNG frames twice and checks the two renders match (docs/shots.md). --check only validates
// the file. Output goes to <MARGO_SHOT_OUT or test-results/shots>/<day>/<id>/ unless --out names a folder.
// --seconds renders the first part of the shot; --once skips the second render (no determinism verdict);
// --production renders once in full and checks determinism on the probe frames only (docs/shots.md); --encode
// then makes and checks the MP4 master (encode.mjs, ffmpeg from MARGO_FFMPEG or the PATH). A shot that names probes
// gets its look checks after the render (look.mjs): look.md, look.json and look.png beside manifest.json.
// --stills renders only the probe frames, as <out>/<probe>.png with <out>/stills.json (a film's storyboard stills);
// --cameras prints the camera of every kept frame as JSON (cameraFrames in shot-file.mjs), with no browser.
// --measure loads the page as a render does, captures nothing, and prints its measure as JSON (measure.mjs): the page's
// errors, the camera's near and far planes and the ground under every kept frame's camera and target.
// Exit codes: 0 rendered and identical (and every look check and master check passed), 1 failed, 2 bad arguments or
// shot file, 3 rendered but a look check failed (look.md says which).
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { cameraFrames, firstSeconds, parseShot } from './shot-file.mjs';
import { shotOutput } from './platform.mjs';

const usage =
  'usage: node tools/shot/cli.mjs <shot.json> [--day YYYY-MM-DD] [--out <dir>] [--seconds <s>] [--browser=<name>] [--once] [--production] [--check] [--encode] [--stills] [--cameras] [--measure]';

// Renders, checks and encodes as asked; resolves to the exit code above.
async function main() {
  let code = 0;
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: 'string' },
        day: { type: 'string' },
        browser: { type: 'string' },
        seconds: { type: 'string' },
        once: { type: 'boolean', default: false },
        production: { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        encode: { type: 'boolean', default: false },
        stills: { type: 'boolean', default: false },
        cameras: { type: 'boolean', default: false },
        measure: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    console.error(`${error.message}\n${usage}`);
    return 2;
  }
  if (values.help || positionals.length !== 1) {
    console.error(usage);
    return values.help ? 0 : 2;
  }
  if (values.once && values.production) {
    console.error(
      `--once and --production: pick one (--production already renders once, with its probes checked)\n${usage}`,
    );
    return 2;
  }
  const alone = values.once || values.production || values.encode || values.check || values.seconds !== undefined;
  const own = [values.stills, values.cameras, values.measure].filter(Boolean).length;
  if (own && (alone || own > 1)) {
    console.error(`--stills, --cameras and --measure each stand alone, with no other mode\n${usage}`);
    return 2;
  }
  const root = resolve(import.meta.dirname, '../..'),
    source = resolve(positionals[0]);
  let file;
  try {
    let json = JSON.parse(readFileSync(source, 'utf8'));
    if (values.seconds !== undefined) json = firstSeconds(json, Number(values.seconds));
    file = parseShot(json);
    if (values.production && !Object.keys(file.shot.probes).length)
      throw new TypeError('--production checks the probe frames: name some in shot.probes');
  } catch (error) {
    console.error(`${relative(root, source)}: ${error.message}`);
    return 2;
  }
  if (values.cameras) {
    try {
      console.log(JSON.stringify(cameraFrames(file)));
    } catch (error) {
      console.error(`${relative(root, source)}: ${error.message}`);
      return 2;
    }
    return 0;
  }
  if (values.check) {
    console.log(
      `${relative(root, source)}: valid shot ${file.shot.id}, ${Math.round(file.shot.seconds * file.shot.fps)} frames`,
    );
    return 0;
  }
  // tools/shot/platform.mjs reads the choice from MARGO_BROWSER.
  if (values.browser) process.env.MARGO_BROWSER = values.browser;
  // The dev server serves the repository, and the shot's page path is from its top.
  process.chdir(root);
  let output;
  try {
    output = shotOutput(file.shot.id, { repo: root, ...(values.day ? { day: values.day } : {}) });
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (values.measure) {
    const { measureShot } = await import('./measure.mjs');
    try {
      console.log(JSON.stringify(await measureShot(file)));
      return 0;
    } catch (error) {
      console.error(error.stack ?? String(error));
      return 1;
    }
  }
  const out = resolve(values.out ?? output.frames);
  if (values.stills) {
    if (!Object.keys(file.shot.probes).length) {
      console.error(`${relative(root, source)}: --stills renders the probe frames: name some in shot.probes`);
      return 2;
    }
    const { shootStills } = await import('./stills.mjs');
    try {
      const manifest = await shootStills(file, { out, source: relative(root, source).replace(/\\/g, '/') });
      console.log(`stills of ${manifest.id}: ${Object.keys(manifest.stills).join(', ')} in ${relative(root, out)}`);
      return 0;
    } catch (error) {
      console.error(error.stack ?? String(error));
      return 1;
    }
  }
  const { shoot } = await import('./render.mjs');
  try {
    const manifest = await shoot(file, {
      out,
      output: { day: output.day, master: output.master, caption: output.caption },
      source: relative(root, source).replace(/\\/g, '/'),
      runs: values.once ? 1 : 2,
      check: values.production ? 'probes' : 'every',
    });
    const { determinism } = manifest,
      verdict = !determinism.identical
        ? 'one render, determinism not checked'
        : determinism.check === 'probes'
          ? `one render, its ${determinism.checked.length} probe frames identical on a second render`
          : 'two renders identical';
    console.log(`shot ${manifest.id}: ${manifest.frames} frames in ${relative(root, out)}, ${verdict}`);
    if (Object.keys(manifest.probes).length) {
      const { lookShot, lookFailures } = await import('./look.mjs');
      const look = await lookShot(out, manifest);
      for (const line of lookFailures(look)) console.error(`look check failed: ${line}`);
      console.log(`look checks ${look.pass ? 'pass' : 'FAILED'}: ${relative(root, join(out, 'look.md'))}`);
      if (!look.pass) code = 3;
    }
    if (values.encode) {
      const { encodeShot } = await import('./encode.mjs');
      const report = await encodeShot(out);
      for (const [name, check] of Object.entries(report.checks))
        if (!check.pass) console.error(`master check ${name} failed: ${JSON.stringify(check)}`);
      for (const flag of report.proxyFlags ?? []) console.log(`proxy flag: ${flag}`);
      console.log(`master ${report.pass ? 'ok' : 'FAILED'}: ${report.master} (${report.bitrateMbps} Mbps)`);
      // A failed master outranks a failed look check: the file is not fit to hand on.
      if (!report.pass) code = 1;
    }
  } catch (error) {
    console.error(error.stack ?? String(error));
    return 1;
  }
  return code;
}

process.exitCode = await main();

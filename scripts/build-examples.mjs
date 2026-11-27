// Builds /examples/ against the published @margoengine 0.1.0 packages.
// Heavy files are not bundled. They load from examples/live/asset-base.js.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { films } from '../examples/live/films.js';

const repo = resolve(import.meta.dirname, '..');
const live = resolve(repo, 'examples/live');
const viteBin = resolve(live, 'node_modules/vite/bin/vite.js');

function installPublished() {
  if (existsSync(resolve(live, 'node_modules/@margoengine/core/package.json')) && existsSync(viteBin)) return;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = existsSync(resolve(live, 'package-lock.json')) ? ['ci'] : ['install'];
  execFileSync(npm, [...args, '--prefix', live, '--workspaces=false'], { cwd: repo, stdio: 'inherit' });
}

export async function buildLiveExamples(siteOut = resolve(repo, 'site/dist')) {
  installPublished();
  await rm(resolve(siteOut, 'examples'), { recursive: true, force: true });
  execFileSync(process.execPath, [viteBin, 'build', '--config', resolve(live, 'vite.config.js')], {
    cwd: repo,
    stdio: 'inherit',
  });
  const examplesOut = resolve(siteOut, 'examples');
  for (const film of films) {
    const rel = film.entry.replace(/^examples\//, '');
    const from = resolve(examplesOut, rel);
    const to = resolve(examplesOut, film.id, 'index.html');
    if (from === to) continue;
    let html = await readFile(from, 'utf8');
    const fromDepth = rel.split('/').length - 1;
    if (fromDepth > 1) html = html.replaceAll('../'.repeat(fromDepth), '../');
    await mkdir(resolve(examplesOut, film.id), { recursive: true });
    await writeFile(to, html);
    await rm(from);
  }
  await rm(resolve(examplesOut, 'showcase-films'), { recursive: true, force: true });
  await rm(resolve(examplesOut, 'live'), { recursive: true, force: true });
  await rm(resolve(examplesOut, 'underwater-cable'), { recursive: true, force: true });
  await rm(resolve(examplesOut, 'glass-bench'), { recursive: true, force: true });
  await mkdir(examplesOut, { recursive: true });
  for (const name of await readdir(resolve(repo, 'site/examples'))) {
    await cp(resolve(repo, 'site/examples', name), resolve(examplesOut, name), { recursive: true, force: true });
  }
  await cp(resolve(repo, 'examples/showcase-films/assets'), resolve(examplesOut, 'packed/showcase-films/assets'), {
    recursive: true,
  });
  for (const film of films) {
    for (const file of film.sources) {
      const dest = resolve(examplesOut, 'source', film.id, basename(file));
      await mkdir(resolve(dest, '..'), { recursive: true });
      await cp(resolve(repo, file), dest);
    }
  }
  console.log(examplesOut);
}

const invoked =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) await buildLiveExamples();

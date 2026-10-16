// Khronos sample assets (HANDOFF launch gate 5): runs the Khronos glTF-Validator on every model in
// examples/assets/khronos/manifest.json, records size, triangles, extensions and the result there, and regenerates the
// model table and third-party notices in examples/assets/khronos/README.md (between the <!-- models --> and
// <!-- notices --> markers). `render` (the eyeballed gallery verdict, HANDOFF 5w) is written by hand and kept.
//   node scripts/khronos-assets.mjs
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';

const validator = createRequire(import.meta.url)('gltf-validator');
const dir = resolve(import.meta.dirname, '../examples/assets/khronos'),
  manifestPath = resolve(dir, 'manifest.json'),
  readmePath = resolve(dir, 'README.md');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

for (const m of manifest.models) {
  const folder = resolve(dir, m.name),
    path = resolve(folder, m.file);
  const report = await validator.validateBytes(new Uint8Array(await readFile(path)), {
    uri: m.file,
    maxIssues: 0,
    externalResourceFunction: (uri) =>
      readFile(resolve(dirname(path), decodeURIComponent(uri))).then((b) => new Uint8Array(b)),
  });
  const files = await readdir(folder),
    codes = {};
  for (const message of report.issues.messages)
    if (message.severity <= 1) codes[message.code] = (codes[message.code] ?? 0) + 1;
  m.screenshot = files.find((f) => f.startsWith('screenshot.'));
  m.bytes = (
    await Promise.all(files.filter((f) => f !== m.screenshot).map((f) => stat(resolve(folder, f)).then((s) => s.size)))
  ).reduce((a, b) => a + b, 0);
  m.triangles = report.info.totalTriangleCount;
  m.extensionsUsed = report.info.extensionsUsed ?? [];
  m.extensionsRequired = report.info.extensionsRequired ?? [];
  m.validator = {
    version: report.validatorVersion,
    errors: report.issues.numErrors,
    warnings: report.issues.numWarnings,
    infos: report.issues.numInfos,
    hints: report.issues.numHints,
    codes,
  };
  console.log(
    `${m.name.padEnd(28)} errors ${m.validator.errors} warnings ${m.validator.warnings} ${Object.keys(codes).join(' ')}`,
  );
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 1) + '\n');

const licence = (id) => ({ 'CC0-1.0': 'CC0 1.0', 'CC-BY-4.0': 'CC BY 4.0' })[id] ?? id;
const source = (m) => `${manifest.source}/tree/main/Models/${m.name}`;
const credit = (l) =>
  `${l.what}: ${l.artist}${l.owner && l.owner !== 'Public' && l.owner !== l.artist ? ` (© ${l.year} ${l.owner})` : ` (${l.year})`}, [${licence(l.license)}](${l.licenseUrl})`;
const result = (v) =>
  `${v.errors} errors, ${v.warnings} warnings${
    Object.keys(v.codes).length
      ? ` (${Object.entries(v.codes)
          .map(([c, n]) => `${c} x${n}`)
          .join(', ')})`
      : ''
  }`;
const table = [
  '| Model | Licence | Credit (from metadata.json) | Size | Triangles | Extensions used | Validator | Render check |',
  '|---|---|---|---|---|---|---|---|',
  ...manifest.models.map(
    (m) =>
      `| [${m.name}](${source(m)}) | ${[...new Set(m.legal.map((l) => licence(l.license)))].join(' + ')} | ${m.legal.map((l) => `${l.what}: ${l.artist}`).join('; ')} | ${(m.bytes / 1e6).toFixed(2)} MB | ${m.triangles.toLocaleString('en-US')} | ${m.extensionsUsed.map((e) => `\`${e}\``).join(', ') || '-'} | ${result(m.validator)} | ${m.render ? `**${m.render.verdict}**: ${m.render.notes}` : '-'} |`,
  ),
].join('\n');
const notices = manifest.models
  .map((m) => `- **${m.name}** ([source](${source(m)})): ${m.legal.map(credit).join('; ')}.`)
  .join('\n');
const readme = await readFile(readmePath, 'utf8');
const swap = (text, tag, body) =>
  text.replace(
    new RegExp(`<!-- ${tag} -->[\\s\\S]*?<!-- /${tag} -->`),
    () => `<!-- ${tag} -->\n${body}\n<!-- /${tag} -->`,
  );
await writeFile(readmePath, swap(swap(readme, 'models', table), 'notices', notices));
console.log(
  `${manifest.models.length} models; ${manifest.models.reduce((a, m) => a + m.validator.errors, 0)} errors, ${manifest.models.reduce((a, m) => a + m.validator.warnings, 0)} warnings`,
);

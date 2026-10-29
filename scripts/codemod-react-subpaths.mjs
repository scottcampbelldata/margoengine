// Codemod: @margoengine/react's root entry keeps only the bindings that need no optional package (2026-10-27). Every
// binding that needs one is imported from the subpath named after that package, so an app installs (and a bundler
// resolves) exactly the packages it uses; webpack and Turbopack then build `@margoengine/react` installed alone.
//   import { Canvas, Mesh, OrbitControls, Gltf } from '@margoengine/react';
// becomes
//   import { Canvas, Mesh } from '@margoengine/react';
//   import { OrbitControls } from '@margoengine/react/controls';
//   import { Gltf } from '@margoengine/react/gltf-pro';
// It also moves the names of the removed `@margoengine/react/kit` and the effects that left `/post` for their own
// packages (DepthOfField: /dof, Tonemap: /tonemap, TAA: /taa), and rewrites `preload(url)` to the component's
// `Gltf.preload(url)`, `Fbx.preload(url)` or `Environment.preload(url)` by extension. `margoengine/react`, the one
// install, still exports every binding and is left alone.
//
// Usage: node scripts/codemod-react-subpaths.mjs [--check] [paths...]
//   No paths: every tracked .ts/.tsx/.js/.jsx/.mjs/.md file except generated records and history. Idempotent.
//   Lists what it cannot rewrite (`<Canvas shadows>`, which is now `<Shadows />` from @margoengine/react/shadows; a
//   `preload` of a URL whose kind it cannot tell) and exits 1 when there are any, or with --check when a file would
//   change.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';

/** Where each binding lives. A name not listed stays where it is. */
export const SUBPATHS = {
  controls: [
    'OrbitControls',
    'MapControls',
    'CadControls',
    'ArcballControls',
    'OrbitControlsProps',
    'ArcballControlsProps',
    'ControlEventProps',
    'ProfileName',
    'PointerLock',
    'PointerLockProps',
    'TransformControls',
    'TransformControlsProps',
  ],
  'gltf-pro': ['Model', 'ModelProps', 'MaterialOverride', 'Gltf', 'GltfProps'],
  fbx: ['Fbx', 'FbxProps'],
  animation: ['Animation', 'AnimationProps', 'AnimationHandle'],
  environment: [
    'Environment',
    'EnvironmentProps',
    'AmbientLight',
    'AmbientLightProps',
    'HemisphereLight',
    'HemisphereLightProps',
    'Fog',
    'FogProps',
  ],
  html: ['Html', 'HtmlProps'],
  shadows: ['Shadows', 'ShadowsProps', 'ContactShadows', 'ContactShadowsProps'],
  sky: ['Sky', 'SkyProps'],
  text: ['Text', 'TextProps'],
  geometry: ['Box', 'BoxProps', 'Sphere', 'SphereProps', 'Plane', 'PlaneProps'],
  materials: [
    'MeshTransmissionMaterial',
    'MeshTransmissionMaterialProps',
    'BatchedMesh',
    'BatchedMeshProps',
    'BatchedItem',
    'BatchedItemProps',
  ],
  post: [
    'EffectComposer',
    'EffectComposerProps',
    'Bloom',
    'BloomProps',
    'SSAO',
    'SSAOProps',
    'GTAO',
    'GTAOProps',
    'SSR',
    'SSRProps',
    'SSGI',
    'SSGIProps',
    'MotionBlur',
    'MotionBlurProps',
    'LensFlare',
    'LensFlareProps',
    'SMAA',
    'SMAAProps',
    'FXAA',
    'FXAAProps',
    'Glitch',
    'GlitchProps',
    'Afterimage',
    'AfterimageProps',
    'DepthTexture',
    'DepthTextureProps',
    'SceneTargets',
    'SceneTargetsProps',
  ],
  dof: ['DepthOfField', 'DepthOfFieldProps'],
  tonemap: ['Tonemap', 'TonemapProps'],
  taa: ['TAA', 'TAAProps'],
  voxel: ['Voxels', 'VoxelsProps', 'useBlockTextures'],
};
const HOME = new Map(Object.entries(SUBPATHS).flatMap(([subpath, names]) => names.map((name) => [name, subpath])));
// Entries whose names are re-sorted: the root, the removed kit, and /post (three effects left it).
const SOURCES = new Set(['', 'kit', 'post']);
const SKIP = [
  /^api\//,
  /^site\/llms/,
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  /^CHANGELOG\.md$/,
  /^docs\/HANDOFF\.md$/,
  /^docs\/whitepaper\//,
  /^docs\/perf-history/,
  /^packages\/react\/src\//,
  /^scripts\/codemod-react-subpaths\.mjs$/,
  /^tests\/codemod-react-subpaths\.test\.js$/,
  /^private\//,
];

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Rewrites the `@margoengine/react` imports of one source; returns the text and what it could not rewrite. */
export function rewriteCode(text) {
  const problems = [];
  const pattern = /^import\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])@margoengine\/react(?:\/(kit|post))?\3;?[^\S\n]*$/gm;
  let output = text.replace(pattern, (whole, typeOnly, list, quote, sub = '') => {
    if (!SOURCES.has(sub)) return whole;
    const groups = new Map();
    for (const raw of list.split(',')) {
      const item = raw.trim();
      if (!item) continue;
      const name = item
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        .trim();
      const home = HOME.get(name) ?? (sub === 'kit' ? '' : sub);
      if (!groups.has(home)) groups.set(home, []);
      groups.get(home).push(item);
    }
    // Nothing moves: keep the import exactly as written (its own line breaks included).
    if (sub !== 'kit' && groups.size === 1 && groups.has(sub)) return whole;
    const lines = [];
    for (const [home, items] of [...groups].sort(([a], [b]) => (a === sub ? -1 : b === sub ? 1 : a.localeCompare(b)))) {
      const specifier = `@margoengine/react${home ? `/${home}` : ''}`;
      lines.push(`import ${typeOnly ?? ''}{ ${items.join(', ')} } from ${quote}${specifier}${quote};`);
    }
    return lines.join('\n');
  });
  // `export * from '@margoengine/react/kit'` and namespace imports of the kit: the kit is gone.
  for (const match of output.matchAll(/@margoengine\/react\/kit['"]/g))
    problems.push({
      line: lineOf(output, match.index),
      call: 'imports @margoengine/react/kit (removed): import each name from its subpath',
    });
  // preload(url): the component that loads the URL owns its preload.
  // Imported by a static import or a destructured `await import(...)` of a React entry.
  const imported = (name) =>
    new RegExp(`import[^;]*\\b${name}\\b[^;]*from\\s*['"]@margoengine\\/react`).test(output) ||
    new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*await\\s+import\\(\\s*['"]@margoengine\\/react`).test(output);
  output = output.replace(/(^|[^\w$.])preload\((\s*)(['"`])([^'"`]*)\3/gm, (whole, before, space, quote, url) => {
    const path = url.split(/[?#]/)[0].toLowerCase();
    const owner = /\.(hdr|exr|jpe?g)$/.test(path)
      ? 'Environment'
      : /\.fbx$/.test(path)
        ? 'Fbx'
        : /\.(glb|gltf)$/.test(path)
          ? 'Gltf'
          : null;
    if (!owner) return whole;
    return `${before}${owner}.preload(${space}${quote}${url}${quote}`;
  });
  if (/[^\w$.]preload\(/.test(output) && imported('preload'))
    problems.push({
      line: lineOf(output, output.search(/[^\w$.]preload\(/)),
      call: 'preload(url): use Gltf.preload, Fbx.preload or Environment.preload',
    });
  // Drop `preload` from the imports once every use moved to a component; any other use is listed for a hand rewrite.
  const uses = output
    .replace(/^import\s*\{[^}]*\}\s*from\s*['"]@margoengine\/react[^'"]*['"];?$/gm, '')
    .match(/(?<![\w$.'"`])preload(?![\w$])/g);
  if (uses && imported('preload'))
    problems.push({
      line: lineOf(output, output.search(/(?<![\w$.'"`])preload(?![\w$])/)),
      call: 'preload is used as a value: use Gltf.preload, Fbx.preload or Environment.preload',
    });
  else if (!uses)
    output = output.replace(
      /^(import\s*\{)([^}]*)(\}\s*from\s*['"]@margoengine\/react[^'"]*['"];?)$/gm,
      (whole, open, list, close) => {
        const items = list
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item && item !== 'preload');
        return items.length ===
          list
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean).length
          ? whole
          : items.length
            ? `${open} ${items.join(', ')} ${close}`
            : '';
      },
    );
  for (const owner of ['Gltf', 'Fbx', 'Environment'])
    if (new RegExp(`\\b${owner}\\.preload\\(`).test(output) && !imported(owner)) {
      const subpath = HOME.get(owner);
      const anchor = [...output.matchAll(/^import\s[^;]*?from\s+['"][^'"]+['"];?[^\S\n]*$/gm)].at(-1);
      if (!anchor) {
        problems.push({
          line: 1,
          call: `${owner}.preload needs import { ${owner} } from '@margoengine/react/${subpath}'`,
        });
        continue;
      }
      const at = anchor.index + anchor[0].length;
      output = `${output.slice(0, at)}\nimport { ${owner} } from '@margoengine/react/${subpath}';${output.slice(at)}`;
    }
  // Only in code that uses Margo's React bindings (a fence of R3F code beside it keeps its own <Canvas shadows>).
  if (/from\s*['"](?:@margoengine|margoengine)\/react/.test(output))
    for (const match of output.matchAll(/<(Canvas|MargoCanvas|Stage)\b[^>]*\sshadows\b/g))
      problems.push({
        line: lineOf(output, match.index),
        call: `<${match[1]} shadows>: render <Shadows /> from @margoengine/react/shadows inside the Canvas`,
      });
  return { text: output, problems };
}

/** Rewrites the code fences of a Markdown file. */
export function rewriteMarkdown(text) {
  const problems = [];
  const output = text.replace(/^(```|~~~)(\w*)[^\n]*\n([\s\S]*?)^\1[^\S\n]*$/gm, (block, fence, language, body) => {
    if (!/^(js|javascript|ts|typescript|jsx|tsx|mjs)?$/.test(language)) return block;
    const start = text.indexOf(block);
    const result = rewriteCode(body);
    for (const problem of result.problems)
      problems.push({ line: lineOf(text, start) + problem.line, call: problem.call });
    return block.replace(body, () => result.text);
  });
  return { text: output, problems };
}

function files(paths) {
  const listed = paths.length
    ? paths
    : execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  return listed
    .map((file) => file.replace(/\\/g, '/'))
    .filter(
      (file) =>
        ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.md'].includes(extname(file)) && !SKIP.some((re) => re.test(file)),
    );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const check = process.argv.includes('--check'),
    paths = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  let changed = 0,
    unresolved = 0;
  for (const file of files(paths)) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!source.includes('@margoengine/react')) continue;
    const crlf = source.includes('\r\n'),
      text = crlf ? source.replace(/\r\n/g, '\n') : source;
    const result = extname(file) === '.md' ? rewriteMarkdown(text) : rewriteCode(text);
    for (const problem of result.problems) {
      unresolved++;
      console.log(`${file}:${problem.line}: rewrite by hand: ${problem.call}`);
    }
    if (result.text !== text) {
      changed++;
      if (check) console.log(`${file}: would change`);
      else writeFileSync(file, crlf ? result.text.replace(/\n/g, '\r\n') : result.text);
    }
  }
  console.log(`${changed} file(s) ${check ? 'to change' : 'changed'}, ${unresolved} place(s) to rewrite by hand`);
  process.exit(unresolved || (check && changed) ? 1 : 0);
}

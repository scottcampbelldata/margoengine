// GPU-only frame-graph work must refuse the small preview during setup, so /auto can escalate.
// Parse executable syntax, not comments or WGSL strings. Reviewed preview routes name their regression evidence.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseAst } from 'rolldown/parseAst';

const root = resolve(import.meta.dirname, '..');
export const previewRoutes = {
  'packages/environment/src/output.ts:ColorOutput': [3, 'packages/environment/tests/output.test.js'],
  'packages/html/src/blend.ts:HTMLBlend': [1, 'packages/html/test/html-browser.js'],
  'packages/html/src/index.ts:HTML': [1, 'packages/html/test/html.test.js'],
  'packages/html/src/texture-gl.ts:HTMLTextureGL': [1, 'packages/html/test/html-browser.js'],
  'packages/html/src/texture.ts:HTMLTexture': [1, 'packages/html/test/html-browser.js'],
  'packages/inspector/src/gl.ts:GLInspector': [3, 'packages/inspector/test/gl-browser.mjs'],
  'packages/inspector/src/index.ts:Inspector': [5, 'packages/inspector/test/inspector.test.js'],
  'packages/labels/src/gpu.ts:GPULabelLayer': [1, 'packages/labels/tests/gpu-browser.js'],
  'packages/lod/src/index.ts:LODSystem': [1, 'packages/lod/test/preview.test.js'],
  'packages/sciviz/src/render.ts:SciRenderer': [1, 'packages/sciviz/tests/webgl2.test.js'],
  'packages/selection/src/picking.ts:Picking': [2, 'packages/webgl2-compat/test/preview-browser-check.mjs'],
  'packages/stats/src/index.ts:Stats': [2, 'packages/stats/test/stats.test.js'],
  'packages/stats/src/phases.ts:FramePhases': [1, 'packages/stats/test/phases.test.js'],
  'packages/ui/src/renderer.ts:UiRenderer': [2, 'packages/ui/tests/webgl2.test.js'],
};

const children = (node) =>
  Object.values(node).flatMap((v) => (Array.isArray(v) ? v.filter((n) => n?.type) : v?.type ? [v] : []));
const nodes = (node) => [node, ...children(node).flatMap(nodes)];
const key = (node) => node?.key?.name ?? node?.key?.value;
const literal = (node, value) => node?.type === 'Literal' && node.value === value;
const backendTest = (node) =>
  node.type === 'BinaryExpression' &&
  [node.left, node.right].some((n) => n?.type === 'MemberExpression' && n.property?.name === 'backend') &&
  [node.left, node.right].some((n) => literal(n, 'webgpu') || literal(n, 'webgl2'));

// A GPU alias is resolved only from setup's parameters/locals, never from unrelated method text.
function refusal(method, imports) {
  const all = nodes(method),
    gpu = new Set(['gpu']);
  for (const n of all) {
    if (
      (n.type === 'VariableDeclarator' || n.type === 'AssignmentPattern') &&
      nodes(n.init ?? n.right ?? {}).some((v) => v.type === 'MemberExpression' && v.property?.name === 'gpu')
    )
      gpu.add((n.id ?? n.left)?.name);
  }
  const unknown = Symbol('unknown');
  const value = (n) => {
    if (!n) return unknown;
    if (n.type === 'Literal') return n.value;
    if (n.type === 'Identifier' && gpu.has(n.name)) return null;
    if (n.type === 'MemberExpression') {
      if (n.property?.name === 'gpu') return null;
      if (n.property?.name === 'backend') return 'webgl2';
      if (n.object.type === 'ThisExpression' && /^(disposed|dead)$/.test(n.property?.name ?? '')) return false;
    }
    if (n.type === 'UnaryExpression' && n.operator === '!') {
      const v = value(n.argument);
      return v === unknown ? unknown : !v;
    }
    if (n.type === 'LogicalExpression') {
      const a = value(n.left),
        b = value(n.right);
      if (n.operator === '||')
        return a === true || b === true ? true : a === unknown || b === unknown ? unknown : a || b;
      if (n.operator === '&&')
        return a === false || b === false ? false : a === unknown || b === unknown ? unknown : a && b;
    }
    if (n.type === 'BinaryExpression') {
      const a = value(n.left),
        b = value(n.right);
      if (a === unknown || b === unknown) return unknown;
      if (['===', '=='].includes(n.operator)) return a === b;
      if (['!==', '!='].includes(n.operator)) return a !== b;
    }
    return unknown;
  };
  const unsupported = (node) =>
    nodes(node).some(
      (n) =>
        n.type === 'ThrowStatement' &&
        ['MargoError', 'margoError', 'fault'].includes(n.argument?.callee?.name) &&
        nodes(n.argument.arguments[0] ?? {}).some((v) => literal(v, 'unsupported')) &&
        (n.argument.callee.name === 'fault' ||
          nodes(n.argument.arguments[1] ?? {}).some(
            (v) =>
              (v.type === 'Literal' && typeof v.value === 'string' && v.value.includes('https://margoengine.com/')) ||
              (v.type === 'TemplateElement' && v.value.raw.includes('https://margoengine.com/')),
          )),
    );
  const body = method.value?.body ?? method.body;
  const scan = (statement) => {
    if (!statement) return undefined;
    if (statement.type === 'BlockStatement') {
      for (const s of statement.body) {
        const result = scan(s);
        if (result !== undefined) return result;
      }
    } else if (statement.type === 'ExpressionStatement') {
      if (statement.expression.type === 'CallExpression' && imports.has(statement.expression.callee?.name)) return true;
    } else if (statement.type === 'ReturnStatement') return false;
    else if (statement.type === 'ThrowStatement') return unsupported(statement) ? true : undefined;
    else if (statement.type === 'IfStatement') {
      const condition = value(statement.test);
      if (condition !== unknown) return scan(condition ? statement.consequent : statement.alternate);
      // Unknown option/state branches cannot establish a backend refusal. An early return can bypass a later guard.
      if (scan(statement.consequent) === false || scan(statement.alternate) === false) return false;
    }
    return undefined;
  };
  return scan(body) === true;
}

/** Returns every owner with backend-gated passes and no setup refusal or tested preview route. */
export function inspectPreviewContract(source, file, routes = previewRoutes) {
  const ast = parseAst(source, { lang: file.endsWith('.tsx') ? 'tsx' : file.endsWith('.ts') ? 'ts' : 'js' });
  const imported = new Set(
    ast.body
      .filter((n) => n.type === 'ImportDeclaration' && /\/require-webgpu\.js$/.test(n.source.value))
      .flatMap((n) => n.specifiers.filter((s) => s.imported?.name === 'requireWebGPU').map((s) => s.local.name)),
  );
  const failures = [],
    owners = [];
  const walk = (node, ancestors = []) => {
    if (node.type === 'ClassDeclaration' || node.type === 'ObjectExpression') {
      const members = node.body?.body ?? node.properties;
      const passes = members.find((m) => key(m) === 'registerPasses');
      if (passes && nodes(node).some(backendTest)) {
        const name = node.id?.name ?? `object@${source.slice(0, node.start).split('\n').length}`;
        const id = `${file}:${name}`;
        const privateConstructor = members.some((m) => key(m) === 'constructor' && m.accessibility === 'private');
        const methods = members.filter(
          (m) => key(m) === 'setup' || key(m) === 'constructor' || (m.static && privateConstructor),
        );
        // A private object plugin can be installed inside a function which refuses first (shared scene depth).
        const enclosing = ancestors.filter((n) => /Function/.test(n.type));
        const backendTests = nodes(node).filter(backendTest).length;
        const accepted =
          methods.some((m) => refusal(m, imported)) ||
          enclosing.some((m) => refusal(m, imported)) ||
          routes[id]?.[0] === backendTests;
        owners.push({ id, accepted, backendTests });
        if (!accepted)
          failures.push(
            `${id}: GPU-only passes can silently skip the preview; call requireWebGPU in setup, or supply a tested preview route`,
          );
      }
    }
    // Standalone registration functions are held to the same rule as class/object plugins.
    if (
      node.type === 'CallExpression' &&
      node.callee?.property?.name === 'add' &&
      node.arguments[0]?.type === 'ObjectExpression' &&
      node.arguments[0].properties.some((p) => key(p) === 'execute' && nodes(p).some(backendTest)) &&
      !ancestors.some(
        (n) =>
          (n.type === 'ClassDeclaration' || n.type === 'ObjectExpression') &&
          (n.body?.body ?? n.properties).some((m) => key(m) === 'registerPasses'),
      )
    ) {
      const fn = ancestors.findLast((n) => /Function/.test(n.type));
      const id = `${file}:${fn?.id?.name ?? 'pass'}@${source.slice(0, node.start).split('\n').length}`;
      const accepted = !!fn && refusal(fn, imported);
      owners.push({ id, accepted });
      if (!accepted) failures.push(`${id}: backend-gated standalone pass needs an attach-time unsupported refusal`);
    }
    for (const child of children(node)) walk(child, [...ancestors, node]);
  };
  walk(ast);
  return { failures, owners };
}

/** Checks package sources, including shared helpers; the umbrella holds generated re-exports. */
export function checkPreviewContract(at = root) {
  const failures = [],
    owners = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(at, dir), { withFileTypes: true })) {
      const file = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(file);
      else if (/\.[jt]sx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
        const result = inspectPreviewContract(readFileSync(join(at, file), 'utf8'), file);
        failures.push(...result.failures);
        owners.push(...result.owners);
      }
    }
  };
  for (const e of readdirSync(join(at, 'packages'), { withFileTypes: true })) {
    if (!e.isDirectory() || ['core', 'margoengine'].includes(e.name)) continue;
    const dir = `packages/${e.name}${e.name === 'shared' ? '' : '/src'}`;
    if (existsSync(join(at, dir))) walk(dir);
  }
  for (const [owner, [, evidence]] of Object.entries(previewRoutes))
    if (!existsSync(join(at, evidence))) failures.push(`${owner}: missing preview regression evidence ${evidence}`);
  return { failures, owners };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { failures, owners } = checkPreviewContract();
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else
    console.log(`Preview contract: ${owners.length} pass owners refuse during setup or have a tested preview route`);
}

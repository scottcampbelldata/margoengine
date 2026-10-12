import assert from 'node:assert/strict';
import {parseSync} from 'rolldown/utils';

// Explicit allowlists keep new members and external instrumentation out of property renaming.
const reviewed = {
  Camera: 'fit view projection',
  CADCameraControls: 'pointer velocity previousTouchAction menu down move up wheel',
  VectorRef: 'mesh kind get validate write',
  Engine: 'batches checkedMaterials materialFrame free next revision callbacks raf last frameOptions disposing watchDevice collect frame update',
  TransformStore: 'handle api',
  FrameGraph: 'passes owner executing',
  GPURenderer: 'frame targets views resolveTarget preserveMSAA passDescriptor passContext drawBatches commands draw bindings width height frameId lost deviceLost resources variants groups uniform bindGroup disposed picking canvas device context format pipeline descriptor renderFrame',
  GLRenderer: 'gl program camera eye light radiance resources canvas',
  Stage: 'imports',
};

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) if (key !== 'comments') {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

function parse(filename, code) {
  const result = parseSync(filename, code);
  assert.equal(result.errors.length, 0, `Cannot compact ${filename}`);
  return result.program;
}

function walkThis(node, visit) {
  if (!node || typeof node !== 'object' || ['ClassDeclaration', 'ClassExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(node.type)) return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walkThis(child, visit));
    else if (value && typeof value === 'object') walkThis(value, visit);
  }
}
const body = member => member.type === 'MethodDefinition' ? member.value.body : member.value;

export function compactInternals(source, javascript) {
  const classes = new Map(), edits = new Map();
  walk(parse('source.ts', source), node => {
    if (node.type !== 'ClassDeclaration' || !reviewed[node.id?.name]) return;
    assert.equal(node.superClass, null, 'Review inherited members before compacting');
    const names = reviewed[node.id.name].split(' '), privateNames = new Set(), frequency = new Map(names.map(name => [name, 0]));
    for (const member of node.body.body) {
      if (member.accessibility === 'private' && member.kind !== 'constructor') privateNames.add(member.key?.name);
      if (member.kind === 'constructor') for (const parameter of member.value.params) {
        if (parameter.type === 'TSParameterProperty' && parameter.accessibility === 'private') privateNames.add(parameter.parameter.name);
      }
    }
    for (const name of names) assert.ok(privateNames.has(name), `Review ${node.id.name}.${name} before compacting`);
    for (const member of node.body.body) walkThis(body(member), child => {
      if (child.type === 'MemberExpression' && child.object.type === 'ThisExpression' && !child.computed && frequency.has(child.property.name)) frequency.set(child.property.name, frequency.get(child.property.name) + 1);
    });
    names.sort((a, b) => frequency.get(b) - frequency.get(a) || a.localeCompare(b));
    const mapping = new Map(names.map((name, index) => [name, String.fromCharCode(97 + index % 26) + (index >= 26 ? Math.floor(index / 26) : '')]));
    classes.set(node.id.name, mapping);
  });
  walk(parse('output.js', javascript), node => {
    if (node.type !== 'ClassDeclaration' || !classes.has(node.id?.name)) return;
    const mapping = classes.get(node.id.name), existing = new Set(node.body.body.map(member => member.key?.name));
    for (const name of mapping.values()) assert.ok(!existing.has(name), `Internal alias ${name} collides with a member`);
    for (const member of node.body.body) if (mapping.has(member.key?.name)) edits.set(member.key.start, {end: member.key.end, text: mapping.get(member.key.name)});
    for (const member of node.body.body) walkThis(body(member), child => {
      if (child.type !== 'MemberExpression' || child.object.type !== 'ThisExpression') return;
      if (child.computed) assert.ok(!mapping.has(child.property.value), 'Review computed private access before compacting');
      else if (mapping.has(child.property.name)) edits.set(child.property.start, {end: child.property.end, text: mapping.get(child.property.name)});
    });
  });
  for (const [start, edit] of [...edits].sort((a, b) => b[0] - a[0])) javascript = javascript.slice(0, start) + edit.text + javascript.slice(edit.end);
  return javascript;
}

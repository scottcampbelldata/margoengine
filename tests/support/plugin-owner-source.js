import { parseSync } from 'rolldown/utils';
export function missing(source, required = ['EnginePlugin']) {
  const { program } = parseSync('owner.ts', source),
    problems = [];
  let checked = 0;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'ClassDeclaration' &&
      required.every((name) => node.implements?.some((i) => i.expression?.name === name))
    ) {
      checked++;
      const dispose = node.body.body.find((m) => m.key?.name === 'dispose');
      const body = dispose && source.slice(dispose.start, dispose.end);
      if (!body || !/\.sceneOf\(this\)/.test(body) || /\b(?:engine|runtime|owner)\??\.removePlugin\(/.test(body))
        problems.push(node.id.name);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) visit(child);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(program);
  return { checked, problems };
}

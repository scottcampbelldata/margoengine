import { MAX_TREE_DEPTH, MAX_TREE_NODES, type HandlerNames, type TreeDocument } from './spec.js';
import { type SubtreeDocument, type SubtreeRegistry, type SubtreeSpec, validateTree } from './subtrees.js';

/** External registrations and optional handler-name checking for text trees. */
export interface TreeTextOptions {
  subtrees?: SubtreeRegistry;
  handlers?: HandlerNames;
}
/** Maximum text size in UTF-16 code units, enforced before scanning. */
export const MAX_TREE_TEXT_LENGTH = 8 * 1024 * 1024;
const composites = new Set(['sequence', 'selector', 'parallel', 'randomSelector']);
const decorators = new Set(['inverter', 'repeater', 'cooldown', 'timeout', 'guard']);

class Reader {
  at = 0;
  nodes = 0;
  constructor(readonly text: string) {}
  fail(message: string): never {
    const before = this.text.slice(0, this.at),
      lines = before.split('\n');
    throw new TypeError(
      `Tree text ${lines.length}:${lines.at(-1)!.length + 1}: ${message}; correct the text at this location`,
    );
  }
  skip(): void {
    for (;;) {
      while (/\s/.test(this.text[this.at] ?? '') && this.at < this.text.length) this.at++;
      if (this.text.startsWith('//', this.at) || this.text[this.at] === '#') {
        const end = this.text.indexOf('\n', this.at);
        this.at = end < 0 ? this.text.length : end + 1;
      } else if (this.text.startsWith('/*', this.at)) {
        const end = this.text.indexOf('*/', this.at + 2);
        if (end < 0) this.fail('unclosed comment');
        this.at = end + 2;
      } else return;
    }
  }
  take(token: string): boolean {
    this.skip();
    if (!this.text.startsWith(token, this.at)) return false;
    this.at += token.length;
    return true;
  }
  need(token: string): void {
    if (!this.take(token)) this.fail(`expected '${token}'`);
  }
  name(): string {
    this.skip();
    const found = /^[A-Za-z_][A-Za-z_0-9]*/.exec(this.text.slice(this.at));
    if (!found) this.fail('expected a node or attribute name');
    this.at += found[0].length;
    return found[0];
  }
  value(depth = 0): unknown {
    this.skip();
    if (depth > MAX_TREE_DEPTH) this.fail('attribute array nesting is too deep');
    if (this.take('[')) {
      const result: unknown[] = [];
      if (this.take(']')) return result;
      do {
        result.push(this.value(depth + 1));
      } while (this.take(','));
      this.need(']');
      return result;
    }
    const start = this.at;
    if (this.text[this.at] === '"') {
      this.at++;
      while (this.at < this.text.length) {
        const character = this.text[this.at++];
        if (character === '\\') this.at++;
        else if (character === '"') {
          try {
            return JSON.parse(this.text.slice(start, this.at));
          } catch {
            this.fail('invalid JSON string escape or control character');
          }
        }
      }
      this.fail('unclosed quoted string');
    }
    const found = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(this.text.slice(this.at));
    if (!found) this.fail('expected a JSON string, finite number, boolean or array');
    this.at += found[0].length;
    const result: unknown = JSON.parse(found[0]);
    if (typeof result === 'number' && !Number.isFinite(result)) this.fail('number exceeds the finite numeric range');
    return result;
  }
  node(depth: number): Record<string, unknown> {
    if (depth > MAX_TREE_DEPTH) this.fail(`tree exceeds ${MAX_TREE_DEPTH} levels`);
    if (++this.nodes > MAX_TREE_NODES) this.fail(`tree exceeds ${MAX_TREE_NODES} nodes`);
    const type = this.name(),
      attrs: Record<string, unknown> = Object.create(null);
    if (this.take('(')) {
      if (!this.take(')')) {
        do {
          const key = this.name();
          if (Object.hasOwn(attrs, key)) this.fail(`duplicate attribute '${key}'`);
          if (['type', 'children', 'child', 'options', '__proto__', 'constructor', 'prototype'].includes(key))
            this.fail(`attribute '${key}' must use the node body`);
          this.need('=');
          attrs[key] = this.value();
        } while (this.take(','));
        this.need(')');
      }
    }
    const result: Record<string, unknown> = { type, ...attrs };
    if (this.take('{')) {
      const children: Record<string, unknown>[] = [];
      while (!this.take('}')) {
        if (this.at >= this.text.length) this.fail('unclosed node body');
        children.push(this.node(depth + 1));
      }
      if (composites.has(type)) result.children = children;
      else if (type === 'utility') {
        result.options = children.map((child) => {
          if (child.type !== 'option' || Object.keys(child).some((key) => !['type', 'score', 'child'].includes(key)))
            this.fail('utility body needs option(score="name") nodes with one child');
          return { score: child.score, child: child.child };
        });
      } else if (decorators.has(type) || type === 'option') {
        if (children.length !== 1) this.fail(`${type} needs exactly one child`);
        result.child = children[0];
      } else this.fail(`${type} is a leaf and cannot have a body`);
    }
    return result;
  }
}
function validate(document: unknown, options: TreeTextOptions): void {
  const issues = validateTree(document, options.subtrees, options.handlers);
  if (issues.length) throw new TypeError(`Invalid tree text document; fix ${issues[0].path}: ${issues[0].message}`);
}
/** Parse the compact tree syntax to a JSON document, checking every ordinary node and named reference.
 * Node syntax is type(key=JSON, ...) with an optional { child nodes } body. An optional tree { root } wraps it.
 * @throws TypeError for malformed syntax, unknown names or invalid nodes; correct the reported line/path.
 */
export function parseTreeText(text: string, options: TreeTextOptions & { subtrees: SubtreeRegistry }): SubtreeDocument;
/** Parse an ordinary tree without named registrations. */
export function parseTreeText(
  text: string,
  options?: Omit<TreeTextOptions, 'subtrees'> & { subtrees?: undefined },
): TreeDocument;
/** Options that may contain registrations preserve the possibility of unresolved subtree references. */
export function parseTreeText(text: string, options?: TreeTextOptions): SubtreeDocument;
export function parseTreeText(text: string, options: TreeTextOptions = {}): SubtreeDocument {
  if (typeof text !== 'string' || text.length > MAX_TREE_TEXT_LENGTH)
    throw new TypeError('Tree text must be a string of at most 8388608 code units; split the document');
  const reader = new Reader(text);
  reader.skip();
  const wrapped = /^tree\b/.test(text.slice(reader.at));
  if (wrapped) {
    reader.name();
    reader.need('{');
  }
  const root = reader.node(0);
  if (wrapped) reader.need('}');
  reader.skip();
  if (reader.at !== text.length) reader.fail('unexpected trailing text; use exactly one root');
  const document = { format: 'margo-behavior', version: 1, root };
  validate(document, options);
  return document as unknown as SubtreeDocument;
}
/** Print canonical, readable text while preserving optional fields, child order, labels and references.
 * @throws TypeError for invalid descriptions or unresolved references; fix the reported path or supply registrations.
 */
export function printTreeText(input: SubtreeSpec | SubtreeDocument, options: TreeTextOptions = {}): string {
  const document = 'format' in input ? input : { format: 'margo-behavior', version: 1, root: input };
  validate(document, options);
  const lines = ['tree {'];
  const write = (node: Record<string, unknown>, depth: number): void => {
    const type = node.type as string;
    const fields = Object.keys(node)
      .filter((key) => !['type', 'children', 'child', 'options'].includes(key) && node[key] !== undefined)
      .sort();
    const head = `${'  '.repeat(depth)}${type}${fields.length ? `(${fields.map((key) => `${key}=${JSON.stringify(node[key])}`).join(', ')})` : ''}`;
    const children =
      (node.children as Record<string, unknown>[] | undefined) ??
      (node.child
        ? [node.child as Record<string, unknown>]
        : node.options
          ? (node.options as { score: string; child: SubtreeSpec }[]).map((option) => ({ type: 'option', ...option }))
          : null);
    if (children) {
      lines.push(head + ' {');
      for (const child of children) write(child, depth + 1);
      lines.push(`${'  '.repeat(depth)}}`);
    } else lines.push(head);
  };
  write(document.root as unknown as Record<string, unknown>, 1);
  lines.push('}');
  return lines.join('\n');
}

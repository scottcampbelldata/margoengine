import { LoaderError } from './types.js';

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(value: string, format: string): string {
  if (value.indexOf('&') < 0) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (match, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!(code >= 0 && code <= 0x10ffff))
        throw new LoaderError(format, 'syntax', `invalid character reference ${match}`);
      return String.fromCodePoint(code);
    }
    const entity = ENTITIES[name];
    if (entity === undefined) throw new LoaderError(format, 'syntax', `unknown entity ${match}`);
    return entity;
  });
}

const ATTRIBUTE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export interface XMLHandler {
  /** Element names are local names (namespace prefix removed). */
  open(name: string, attributes: Record<string, string>): void;
  close(name: string): void;
  text?(text: string): void;
}

/**
 * Minimal non-validating streaming XML reader. Skips comments, processing instructions, CDATA and DOCTYPE
 * (entities are never expanded beyond the five predefined ones), and checks that tags nest correctly.
 */
export function readXML(xml: string, handler: XMLHandler, format = 'XML', maxDepth = 256): void {
  const stack: string[] = [];
  let pos = 0;
  const length = xml.length;
  while (pos < length) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) {
      if (stack.length && handler.text) handler.text(decode(xml.slice(pos), format));
      break;
    }
    if (lt > pos && stack.length && handler.text) handler.text(decode(xml.slice(pos, lt), format));
    const next = xml.charCodeAt(lt + 1);
    if (next === 33 /* ! */) {
      const terminator = xml.startsWith('<!--', lt) ? '-->' : xml.startsWith('<![CDATA[', lt) ? ']]>' : '>';
      const end = xml.indexOf(terminator, lt + 2);
      if (end < 0) throw new LoaderError(format, 'truncated', 'unterminated comment, CDATA or declaration');
      if (terminator === ']]>' && stack.length && handler.text) handler.text(xml.slice(lt + 9, end));
      pos = end + terminator.length;
      continue;
    }
    if (next === 63 /* ? */) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) throw new LoaderError(format, 'truncated', 'unterminated processing instruction');
      pos = end + 2;
      continue;
    }
    // Find the closing '>' outside quoted attribute values.
    let end = lt + 1,
      quote = 0;
    for (; end < length; end++) {
      const code = xml.charCodeAt(end);
      if (quote) {
        if (code === quote) quote = 0;
      } else if (code === 34 || code === 39) quote = code;
      else if (code === 62) break;
    }
    if (end >= length) throw new LoaderError(format, 'truncated', 'unterminated tag');
    const body = xml.slice(lt + 1, end);
    pos = end + 1;
    if (body[0] === '/') {
      const name = local(body.slice(1).trim());
      const open = stack.pop();
      if (open !== name)
        throw new LoaderError(format, 'syntax', `closing tag </${name}> does not match <${open ?? 'nothing'}>`);
      handler.close(name);
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameEnd = inner.search(/[\s]/);
    const raw = nameEnd < 0 ? inner : inner.slice(0, nameEnd);
    if (!raw) throw new LoaderError(format, 'syntax', 'empty tag name');
    const name = local(raw);
    const attributes: Record<string, string> = {};
    if (nameEnd >= 0) {
      ATTRIBUTE.lastIndex = 0;
      const rest = inner.slice(nameEnd);
      let match: RegExpExecArray | null;
      while ((match = ATTRIBUTE.exec(rest))) attributes[match[1]] = decode(match[2] ?? match[3], format);
    }
    if (stack.length >= maxDepth) throw new LoaderError(format, 'limit', `elements nest deeper than ${maxDepth}`);
    stack.push(name);
    handler.open(name, attributes);
    if (selfClosing) {
      stack.pop();
      handler.close(name);
    }
  }
  if (stack.length) throw new LoaderError(format, 'truncated', `document ends inside <${stack[stack.length - 1]}>`);
}

function local(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

/** Decodes XML bytes as UTF-8, or UTF-16 when a byte order mark says so. */
export function decodeXML(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

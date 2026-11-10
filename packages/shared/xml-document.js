// Strict reader for untrusted XML (SCXML machines, SVG figures): XML 1.0 well-formedness and Namespaces in XML 1.0,
// built into a small read-only tree. It never builds HTML and never creates nodes in a live document, so file text can
// only ever be data. Entities are limited to the five predefined ones and character references; a DTD internal subset
// is refused (no entity expansion, no external fetches).
// Clean-room basis: W3C, Extensible Markup Language (XML) 1.0, Fifth Edition (2008), sections 2.2 to 2.11, 3.1 and 4.1,
// https://www.w3.org/TR/xml/; W3C, Namespaces in XML 1.0, Third Edition (2009), sections 3 to 6,
// https://www.w3.org/TR/xml-names/.

const XML = 'http://www.w3.org/XML/1998/namespace';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const START =
  'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D\\u2070-\\u218F' +
  '\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NCNAME = `[${START}][${START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F\\u2040]*`;
const QNAME = new RegExp(`^${NCNAME}(?::${NCNAME})?$`, 'u');
const NAME = /[^\s/>=]+/y;
const SPACE = /[ \t\r\n]*/y;
const NOT_CHAR = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/u;
const PREDEFINED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

class XMLElement {
  constructor(tagName, prefix, localName, namespaceURI, attributes, parentElement, start) {
    this.nodeType = 1;
    this.tagName = tagName;
    this.prefix = prefix;
    this.localName = localName;
    this.namespaceURI = namespaceURI;
    this.attributes = attributes;
    this.parentElement = parentElement;
    this.childNodes = [];
    this.children = [];
    this.start = start;
    this.contentStart = -1;
    this.end = -1;
  }
  get textContent() {
    let text = '';
    const stack = [this];
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === 3 || node.nodeType === 4) text += node.data;
      else if (node.nodeType === 1) for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
    return text;
  }
  getAttribute(name) {
    for (const attribute of this.attributes) if (attribute.name === name) return attribute.value;
    return null;
  }
  getAttributeNS(namespaceURI, localName) {
    const ns = namespaceURI || null;
    for (const a of this.attributes) if (a.namespaceURI === ns && a.localName === localName) return a.value;
    return null;
  }
  hasAttribute(name) {
    return this.getAttribute(name) !== null;
  }
}

class XMLDocumentTree {
  constructor(documentElement) {
    this.documentElement = documentElement;
  }
  *#elements() {
    const stack = [this.documentElement];
    while (stack.length) {
      const element = stack.pop();
      yield element;
      for (let i = element.children.length - 1; i >= 0; i--) stack.push(element.children[i]);
    }
  }
  getElementById(id) {
    for (const element of this.#elements()) if (element.getAttributeNS(null, 'id') === id) return element;
    return null;
  }
  getElementsByTagNameNS(namespaceURI, localName) {
    const ns = namespaceURI || null;
    return [...this.#elements()].filter(
      (e) => (namespaceURI === '*' || e.namespaceURI === ns) && (localName === '*' || e.localName === localName),
    );
  }
}

/** Parse untrusted XML text into a read-only element tree; see xml-document.d.ts. */
export function parseXMLDocument(text, options = {}) {
  const maxDepth = options.maxDepth ?? 512,
    maxElements = options.maxElements ?? Infinity;
  const fail = (message, at) => {
    const line = text.slice(0, at).split('\n').length;
    const reason = `${message} (line ${line})`;
    if (options.fail) options.fail(reason);
    throw new TypeError(`Malformed XML: ${reason}; supply a well-formed XML 1.0 document`);
  };
  if (typeof text !== 'string') fail('input is not a string', 0);
  const bad = NOT_CHAR.exec(text);
  if (bad) fail(`character U+${bad[0].codePointAt(0).toString(16).toUpperCase()} is not allowed in XML`, bad.index);
  const decode = (raw, at) =>
    raw.indexOf('&') < 0
      ? raw
      : raw.replace(/&([^;&]*)(;?)/g, (match, name, semicolon) => {
          if (!semicolon) fail('unterminated entity or character reference', at);
          if (name[0] === '#') {
            const code = /^#x[0-9A-Fa-f]+$/.test(name)
              ? Number.parseInt(name.slice(2), 16)
              : /^#[0-9]+$/.test(name)
                ? Number.parseInt(name.slice(1), 10)
                : NaN;
            const char = code <= 0x10ffff ? String.fromCodePoint(code) : '';
            if (!char || NOT_CHAR.test(char) || (code >= 0xd800 && code <= 0xdfff))
              fail(`invalid character reference ${match}`, at);
            return char;
          }
          if (!Object.hasOwn(PREDEFINED, name)) fail(`undefined entity ${match}; only the five XML entities exist`, at);
          return PREDEFINED[name];
        });
  const space = (at) => {
    SPACE.lastIndex = at;
    SPACE.exec(text);
    return SPACE.lastIndex;
  };
  const qname = (at) => {
    NAME.lastIndex = at;
    const name = NAME.exec(text)?.[0] ?? '';
    if (!QNAME.test(name)) fail(`invalid element or attribute name "${name.slice(0, 40)}"`, at);
    return name;
  };
  // Prefix to namespace maps, chained per element; null-prototype so file prefixes such as __proto__ are plain keys.
  const top = Object.assign(Object.create(null), { xml: XML, '': null });
  const scopes = [top];
  const stack = [];
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0,
    root = null,
    doctype = false,
    count = 0;
  const parent = () => stack[stack.length - 1];
  const addText = (raw, at, type = 3) => {
    if (!stack.length) {
      if (type === 4 || /[^ \t\r\n]/.test(raw)) fail('text outside the root element', at);
      return;
    }
    if (type === 3 && raw.includes(']]>')) fail('"]]>" in text', at);
    const data = type === 3 ? decode(raw.replace(/\r\n?/g, '\n'), at) : raw.replace(/\r\n?/g, '\n');
    parent().childNodes.push({ nodeType: type, data, textContent: data });
  };
  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    if (lt < 0) {
      addText(text.slice(pos), pos);
      break;
    }
    if (lt > pos) addText(text.slice(pos, lt), pos);
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) fail('unterminated comment', lt);
      const data = text.slice(lt + 4, end);
      if (data.includes('--') || data.endsWith('-')) fail('"--" inside a comment', lt);
      if (stack.length) parent().childNodes.push({ nodeType: 8, data, textContent: data });
      pos = end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) fail('unterminated CDATA section', lt);
      addText(text.slice(lt + 9, end), lt, 4);
      pos = end + 3;
    } else if (text.startsWith('<!DOCTYPE', lt)) {
      if (doctype || root) fail('a document type declaration must come once, before the root element', lt);
      doctype = true;
      let end = lt + 9,
        quote = '';
      for (; end < text.length; end++) {
        const c = text[end];
        if (quote) quote = c === quote ? '' : quote;
        else if (c === '"' || c === "'") quote = c;
        else if (c === '[') fail('DTD internal subsets (entity declarations) are not supported', lt);
        else if (c === '>') break;
      }
      if (end >= text.length) fail('unterminated document type declaration', lt);
      pos = end + 1;
    } else if (text[lt + 1] === '?') {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) fail('unterminated processing instruction', lt);
      const body = text.slice(lt + 2, end),
        target = /^[^ \t\r\n]*/.exec(body)[0];
      if (!QNAME.test(target) || target.includes(':')) fail('invalid processing instruction target', lt);
      if (target.toLowerCase() === 'xml') {
        if (target !== 'xml' || lt !== (text.charCodeAt(0) === 0xfeff ? 1 : 0))
          fail('the XML declaration must start the document', lt);
      } else if (stack.length) {
        const data = body.slice(target.length).replace(/^[ \t\r\n]+/, '');
        parent().childNodes.push({ nodeType: 7, target, data, textContent: data });
      }
      pos = end + 2;
    } else if (text[lt + 1] === '/') {
      const name = qname(lt + 2),
        after = space(lt + 2 + name.length);
      if (text[after] !== '>') fail(`malformed end tag </${name}>`, lt);
      const open = stack.pop();
      if (!open || open.tagName !== name)
        fail(`end tag </${name}> does not match <${open ? open.tagName : 'nothing'}>`, lt);
      scopes.pop();
      open.end = after + 1;
      pos = after + 1;
    } else {
      if (root && !stack.length) fail('more than one root element', lt);
      const name = qname(lt + 1),
        raw = [];
      let at = lt + 1 + name.length,
        selfClosing = false;
      for (;;) {
        const next = space(at);
        if (text.startsWith('/>', next)) {
          selfClosing = true;
          at = next + 2;
          break;
        }
        if (text[next] === '>') {
          at = next + 1;
          break;
        }
        if (next >= text.length) fail(`unterminated start tag <${name}>`, lt);
        if (next === at) fail(`attributes of <${name}> need white space between them`, next);
        const attribute = qname(next);
        let i = space(next + attribute.length);
        if (text[i] !== '=') fail(`attribute ${attribute} has no value`, next);
        i = space(i + 1);
        const quote = text[i];
        if (quote !== '"' && quote !== "'") fail(`attribute ${attribute} value is not quoted`, i);
        const close = text.indexOf(quote, i + 1);
        if (close < 0) fail(`unterminated value of attribute ${attribute}`, i);
        const literal = text.slice(i + 1, close);
        if (literal.includes('<')) fail(`"<" in the value of attribute ${attribute}`, i);
        if (raw.some((a) => a.name === attribute)) fail(`duplicate attribute ${attribute}`, next);
        raw.push({ name: attribute, value: decode(literal.replace(/\r\n|[\r\n\t]/g, ' '), i) });
        at = close + 1;
      }
      const scope = Object.create(scopes[scopes.length - 1]);
      for (const { name: attribute, value } of raw) {
        if (attribute === 'xmlns') {
          if (value === XML || value === XMLNS) fail('the reserved XML namespaces cannot be the default', lt);
          scope[''] = value || null;
        } else if (attribute.startsWith('xmlns:')) {
          const prefix = attribute.slice(6);
          if (prefix === 'xmlns' || (prefix === 'xml') !== (value === XML) || value === XMLNS || !value)
            fail(`invalid namespace declaration ${attribute}`, lt);
          scope[prefix] = value;
        }
      }
      const resolve = (qualified, element) => {
        const colon = qualified.indexOf(':');
        if (colon < 0) return [null, qualified, element ? scope[''] : null];
        const prefix = qualified.slice(0, colon),
          ns = scope[prefix];
        if (!ns) fail(`namespace prefix ${prefix} is not declared`, lt);
        return [prefix, qualified.slice(colon + 1), ns];
      };
      const attributes = raw.map(({ name: attribute, value }) => {
        const [prefix, localName, namespaceURI] =
          attribute === 'xmlns'
            ? [null, 'xmlns', XMLNS]
            : attribute.startsWith('xmlns:')
              ? ['xmlns', attribute.slice(6), XMLNS]
              : resolve(attribute, false);
        return { name: attribute, prefix, localName, namespaceURI, value };
      });
      for (let i = 0; i < attributes.length; i++)
        for (let j = 0; j < i; j++)
          if (
            attributes[i].namespaceURI === attributes[j].namespaceURI &&
            attributes[i].localName === attributes[j].localName
          )
            fail(`attributes ${attributes[j].name} and ${attributes[i].name} are the same name`, lt);
      const [prefix, localName, namespaceURI] = resolve(name, true);
      if (++count > maxElements) fail(`more than ${maxElements} elements`, lt);
      if (stack.length >= maxDepth) fail(`elements nest deeper than ${maxDepth}`, lt);
      const element = new XMLElement(name, prefix, localName, namespaceURI, attributes, parent() ?? null, lt);
      element.contentStart = at;
      if (stack.length) {
        parent().childNodes.push(element);
        parent().children.push(element);
      } else root = element;
      if (selfClosing) element.end = at;
      else {
        stack.push(element);
        scopes.push(scope);
      }
      pos = at;
    }
  }
  if (stack.length) fail(`document ends inside <${parent().tagName}>`, text.length);
  if (!root) fail('no root element', text.length);
  return new XMLDocumentTree(root);
}

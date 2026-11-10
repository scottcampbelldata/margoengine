// One description of overlay vectors feeds both the exported SVG text and the live DOM, so file and app strings are
// escaped in the text and set through setAttribute and text nodes in the page, never parsed as markup.
import { typeError } from '../../shared/errors.js';
import { escapeXML } from '../../shared/xml-escape.js';

/** @internal An element: tag, attributes in output order and, unless it is empty (`<tag/>`), its content. */
export interface Markup {
  readonly tag: string;
  readonly attributes?: Readonly<Record<string, string | number>>;
  readonly children?: readonly (Markup | string)[];
}
const NAME = /^[A-Za-z][\w.:-]*$/;
const checkName = (name: string): string => {
  // Element and attribute names come from Margo code; refusing event handlers keeps a future slip from becoming script.
  if (!NAME.test(name) || /^on/i.test(name))
    throw typeError(`Markup name ${name} is unsafe; use an XML name that is not an event handler`, 'sciviz');
  return name;
};
/** @internal SVG or MathML text with every attribute value and text run escaped. */
export function markupText(nodes: readonly (Markup | string)[]): string {
  let out = '';
  for (const node of nodes) {
    if (typeof node === 'string') {
      out += escapeXML(node);
      continue;
    }
    out += `<${checkName(node.tag)}`;
    for (const [name, value] of Object.entries(node.attributes ?? {}))
      out += ` ${checkName(name)}="${escapeXML(String(value))}"`;
    out += node.children ? `>${markupText(node.children)}</${node.tag}>` : '/>';
  }
  return out;
}
/** @internal Replace `parent`'s children with live elements in `namespace`, built without parsing any markup. */
export function renderMarkup(parent: Element, namespace: string, nodes: readonly (Markup | string)[]): void {
  const document = parent.ownerDocument,
    build = (node: Markup | string): Node => {
      if (typeof node === 'string') return document.createTextNode(node);
      const element = document.createElementNS(namespace, checkName(node.tag));
      for (const [name, value] of Object.entries(node.attributes ?? {}))
        if (name !== 'xmlns') element.setAttribute(checkName(name), String(value));
      // An empty run adds no text node, as markup parsing would not.
      for (const child of node.children ?? []) if (child !== '') element.append(build(child));
      return element;
    };
  parent.replaceChildren(...nodes.map(build));
}

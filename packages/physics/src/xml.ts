// A small XML reader for the file formats the loaders read (Collada, URDF, MJCF): elements, attributes and text. Off the step path.

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/** A small XML reader: elements, attributes and text, with comments, the prolog and CDATA skipped. Enough for Collada, which is plain XML. */
export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' },
    stack = [root],
    token =
      /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (let m = token.exec(source); m; m = token.exec(source)) {
    const top = stack[stack.length - 1]!;
    if (m[6] !== undefined) top.text += m[6];
    else if (m[1] !== undefined) top.text += m[1];
    else if (m[3] !== undefined) {
      if (m[2]) {
        if (stack.length > 1) stack.pop();
      } else {
        const attrs: Record<string, string> = {};
        for (const a of (m[4] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
          attrs[a[1]!] = a[2] ?? a[3] ?? '';
        const node: XmlNode = { name: m[3], attrs, children: [], text: '' };
        top.children.push(node);
        if (!m[5]) stack.push(node);
      }
    }
  }
  return root;
}

export const child = (node: XmlNode, name: string): XmlNode | undefined => node.children.find((c) => c.name === name);
export const numbers = (text: string): number[] => text.trim().split(/\s+/).filter(Boolean).map(Number);
export const multiply = (a: number[], b: number[]): number[] => {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) out[r * 4 + c]! += a[r * 4 + k]! * b[k * 4 + c]!;
  return out;
};

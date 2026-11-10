/** Text (3), CDATA (4), processing instruction (7) or comment (8) content of an element. */
export interface XMLLeaf {
  readonly nodeType: 3 | 4 | 7 | 8;
  readonly data: string;
  readonly textContent: string;
  /** Processing instructions only. */
  readonly target?: string;
}

/** One attribute, with its namespace resolved; `xmlns` declarations are in the XMLNS namespace. */
export interface XMLAttribute {
  readonly name: string;
  readonly prefix: string | null;
  readonly localName: string;
  readonly namespaceURI: string | null;
  readonly value: string;
}

/** A read-only element: a DOM-shaped subset, never connected to a live document. */
export interface XMLElement {
  readonly nodeType: 1;
  readonly tagName: string;
  readonly prefix: string | null;
  readonly localName: string;
  readonly namespaceURI: string | null;
  readonly attributes: readonly XMLAttribute[];
  readonly parentElement: XMLElement | null;
  readonly childNodes: readonly (XMLElement | XMLLeaf)[];
  readonly children: readonly XMLElement[];
  /** Text and CDATA of every descendant, in document order. */
  readonly textContent: string;
  /** Source offsets: `start` at `<`, `contentStart` after the start tag, `end` after the end tag. */
  readonly start: number;
  readonly contentStart: number;
  readonly end: number;
  getAttribute(name: string): string | null;
  getAttributeNS(namespaceURI: string | null, localName: string): string | null;
  hasAttribute(name: string): boolean;
}

/** The parsed document. */
export interface XMLDocumentTree {
  readonly documentElement: XMLElement;
  getElementById(id: string): XMLElement | null;
  getElementsByTagNameNS(namespaceURI: string | null, localName: string): XMLElement[];
}

/** Limits and error reporting for parseXMLDocument. */
export interface XMLDocumentOptions {
  /** Deepest element nesting. Default 512. */
  maxDepth?: number;
  /** Most elements. Default unlimited. */
  maxElements?: number;
  /** Called with the reason instead of throwing the default TypeError; it must throw. */
  fail?: (reason: string) => never;
}

/**
 * Parse untrusted XML 1.0 with namespaces into a read-only tree. Refuses malformed input, DTD internal subsets and
 * entities other than the five predefined ones; never builds HTML or touches a live document.
 */
export function parseXMLDocument(text: string, options?: XMLDocumentOptions): XMLDocumentTree;

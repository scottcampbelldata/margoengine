// IFC class inheritance: the IfcObjectDefinition subtype tree of IFC4 and IFC4X3, read once on first use from the
// generated table (buildingSMART's published EXPRESS schemas, see schema-tree.ts). Class names compare without case.
// IFC2X3 and other schema names use the IFC4 tree: the IFC2X3 TC1 EXPRESS file reserves all rights, so nothing is
// derived from it. Classes IFC2X3 shares with IFC4 keep their IFC4 parents; an IFC2X3-only class (IfcElectricalElement,
// IfcEquipmentElement and the like) is outside the tree and matches only itself. Given an IFC2X3 model's data instead
// of a schema name, isSubtypeOf follows the inheritance readIFCData recorded from the open web-ifc runtime.
import { IFC4_TREE, IFC4X3_TREE } from './schema-tree.js';

interface Tree {
  /** Upper-case class name to its schema spelling and its parent (upper case). */
  classes: Map<string, { name: string; parent?: string; children: string[] }>;
}
const trees = new Map<string, Tree>();

function treeOf(schema: string): Tree {
  const s = schema.toUpperCase();
  const key = s.startsWith('IFC4X3') ? 'IFC4X3' : 'IFC4';
  let tree = trees.get(key);
  if (tree) return tree;
  const classes: Tree['classes'] = new Map([['IFCOBJECTDEFINITION', { name: 'IfcObjectDefinition', children: [] }]]);
  for (const group of (key === 'IFC4X3' ? IFC4X3_TREE : IFC4_TREE).split(' ')) {
    const [parent, list] = group.split(':') as [string, string];
    const up = `IFC${parent.toUpperCase()}`;
    for (const child of list.split(',')) {
      const name = `Ifc${child}`;
      classes.set(name.toUpperCase(), { name, parent: up, children: [] });
      classes.get(up)!.children.push(name.toUpperCase());
    }
  }
  trees.set(key, (tree = { classes }));
  return tree;
}

/** A model's schema name with, for IFC2X3 models, the inheritance readIFCData recorded (IFCData fits). */
export interface IFCSchemaSource {
  schema: string;
  inheritance?: ReadonlyMap<string, readonly string[]>;
}

/**
 * Whether `type` is `ancestor` or one of its subtypes in `schema` (`IFC4`, `IFC4X3...`; `IFC2X3` uses the IFC4 tree),
 * as the schema's SUBTYPE OF declarations chain. Names compare without case; a class outside the tree only matches
 * itself. Pass readIFCData's result instead of a name to follow an IFC2X3 model's own recorded inheritance, where
 * IFC2X3-only classes have their subtypes and IFC2X3 parents (for the classes present in that model).
 */
export function isSubtypeOf(schema: string | IFCSchemaSource, type: string, ancestor: string): boolean {
  const want = ancestor.toUpperCase();
  if (typeof schema !== 'string') {
    const recorded = schema.inheritance;
    if (recorded) {
      const t = type.toUpperCase();
      return t === want || (recorded.get(want)?.some((c) => c.toUpperCase() === t) ?? false);
    }
    schema = schema.schema;
  }
  const { classes } = treeOf(schema);
  for (let at: string | undefined = type.toUpperCase(); at !== undefined; at = classes.get(at)?.parent) if (at === want) return true;
  return false;
}

/** The supertypes of `type`, nearest first, up to IfcObjectDefinition; empty for a class outside that tree. */
export function supertypesOf(schema: string, type: string): string[] {
  const { classes } = treeOf(schema),
    out: string[] = [];
  for (let at = classes.get(type.toUpperCase())?.parent; at !== undefined; at = classes.get(at)?.parent) out.push(classes.get(at)!.name);
  return out;
}

/** Every subtype of `type` (not `type` itself), in the schema's spelling, breadth first; empty for a leaf. */
export function subtypesOf(schema: string, type: string): string[] {
  const { classes } = treeOf(schema),
    out: string[] = [],
    queue = [...(classes.get(type.toUpperCase())?.children ?? [])];
  while (queue.length) {
    const c = classes.get(queue.shift()!)!;
    out.push(c.name);
    queue.push(...c.children);
  }
  return out;
}

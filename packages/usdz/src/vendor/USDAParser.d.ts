// Internal adapter surface for the vendored parser; USD field values vary by schema.
export type Specs = Record<string, { specType: number; fields: Record<string, any> }>;

export class USDAParser {
  parseData(text: string): { specsByPath: Specs };
  _parseAttributeValue(type: string, value: unknown): any;
  _extractPrimData(
    data: any,
    path: string,
    fields: Record<string, any>,
    specs: Specs,
    types: Record<string, number>,
  ): void;
}

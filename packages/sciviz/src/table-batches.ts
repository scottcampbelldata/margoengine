// Shared materialization for whole-file readers; progressive readers keep batches separate.
import { ColumnarTable, type TableColumn, type TableValue } from './table.js';
import { scalarColumn } from './table-read.js';
/** @internal Preserve physical integer storage, dictionary labels, nulls and units across batches. */
export async function collectBatches(batches: AsyncIterable<ColumnarTable>): Promise<ColumnarTable> {
  const columns: Record<string, TableValue[]> = Object.create(null), layout: Record<string, TableColumn> = Object.create(null);
  for await (const table of batches) for (const [name, column] of Object.entries(table.columns)) {
    layout[name] = column;
    const values = columns[name] ?? (columns[name] = []);
    for (let i = 0; i < table.length; i++) values.push(table.value(name, i));
  }
  const result: Record<string, TableColumn> = Object.create(null);
  for (const [name, values] of Object.entries(columns)) {
    const col = layout[name];
    result[name] = scalarColumn(values, col.unit, col.values instanceof BigUint64Array ? 'u64' : col.values instanceof BigInt64Array ? 'i64' : undefined);
  }
  return new ColumnarTable(result);
}

import type { ReactNode } from 'react';

export interface TableColumn<Row> {
  /** Stable key for the column; also the React key for its cells. */
  id: string;
  header: ReactNode;
  /** Cell renderer -- returns the node for this column in the given row. */
  cell: (row: Row) => ReactNode;
  align?: 'left' | 'right';
  /** Tailwind width utility, e.g. `w-1/4`, applied to the header cell. */
  width?: string;
}

export interface TableProps<Row> {
  columns: TableColumn<Row>[];
  rows: Row[];
  /** Stable identity per row, used as the React key. */
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  /** Shown in place of the body when `rows` is empty. */
  emptyMessage?: ReactNode;
}

/**
 * Data table in the Stitch style: uppercase label-caps header on a raised
 * surface, hairline row dividers, and hover feedback on each row.
 *
 * The table scrolls horizontally inside its own container rather than
 * widening the page, which is what the design system prescribes for
 * complex tables on narrow viewports.
 */
export function Table<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyMessage,
}: TableProps<Row>) {
  return (
    <div className="bg-surface rounded-lg border border-outline-variant shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-surface-container-low border-b border-outline-variant">
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  className={[
                    'p-md font-label-caps text-label-caps uppercase tracking-wider',
                    'text-on-surface-variant font-semibold',
                    column.align === 'right' ? 'text-right' : '',
                    column.width ?? '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>

          <tbody className="divide-y divide-outline-variant font-body-sm text-body-sm text-on-surface">
            {rows.length === 0 ? (
              <tr>
                <td
                  className="p-xl text-center text-on-surface-variant"
                  colSpan={columns.length}
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={[
                    'transition-colors group hover:bg-surface-container-low',
                    onRowClick ? 'cursor-pointer' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={`p-md ${column.align === 'right' ? 'text-right' : ''}`}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

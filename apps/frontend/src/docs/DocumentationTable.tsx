import type { ReactNode } from 'react';
import { Table, type TableColumn } from '../components/ui';

export interface DocumentationTableColumn {
  id: string;
  header: ReactNode;
  width?: string;
}

export type DocumentationTableRow = { id: string } & Record<string, ReactNode>;

interface DocumentationTableProps {
  columns: DocumentationTableColumn[];
  rows: DocumentationTableRow[];
}

/** Renders MDX reference data with the product's accessible table primitive. */
export function DocumentationTable({ columns, rows }: DocumentationTableProps) {
  const tableColumns: TableColumn<DocumentationTableRow>[] = columns.map(
    ({ id, header, width }) => ({
      id,
      header,
      width,
      cell: (row) => row[id],
    }),
  );

  return (
    <Table
      columns={tableColumns}
      rows={rows}
      rowKey={(row) => row.id}
      emptyMessage="Không có dữ liệu để hiển thị."
    />
  );
}

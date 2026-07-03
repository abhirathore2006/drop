import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right";
}

export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Shown as a single muted row when there is no data. */
  empty: ReactNode;
}

/** Data table primitive — consistent styling for the admin views (sorting/pagination
 *  arrive with the M4 data-heavy views; keyset paging stays with the caller for now). */
export function Table<T>({ columns, rows, rowKey, empty }: TableProps<T>) {
  return (
    <table className="tbl">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} className={c.align === "right" ? "right" : undefined}>
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={rowKey(r)}>
            {columns.map((c) => (
              <td key={c.key} className={c.align === "right" ? "right" : undefined}>
                {c.render(r)}
              </td>
            ))}
          </tr>
        ))}
        {!rows.length && (
          <tr>
            <td colSpan={columns.length} className="muted">
              {empty}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

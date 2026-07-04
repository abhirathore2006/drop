import { useRef, useState, type ReactNode } from "react";
import { Button } from "./Button.tsx";

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right";
  /** Marks the header as sortable — renders a keyboard-operable sort button and an `aria-sort`
   *  state on the `<th>` (M5 a11y). Wire `sort`/`onSort` on the Table to drive it. */
  sortable?: boolean;
}

/** Keyset "load more" wiring for an unbounded, server-cursored list. `hasMore` comes from the query's
 *  `nextCursor`; `onLoadMore` fetches the next page (append). Omitted → the table is a fixed list. This is
 *  the M4 convention: server keyset paging surfaces through the shared Table, not per-page bespoke buttons. */
export interface LoadMore {
  hasMore: boolean;
  onLoadMore: () => void;
  loading?: boolean;
  label?: string;
}

export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Shown as a single muted row when there is no data. */
  empty: ReactNode;
  /** Server-keyset paging (M4): renders a "load more" control below the table. */
  loadMore?: LoadMore;
  /** Fixed row height (px) used by the windowing math once virtualization kicks in. */
  rowHeight?: number;
  /** Scroll-viewport height (px) when virtualizing a long list. */
  maxBodyHeight?: number;
  /** Virtualize (window) past this many rows; below it every row is a real DOM node (cheap). */
  virtualizeThreshold?: number;
  /** Current sort state (M5 a11y) — drives `aria-sort` and the header caret on `sortable` columns. */
  sort?: { key: string; dir: "asc" | "desc" };
  /** Called with a sortable column's key when its header is activated (click or Enter/Space). */
  onSort?: (key: string) => void;
  /** Accessible name for the table (`aria-label` on `<table>`), announced by screen readers. */
  label?: string;
}

const OVERSCAN = 8;

/** Data table primitive — consistent styling across the admin/data views. Adds two M4 capabilities on
 *  top of the plain table: (1) server-keyset "load more" (`loadMore`), and (2) row virtualization past
 *  `virtualizeThreshold` (default ~200) — a long list scrolls inside a fixed viewport rendering only the
 *  visible window plus spacers, so a 10k-row audit/events table stays a few hundred DOM nodes. Below the
 *  threshold the table is unchanged (no scroll container, every row rendered). */
export function Table<T>({ columns, rows, rowKey, empty, loadMore, rowHeight = 40, maxBodyHeight = 560, virtualizeThreshold = 200, sort, onSort, label }: TableProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(maxBodyHeight);

  const virtualize = rows.length > virtualizeThreshold;
  let start = 0;
  let end = rows.length;
  if (virtualize) {
    start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
    const visible = Math.ceil(viewportH / rowHeight) + OVERSCAN * 2;
    end = Math.min(rows.length, start + visible);
  }
  const padTop = start * rowHeight;
  const padBottom = (rows.length - end) * rowHeight;
  const windowed = virtualize ? rows.slice(start, end) : rows;

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setViewportH(el.clientHeight || maxBodyHeight);
  };

  const table = (
    <table className="tbl" aria-label={label}>
      <thead>
        <tr>
          {columns.map((c) => {
            const active = sort?.key === c.key;
            // aria-sort: only sortable headers advertise sortability; the active one carries direction.
            const ariaSort = c.sortable ? (active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none") : undefined;
            return (
              <th key={c.key} scope="col" aria-sort={ariaSort} className={c.align === "right" ? "right" : undefined}>
                {c.sortable && onSort ? (
                  <button type="button" className="tbl-sort" onClick={() => onSort(c.key)}>
                    {c.header}
                    <span aria-hidden="true" className="tbl-sort-caret">
                      {active ? (sort!.dir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </button>
                ) : (
                  c.header
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {virtualize && padTop > 0 && (
          <tr aria-hidden className="tbl-spacer" style={{ height: padTop }}>
            <td colSpan={columns.length} />
          </tr>
        )}
        {windowed.map((r) => (
          <tr key={rowKey(r)} style={virtualize ? { height: rowHeight } : undefined}>
            {columns.map((c) => (
              <td key={c.key} className={c.align === "right" ? "right" : undefined}>
                {c.render(r)}
              </td>
            ))}
          </tr>
        ))}
        {virtualize && padBottom > 0 && (
          <tr aria-hidden className="tbl-spacer" style={{ height: padBottom }}>
            <td colSpan={columns.length} />
          </tr>
        )}
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

  return (
    <>
      {virtualize ? (
        <div ref={scrollRef} className="tbl-scroll" style={{ maxHeight: maxBodyHeight }} onScroll={onScroll}>
          {table}
        </div>
      ) : (
        // Horizontal-scroll wrapper (M5 responsive): a wide table scrolls inside its own box on a
        // phone instead of forcing the whole page to scroll sideways.
        <div className="tbl-wrap">{table}</div>
      )}
      {loadMore?.hasMore && (
        <div className="tbl-more">
          <Button size="sm" loading={loadMore.loading} onClick={loadMore.onLoadMore}>
            {loadMore.label ?? "load more"}
          </Button>
        </div>
      )}
    </>
  );
}

// (M4) The shared Table's two new capabilities: server-keyset "load more" and row virtualization past
// the threshold. Plain rendering (below the threshold) stays a full DOM table.
import { setupDom } from "../test/setup.ts";
import { describe, expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { Table, type Column } from "./Table.tsx";

setupDom();

interface Row {
  id: string;
  n: number;
}
const columns: Column<Row>[] = [{ key: "n", header: "n", render: (r) => <span className="rrow">row-{r.n}</span> }];
const rows = (count: number): Row[] => Array.from({ length: count }, (_, i) => ({ id: String(i), n: i }));

describe("Table", () => {
  test("renders all rows and no scroll container below the virtualize threshold", () => {
    const r = render(<Table columns={columns} rows={rows(5)} rowKey={(x) => x.id} empty="none" />);
    expect(r.container.querySelectorAll(".rrow").length).toBe(5);
    expect(r.container.querySelector(".tbl-scroll")).toBeNull();
  });

  test("renders the empty row when there are no rows", () => {
    const r = render(<Table columns={columns} rows={[]} rowKey={(x) => x.id} empty="nothing here" />);
    expect(r.getByText("nothing here")).toBeTruthy();
  });

  test("virtualizes past the threshold — only a window of rows is in the DOM", () => {
    const r = render(<Table columns={columns} rows={rows(600)} rowKey={(x) => x.id} empty="none" virtualizeThreshold={200} rowHeight={40} maxBodyHeight={560} />);
    // a scroll container wraps the table
    expect(r.container.querySelector(".tbl-scroll")).toBeTruthy();
    // spacer rows stand in for the off-screen rows
    expect(r.container.querySelectorAll(".tbl-spacer").length).toBeGreaterThan(0);
    // far fewer than 600 rows are actually rendered (a windowed slice)
    const rendered = r.container.querySelectorAll(".rrow").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(200);
    // the window starts at the top (scrollTop 0)
    expect(r.getByText("row-0")).toBeTruthy();
  });

  test("load-more control appears only when hasMore, and fires onLoadMore", () => {
    let clicked = 0;
    const r = render(<Table columns={columns} rows={rows(3)} rowKey={(x) => x.id} empty="none" loadMore={{ hasMore: true, onLoadMore: () => (clicked += 1) }} />);
    const btn = r.getByRole("button", { name: "load more" });
    fireEvent.click(btn);
    expect(clicked).toBe(1);
  });

  test("no load-more control when hasMore is false", () => {
    const r = render(<Table columns={columns} rows={rows(3)} rowKey={(x) => x.id} empty="none" loadMore={{ hasMore: false, onLoadMore: () => {} }} />);
    expect(r.queryByRole("button", { name: "load more" })).toBeNull();
  });

  test("(M5 a11y) headers are scope=col; the table takes an accessible name", () => {
    const r = render(<Table columns={columns} rows={rows(2)} rowKey={(x) => x.id} empty="none" label="numbers" />);
    const th = r.container.querySelector("th");
    expect(th?.getAttribute("scope")).toBe("col");
    expect(r.container.querySelector("table")?.getAttribute("aria-label")).toBe("numbers");
  });

  test("(M5 a11y) a sortable header exposes aria-sort and a keyboard button that fires onSort", () => {
    const sortable: Column<Row>[] = [{ key: "n", header: "n", sortable: true, render: (x) => <span>{x.n}</span> }];
    let sorted = "";
    const r = render(
      <Table
        columns={sortable}
        rows={rows(3)}
        rowKey={(x) => x.id}
        empty="none"
        sort={{ key: "n", dir: "asc" }}
        onSort={(k) => (sorted = k)}
      />,
    );
    const th = r.container.querySelector("th");
    expect(th?.getAttribute("aria-sort")).toBe("ascending");
    const btn = r.getByRole("button");
    fireEvent.click(btn);
    expect(sorted).toBe("n");
  });

  test("(M5 a11y) non-sorted sortable columns advertise aria-sort=none", () => {
    const cols: Column<Row>[] = [
      { key: "n", header: "n", sortable: true, render: (x) => <span>{x.n}</span> },
      { key: "x", header: "x", sortable: true, render: () => <span>x</span> },
    ];
    const r = render(<Table columns={cols} rows={rows(2)} rowKey={(x) => x.id} empty="none" sort={{ key: "n", dir: "desc" }} onSort={() => {}} />);
    const ths = r.container.querySelectorAll("th");
    expect(ths[0]!.getAttribute("aria-sort")).toBe("descending");
    expect(ths[1]!.getAttribute("aria-sort")).toBe("none");
  });
});

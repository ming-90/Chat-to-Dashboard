import { mockData, type MockTableName } from "../data/mockData";
import { getTableDefinition } from "./metadata";
import type { RuntimeApiResponse } from "./types";

type RecordValue = string | number | boolean | null | undefined;
type CrudRecord = Record<string, RecordValue>;

export function handleCrudRequest(path: string): RuntimeApiResponse<CrudRecord> {
  const url = new URL(path, window.location.origin);
  const table = url.pathname.replace(/^\/api\//, "") as MockTableName;

  if (!isMockTable(table)) {
    throw new Error(`Unknown table: ${table}`);
  }

  const tableDefinition = getTableDefinition(table);
  const allowedFilters = new Set(tableDefinition?.columns.map((column) => column.name) ?? []);
  let rows = [...mockData[table]] as CrudRecord[];

  url.searchParams.forEach((value, key) => {
    if (key === "sort" || key === "page" || key === "pageSize") {
      return;
    }

    if (!allowedFilters.has(key)) {
      throw new Error(`Filter is not allowed for ${table}: ${key}`);
    }

    rows = rows.filter((row) => String(row[key]) === value);
  });

  rows = sortRows(rows, url.searchParams.get("sort"));
  rows = paginateRows(rows, url.searchParams.get("page"), url.searchParams.get("pageSize"));

  return {
    data: rows,
    meta: {
      table,
      total: rows.length,
      source: "mock-crud-api"
    }
  };
}

function isMockTable(table: string): table is MockTableName {
  return Object.prototype.hasOwnProperty.call(mockData, table);
}

function sortRows(rows: CrudRecord[], sort: string | null): CrudRecord[] {
  if (!sort) {
    return rows;
  }

  const [field, direction = "asc"] = sort.split(":");

  return [...rows].sort((left, right) => {
    const leftValue = left[field];
    const rightValue = right[field];

    if (leftValue === rightValue) {
      return 0;
    }

    const comparison = String(leftValue) > String(rightValue) ? 1 : -1;
    return direction === "desc" ? comparison * -1 : comparison;
  });
}

function paginateRows(rows: CrudRecord[], pageParam: string | null, pageSizeParam: string | null): CrudRecord[] {
  const page = Math.max(Number(pageParam ?? 1), 1);
  const pageSize = Math.max(Number(pageSizeParam ?? rows.length), 1);
  const start = (page - 1) * pageSize;

  return rows.slice(start, start + pageSize);
}

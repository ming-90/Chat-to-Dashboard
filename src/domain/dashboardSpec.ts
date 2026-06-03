export type DashboardWidgetType = "kpi" | "lineChart" | "barChart" | "pieChart" | "table";

export type DashboardWidgetSize = "small" | "medium" | "large";

export type DashboardTransformType = "join" | "deriveDateBucket" | "groupBy" | "sort" | "topN";

export type DashboardAggregate = "sum" | "avg" | "min" | "max" | "count" | "count_distinct";

export type DashboardFilterOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "between" | "like" | "isnull";

export interface DashboardFilter {
  field: string;
  op: DashboardFilterOp;
  value?: string | number | boolean;
  values?: Array<string | number>;
}

export interface DashboardDataSource {
  id: string;
  table: string;
  path: string;
  description?: string;
  filters?: DashboardFilter[];
}

export interface DashboardTransform {
  id: string;
  type: DashboardTransformType;
  source?: string;
  left?: string;
  right?: string;
  leftKey?: string;
  rightKey?: string;
  dateField?: string;
  grain?: "day" | "week" | "month" | "quarter" | "year";
  groupBy?: string[];
  metrics?: DashboardMetric[];
  sortBy?: string;
  direction?: "asc" | "desc";
  limit?: number;
}

export interface DashboardMetric {
  id: string;
  aggregate: DashboardAggregate;
  field?: string;
  label?: string;
}

export interface DashboardWidget {
  id: string;
  type: DashboardWidgetType;
  title: string;
  size: DashboardWidgetSize;
  source: string;
  description?: string;
  x?: string;
  y?: string;
  series?: string;
  labelField?: string;
  valueField?: string;
  columns?: string[];
  metric?: DashboardMetric;
  options?: Record<string, string | number | boolean>;
}

export interface DashboardSpec {
  version: 1;
  title: string;
  description?: string;
  dataSources: DashboardDataSource[];
  transforms: DashboardTransform[];
  widgets: DashboardWidget[];
}

export function appendDashboardFilter(params: URLSearchParams, filter: DashboardFilter): void {
  const paramKey = filter.op === "eq" ? filter.field : `${filter.field}__${filter.op}`;

  if (filter.op === "in") {
    params.set(paramKey, (filter.values ?? []).map(String).join(","));
    return;
  }

  if (filter.op === "between") {
    const [start, end] =
      filter.values && filter.values.length >= 2
        ? filter.values
        : [filter.value ?? "", ""];
    params.set(paramKey, `${start},${end}`);
    return;
  }

  if (filter.op === "isnull") {
    params.set(paramKey, String(filter.value ?? true));
    return;
  }

  params.set(paramKey, String(filter.value ?? ""));
}

export function buildDataSourceUrl(path: string, filters?: DashboardFilter[]): string {
  const queryIndex = path.indexOf("?");
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? "" : path.slice(queryIndex + 1));

  for (const filter of filters ?? []) {
    appendDashboardFilter(params, filter);
  }

  const serialized = params.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
}

export function getWidgetColumnSpan(size: DashboardWidgetSize): number {
  if (size === "small") {
    return 3;
  }

  if (size === "medium") {
    return 6;
  }

  return 12;
}

export function validateDashboardSpec(spec: unknown): spec is DashboardSpec {
  if (!spec || typeof spec !== "object") {
    return false;
  }

  const candidate = spec as Partial<DashboardSpec>;

  return (
    candidate.version === 1 &&
    typeof candidate.title === "string" &&
    Array.isArray(candidate.dataSources) &&
    Array.isArray(candidate.transforms) &&
    Array.isArray(candidate.widgets)
  );
}

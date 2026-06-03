import type { DashboardSpec } from "./dashboardSpec";

export type ColumnType = "string" | "number" | "date" | "boolean";

export type CrudOperation = "list" | "read" | "create" | "update" | "delete";

export type ChartType = "bar" | "line" | "pie" | "table" | "dashboard";

export interface ColumnDefinition {
  name: string;
  type: ColumnType;
  description: string;
  example?: string | number | boolean;
}

export interface RelationDefinition {
  column: string;
  referencesTable: string;
  referencesColumn: string;
  description: string;
}

export interface TableDefinition {
  name: string;
  description: string;
  primaryKey: string;
  columns: ColumnDefinition[];
  relations: RelationDefinition[];
}

export interface ApiEndpointDefinition {
  table: string;
  operation: CrudOperation;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  filters: string[];
  sortable: string[];
  paginated: boolean;
}

export interface ApiCatalog {
  basePath: string;
  endpoints: ApiEndpointDefinition[];
}

export interface AnalysisRequest {
  prompt: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AnalysisChatRequest {
  messages: ChatMessage[];
  currentDashboardSpec?: DashboardSpec;
}

export interface AnalysisChatResponse {
  message: string;
  readyToGenerate: boolean;
  reportPrompt: string;
}

export interface ApiCallPlan {
  table: string;
  path: string;
  reason: string;
}

export interface GeneratedReport {
  title: string;
  prompt: string;
  chartType: ChartType;
  html: string;
  apiCalls: ApiCallPlan[];
  createdAt: string;
  dashboardSpec?: DashboardSpec;
}

export interface SavedReport extends GeneratedReport {
  id: string;
  updatedAt: string;
  version: number;
  owner: string;
  visibility: "private" | "shared";
}

export interface RuntimeApiResponse<T = unknown> {
  data: T[];
  meta: {
    table: string;
    total: number;
    source: "mock-crud-api";
  };
}

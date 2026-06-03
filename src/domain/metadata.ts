import type { ApiCatalog, TableDefinition } from "./types";

export const schemaRegistry: TableDefinition[] = [
  {
    name: "customers",
    description: "People or companies that purchase products.",
    primaryKey: "id",
    columns: [
      { name: "id", type: "string", description: "Customer identifier", example: "cus_001" },
      { name: "name", type: "string", description: "Customer display name", example: "Acme Corp" },
      { name: "segment", type: "string", description: "Customer segment", example: "enterprise" },
      { name: "createdAt", type: "date", description: "Signup date", example: "2026-01-12" }
    ],
    relations: []
  },
  {
    name: "products",
    description: "Products available for purchase.",
    primaryKey: "id",
    columns: [
      { name: "id", type: "string", description: "Product identifier", example: "prd_001" },
      { name: "name", type: "string", description: "Product name", example: "Analytics Pro" },
      { name: "category", type: "string", description: "Product category", example: "software" },
      { name: "price", type: "number", description: "Unit price", example: 299 }
    ],
    relations: []
  },
  {
    name: "orders",
    description: "Purchase orders connecting customers and products.",
    primaryKey: "id",
    columns: [
      { name: "id", type: "string", description: "Order identifier", example: "ord_001" },
      { name: "customerId", type: "string", description: "Customer that placed the order", example: "cus_001" },
      { name: "productId", type: "string", description: "Purchased product", example: "prd_001" },
      { name: "quantity", type: "number", description: "Number of purchased units", example: 3 },
      { name: "revenue", type: "number", description: "Total order revenue", example: 897 },
      { name: "status", type: "string", description: "Order lifecycle state", example: "paid" },
      { name: "orderedAt", type: "date", description: "Order date", example: "2026-04-18" }
    ],
    relations: [
      {
        column: "customerId",
        referencesTable: "customers",
        referencesColumn: "id",
        description: "Each order belongs to one customer."
      },
      {
        column: "productId",
        referencesTable: "products",
        referencesColumn: "id",
        description: "Each order contains one product."
      }
    ]
  }
];

export const apiCatalog: ApiCatalog = {
  basePath: "/api",
  endpoints: schemaRegistry.flatMap((table) => [
    {
      table: table.name,
      operation: "list",
      method: "GET",
      path: `/api/${table.name}`,
      filters: table.columns.map((column) => column.name),
      sortable: table.columns.map((column) => column.name),
      paginated: true
    },
    {
      table: table.name,
      operation: "read",
      method: "GET",
      path: `/api/${table.name}/{id}`,
      filters: [table.primaryKey],
      sortable: [],
      paginated: false
    }
  ])
};

export function getTableDefinition(tableName: string): TableDefinition | undefined {
  return schemaRegistry.find((table) => table.name === tableName);
}

export function getListEndpoint(tableName: string) {
  return apiCatalog.endpoints.find(
    (endpoint) => endpoint.table === tableName && endpoint.operation === "list"
  );
}

export const mockData = {
  customers: [
    { id: "cus_001", name: "Acme Corp", segment: "enterprise", createdAt: "2026-01-12" },
    { id: "cus_002", name: "Bright Labs", segment: "startup", createdAt: "2026-02-03" },
    { id: "cus_003", name: "Northwind", segment: "mid-market", createdAt: "2026-02-24" },
    { id: "cus_004", name: "Bluebird Studio", segment: "startup", createdAt: "2026-03-18" }
  ],
  products: [
    { id: "prd_001", name: "Analytics Pro", category: "software", price: 299 },
    { id: "prd_002", name: "Data Warehouse", category: "infrastructure", price: 799 },
    { id: "prd_003", name: "Support Plus", category: "service", price: 149 },
    { id: "prd_004", name: "Automation Pack", category: "software", price: 399 }
  ],
  orders: [
    {
      id: "ord_001",
      customerId: "cus_001",
      productId: "prd_001",
      quantity: 3,
      revenue: 897,
      status: "paid",
      orderedAt: "2026-04-01"
    },
    {
      id: "ord_002",
      customerId: "cus_002",
      productId: "prd_003",
      quantity: 2,
      revenue: 298,
      status: "paid",
      orderedAt: "2026-04-05"
    },
    {
      id: "ord_003",
      customerId: "cus_001",
      productId: "prd_002",
      quantity: 1,
      revenue: 799,
      status: "paid",
      orderedAt: "2026-04-14"
    },
    {
      id: "ord_004",
      customerId: "cus_003",
      productId: "prd_004",
      quantity: 5,
      revenue: 1995,
      status: "pending",
      orderedAt: "2026-04-22"
    },
    {
      id: "ord_005",
      customerId: "cus_004",
      productId: "prd_001",
      quantity: 1,
      revenue: 299,
      status: "paid",
      orderedAt: "2026-05-03"
    },
    {
      id: "ord_006",
      customerId: "cus_002",
      productId: "prd_004",
      quantity: 2,
      revenue: 798,
      status: "paid",
      orderedAt: "2026-05-10"
    }
  ]
} as const;

export type MockTableName = keyof typeof mockData;

import { getListEndpoint } from "./metadata";
import type { AnalysisRequest, ChartType, GeneratedReport } from "./types";

interface GenerationIntent {
  title: string;
  chartType: ChartType;
  tables: string[];
  sort?: string;
  aggregation: "revenueByProduct" | "ordersOverTime" | "customersBySegment" | "rawTable";
}

export function generateReport(request: AnalysisRequest): GeneratedReport {
  const intent = inferIntent(request.prompt);
  const apiCalls = intent.tables.map((table) => {
    const endpoint = getListEndpoint(table);

    return {
      table,
      path: endpoint?.path ?? `/api/${table}`,
      reason: `Load ${table} records for ${intent.title}.`
    };
  });

  return {
    title: intent.title,
    prompt: request.prompt,
    chartType: intent.chartType,
    html: buildHtml(intent),
    apiCalls,
    createdAt: new Date().toISOString()
  };
}

function inferIntent(prompt: string): GenerationIntent {
  const normalized = prompt.toLowerCase();
  const wantsLatest = includesAny(normalized, ["latest", "recent", "newest", "date", "날짜", "최신"]);
  const wantsLine = includesAny(normalized, ["trend", "over time", "line", "추이", "시간"]);
  const wantsPie = includesAny(normalized, ["share", "ratio", "pie", "비율", "점유"]);
  const wantsTable = includesAny(normalized, ["table", "raw", "list", "목록", "테이블"]);
  const mentionsCustomer = includesAny(normalized, ["customer", "segment", "고객"]);

  if (mentionsCustomer && wantsPie) {
    return {
      title: "Customers by Segment",
      chartType: "pie",
      tables: ["customers"],
      aggregation: "customersBySegment",
      sort: wantsLatest ? "createdAt:desc" : undefined
    };
  }

  if (wantsLine) {
    return {
      title: "Revenue Trend by Order Date",
      chartType: "line",
      tables: ["orders"],
      aggregation: "ordersOverTime",
      sort: "orderedAt:asc"
    };
  }

  if (wantsTable) {
    return {
      title: "Recent Orders Table",
      chartType: "table",
      tables: ["orders", "customers", "products"],
      aggregation: "rawTable",
      sort: wantsLatest ? "orderedAt:desc" : undefined
    };
  }

  return {
    title: "Revenue by Product",
    chartType: "bar",
    tables: ["orders", "products"],
    aggregation: "revenueByProduct",
    sort: wantsLatest ? "orderedAt:desc" : undefined
  };
}

function buildHtml(intent: GenerationIntent): string {
  const sortQuery = intent.sort ? `?sort=${encodeURIComponent(intent.sort)}` : "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
      body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #172033; }
      .report { padding: 20px; }
      .muted { color: #687385; font-size: 13px; }
      .error { color: #b42318; background: #fff1f0; padding: 12px; border-radius: 8px; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; }
      th, td { border-bottom: 1px solid #e6e8ef; padding: 10px; text-align: left; }
      th { color: #4b5563; }
      canvas { max-height: 420px; }
    </style>
  </head>
  <body>
    <main class="report">
      <h1>${escapeHtml(intent.title)}</h1>
      <p class="muted">Generated report. Data is loaded from allowed CRUD APIs at view time.</p>
      <section id="status" class="muted">Loading data...</section>
      <section id="output"></section>
    </main>
    <script>
      const chartType = ${JSON.stringify(intent.chartType)};
      const aggregation = ${JSON.stringify(intent.aggregation)};

      async function loadJson(path) {
        const response = await fetch(path);
        if (!response.ok) {
          throw new Error("Failed to load " + path);
        }
        return response.json();
      }

      async function main() {
        const status = document.getElementById("status");
        const output = document.getElementById("output");
        const tables = await loadTables();
        const result = aggregate(tables);
        status.textContent = "Loaded " + result.rows.length + " rows from CRUD APIs.";

        if (chartType === "table") {
          renderTable(output, result.rows);
        } else {
          renderChart(output, result);
        }
      }

      async function loadTables() {
        const tables = {};
        ${intent.tables
          .map((table) => `tables.${table} = (await loadJson("/api/${table}${table === "orders" ? sortQuery : ""}")).data;`)
          .join("\n        ")}
        return tables;
      }

      function aggregate(tables) {
        if (aggregation === "customersBySegment") {
          const grouped = groupSum(tables.customers, "segment", () => 1);
          return toSeries(grouped);
        }

        if (aggregation === "ordersOverTime") {
          const grouped = groupSum(tables.orders, "orderedAt", (order) => order.revenue);
          return toSeries(grouped);
        }

        if (aggregation === "rawTable") {
          const customers = byId(tables.customers);
          const products = byId(tables.products);
          return {
            labels: [],
            values: [],
            rows: tables.orders.map((order) => ({
              order: order.id,
              date: order.orderedAt,
              customer: customers[order.customerId]?.name ?? order.customerId,
              product: products[order.productId]?.name ?? order.productId,
              status: order.status,
              revenue: order.revenue
            }))
          };
        }

        const products = byId(tables.products);
        const grouped = groupSum(tables.orders, "productId", (order) => order.revenue);
        const rows = Object.entries(grouped).map(([productId, revenue]) => ({
          label: products[productId]?.name ?? productId,
          value: revenue
        }));
        return {
          labels: rows.map((row) => row.label),
          values: rows.map((row) => row.value),
          rows
        };
      }

      function groupSum(rows, key, valueSelector) {
        return rows.reduce((acc, row) => {
          const group = row[key] ?? "unknown";
          acc[group] = (acc[group] ?? 0) + valueSelector(row);
          return acc;
        }, {});
      }

      function toSeries(grouped) {
        const rows = Object.entries(grouped).map(([label, value]) => ({ label, value }));
        return {
          labels: rows.map((row) => row.label),
          values: rows.map((row) => row.value),
          rows
        };
      }

      function byId(rows) {
        return Object.fromEntries(rows.map((row) => [row.id, row]));
      }

      function renderChart(output, result) {
        output.innerHTML = '<canvas id="chart"></canvas>';
        const ChartConstructor = window.Chart;
        if (!ChartConstructor) {
          output.innerHTML = '<p class="error">Chart.js failed to load. Try again with network access.</p>';
          return;
        }

        new ChartConstructor(document.getElementById("chart"), {
          type: chartType,
          data: {
            labels: result.labels,
            datasets: [{
              label: ${JSON.stringify(intent.title)},
              data: result.values,
              borderColor: "#3b82f6",
              backgroundColor: ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6"],
              tension: 0.25
            }]
          },
          options: { responsive: true, maintainAspectRatio: false }
        });
      }

      function renderTable(output, rows) {
        if (rows.length === 0) {
          output.innerHTML = "<p>No rows found.</p>";
          return;
        }
        const columns = Object.keys(rows[0]);
        output.innerHTML = "<table><thead><tr>" +
          columns.map((column) => "<th>" + column + "</th>").join("") +
          "</tr></thead><tbody>" +
          rows.map((row) => "<tr>" + columns.map((column) => "<td>" + row[column] + "</td>").join("") + "</tr>").join("") +
          "</tbody></table>";
      }

      main().catch((error) => {
        document.getElementById("status").innerHTML = '<p class="error">' + error.message + '</p>';
      });
    </script>
  </body>
</html>`;
}

function includesAny(value: string, candidates: string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

import { createServer } from "node:http";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 5173);

loadEnv(resolve(root, ".env"));

const schemaContext = JSON.parse(readFileSync(resolve(root, "data/contoso-schema.json"), "utf8"));
const dashboardSpecSchema = JSON.parse(readFileSync(resolve(root, "data/dashboard-spec.schema.json"), "utf8"));
const prompts = {
  analysisChat: readPrompt("analysis-chat.system.md"),
  dashboardSpecGenerator: readPrompt("dashboard-spec-generator.system.md"),
  reportGenerator: readPrompt("report-generator.system.md")
};
const allowedTables = new Map(schemaContext.tables.map((table) => [table.name, table]));
const pool = createPostgresPool();

const vite = isProduction
  ? undefined
  : await import("vite").then(({ createServer: createViteServer }) =>
      createViteServer({
        root,
        server: { middlewareMode: true },
        appType: "spa"
      })
    );

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (request.method === "POST" && url.pathname === "/api/generate-report") {
      await handleGenerateReport(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/generate-dashboard-spec") {
      await handleGenerateDashboardSpec(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/analysis-chat") {
      await handleAnalysisChat(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/publish-dashboard") {
      await handlePublishDashboard(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/published-reports") {
      await handleListPublishedReports(response);
      return;
    }

    const publishedReportMatch = url.pathname.match(/^\/api\/published-reports\/([^/]+)$/);

    if (publishedReportMatch) {
      const reportId = publishedReportMatch[1];

      if (request.method === "GET") {
        await handleGetPublishedReport(reportId, response);
        return;
      }

      if (request.method === "PUT") {
        await handleUpdatePublishedReport(reportId, request, response);
        return;
      }
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/")) {
      await handleCrudList(url, response);
      return;
    }

    if (request.method === "GET" && (url.pathname.startsWith("/reports/") || url.pathname === "/published-dashboard.js")) {
      await servePublicStatic(url.pathname, response);
      return;
    }

    if (vite) {
      vite.middlewares(request, response, () => {
        response.statusCode = 404;
        response.end("Not found");
      });
      return;
    }

    await serveStatic(url.pathname, response);
  } catch (error) {
    response.statusCode = 500;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ error: getErrorMessage(error) }));
  }
});

server.listen(port, () => {
  console.log(`chat-to-dashboard listening on http://localhost:${port}`);

  if (pool) {
    pool
      .query("SELECT 1")
      .then(() => console.log(`PostgreSQL connected (${process.env.PGHOST || "localhost"}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE})`))
      .catch((error) => {
        console.warn(`PostgreSQL unavailable: ${formatPostgresConnectionError(error) ?? getErrorMessage(error)}`);
      });
  } else {
    console.warn("PostgreSQL is not configured. Set PGDATABASE/PGUSER or DATABASE_URL in .env.");
  }
});

async function handleCrudList(url, response) {
  if (!pool) {
    sendJson(response, 503, { error: "PostgreSQL is not configured" });
    return;
  }

  const tableName = url.pathname.replace(/^\/api\//, "");
  const table = allowedTables.get(tableName);

  if (!table) {
    sendJson(response, 404, { error: `Unknown API table: ${tableName}` });
    return;
  }

  const columns = new Set(table.columns.map((column) => column.name));
  const columnTypes = new Map(table.columns.map((column) => [column.name, column.type]));
  const filterResult = buildWhereFromSearchParams(url.searchParams, columns);

  if (filterResult.error) {
    sendJson(response, 400, { error: `${filterResult.error} (${tableName})` });
    return;
  }

  const { where, values, index } = filterResult;
  const schemaName = quoteIdentifier(process.env.PGSCHEMA || "public");
  const tableSql = `${schemaName}.${quoteIdentifier(tableName)}`;
  const aggregateQuery = buildAggregateQuery(url.searchParams, columns, columnTypes, tableName, tableSql, where, values, index);

  if (aggregateQuery?.error) {
    sendJson(response, 400, { error: `${aggregateQuery.error} (${tableName})` });
    return;
  }

  try {
    if (aggregateQuery) {
      const result = await pool.query(aggregateQuery.query, aggregateQuery.values);

      sendJson(response, 200, {
        data: result.rows,
        meta: {
          table: tableName,
          total: result.rowCount,
          source: "postgres",
          aggregated: true,
          groupBy: aggregateQuery.groupBy,
          grain: aggregateQuery.grain,
          metrics: aggregateQuery.metrics
        }
      });
      return;
    }

    const orderBy = buildOrderBy(url.searchParams.get("sort"), columns);
    const limit = clampNumber(url.searchParams.get("limit") ?? url.searchParams.get("pageSize"), 1, 20000, 10000);
    const page = clampNumber(url.searchParams.get("page"), 1, 1000000, 1);
    const offset = (page - 1) * limit;

    values.push(limit, offset);

    const query = [
      `SELECT * FROM ${tableSql}`,
      where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
      orderBy,
      `LIMIT $${index} OFFSET $${index + 1}`
    ]
      .filter(Boolean)
      .join(" ");

    const result = await pool.query(query, values);

    sendJson(response, 200, {
      data: result.rows,
      meta: {
        table: tableName,
        total: result.rowCount,
        source: "postgres"
      }
    });
  } catch (error) {
    const connectionError = formatPostgresConnectionError(error);

    if (connectionError) {
      sendJson(response, 503, { error: connectionError });
      return;
    }

    throw error;
  }
}

async function handleAnalysisChat(request, response) {
  const body = await readJson(request);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const currentDashboardSpec = body.currentDashboardSpec && typeof body.currentDashboardSpec === "object"
    ? body.currentDashboardSpec
    : undefined;

  if (messages.length === 0) {
    sendJson(response, 400, { error: "messages are required" });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    sendJson(response, 503, { error: "OPENAI_API_KEY is not configured" });
    return;
  }

  const chat = await chatWithOpenAI({ messages, currentDashboardSpec, apiKey });
  sendJson(response, 200, chat);
}

async function handleGenerateReport(request, response) {
  const body = await readJson(request);
  const prompt = String(body.prompt ?? "").trim();

  if (!prompt) {
    sendJson(response, 400, { error: "prompt is required" });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    sendJson(response, 503, { error: "OPENAI_API_KEY is not configured" });
    return;
  }

  const report = await generateWithOpenAI({ prompt, apiKey });
  sendJson(response, 200, report);
}

async function handleGenerateDashboardSpec(request, response) {
  const body = await readJson(request);
  const prompt = String(body.prompt ?? "").trim();

  if (!prompt) {
    sendJson(response, 400, { error: "prompt is required" });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    sendJson(response, 503, { error: "OPENAI_API_KEY is not configured" });
    return;
  }

  const spec = await generateDashboardSpecWithOpenAI({ prompt, apiKey });
  sendJson(response, 200, spec);
}

async function handleListPublishedReports(response) {
  const reportsDir = resolve(root, "public/reports");
  let entries = [];

  try {
    entries = await readdir(reportsDir);
  } catch {
    sendJson(response, 200, { reports: [] });
    return;
  }

  const reports = [];

  for (const entry of entries) {
    if (!entry.endsWith(".html")) {
      continue;
    }

    const id = entry.replace(/\.html$/, "");
    const filePath = resolve(reportsDir, entry);
    const fileStat = await stat(filePath);
    const html = await readFile(filePath, "utf8");

    reports.push({
      id,
      title: extractPublishedReportTitle(html, id),
      url: `/reports/${entry}`,
      updatedAt: fileStat.mtime.toISOString()
    });
  }

  reports.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  sendJson(response, 200, { reports });
}

function extractPublishedReportTitle(html, fallbackId) {
  const spec = parseDashboardSpecFromHtml(html);

  if (spec?.title) {
    return String(spec.title).trim();
  }

  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);

  if (titleMatch?.[1]?.trim()) {
    return titleMatch[1].trim();
  }

  return fallbackId;
}

function parseDashboardSpecFromHtml(html) {
  const marker = "window.__DASHBOARD_SPEC__ = ";
  const start = html.indexOf(marker);

  if (start === -1) {
    return undefined;
  }

  const jsonStart = start + marker.length;
  const scriptEnd = html.indexOf("</script>", jsonStart);

  if (scriptEnd === -1) {
    return undefined;
  }

  let jsonText = html.slice(jsonStart, scriptEnd).trim();

  if (jsonText.endsWith(";")) {
    jsonText = jsonText.slice(0, -1).trim();
  }

  try {
    return JSON.parse(jsonText);
  } catch {
    return undefined;
  }
}

async function readPublishedReportFile(reportId) {
  if (!/^rpt_[a-z0-9]+$/i.test(reportId)) {
    return { error: "Invalid report id" };
  }

  const reportsDir = resolve(root, "public/reports");
  const filePath = resolve(reportsDir, `${reportId}.html`);

  if (!existsSync(filePath)) {
    return { error: "Published report not found" };
  }

  const html = await readFile(filePath, "utf8");
  const dashboardSpec = parseDashboardSpecFromHtml(html);

  if (!dashboardSpec || typeof dashboardSpec !== "object") {
    return { error: "Published report does not contain a dashboard spec" };
  }

  const fileStat = await stat(filePath);

  return {
    id: reportId,
    title: extractPublishedReportTitle(html, reportId),
    url: `/reports/${reportId}.html`,
    updatedAt: fileStat.mtime.toISOString(),
    dashboardSpec
  };
}

async function handleGetPublishedReport(reportId, response) {
  const report = await readPublishedReportFile(reportId);

  if (report.error) {
    sendJson(response, report.error === "Published report not found" ? 404 : 400, { error: report.error });
    return;
  }

  sendJson(response, 200, report);
}

async function handleUpdatePublishedReport(reportId, request, response) {
  const existing = await readPublishedReportFile(reportId);

  if (existing.error) {
    sendJson(response, existing.error === "Published report not found" ? 404 : 400, { error: existing.error });
    return;
  }

  const body = await readJson(request);
  const dashboardSpec = body.dashboardSpec ?? existing.dashboardSpec;

  if (!dashboardSpec || typeof dashboardSpec !== "object") {
    sendJson(response, 400, { error: "dashboardSpec is required" });
    return;
  }

  const title = String(dashboardSpec.title ?? body.title ?? existing.title);
  const filePath = resolve(root, "public/reports", `${reportId}.html`);

  await writeFile(filePath, buildPublishedDashboardHtml(title, dashboardSpec), "utf8");
  const fileStat = await stat(filePath);

  sendJson(response, 200, {
    id: reportId,
    title,
    url: `/reports/${reportId}.html`,
    updatedAt: fileStat.mtime.toISOString()
  });
}

async function handlePublishDashboard(request, response) {
  const body = await readJson(request);
  const dashboardSpec = body.dashboardSpec;

  if (!dashboardSpec || typeof dashboardSpec !== "object") {
    sendJson(response, 400, { error: "dashboardSpec is required" });
    return;
  }

  const id = `rpt_${randomUUID().slice(0, 8)}`;
  const reportsDir = resolve(root, "public/reports");
  const filePath = resolve(reportsDir, `${id}.html`);
  const title = String(dashboardSpec.title ?? body.title ?? "Published Dashboard");

  await mkdir(reportsDir, { recursive: true });
  await writeFile(filePath, buildPublishedDashboardHtml(title, dashboardSpec), "utf8");

  sendJson(response, 200, {
    id,
    url: `/reports/${id}.html`
  });
}

async function generateWithOpenAI({ prompt, apiKey }) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: prompts.reportGenerator
        },
        {
          role: "user",
          content: JSON.stringify({
            prompt,
            schemaContext,
            requirements: [
              "Use only API paths listed in schemaContext.apiCatalog.endpoints.",
              "Join and aggregate records in browser JavaScript.",
              "Render a clear chart or table inside the generated HTML.",
              "Include friendly error handling in the HTML."
            ]
          })
        }
      ]
    })
  });

  if (!openAiResponse.ok) {
    const text = await openAiResponse.text();
    throw new Error(`OpenAI request failed: ${openAiResponse.status} ${text}`);
  }

  const payload = await openAiResponse.json();
  const content = payload.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("OpenAI response did not include message content");
  }

  const parsed = JSON.parse(content);
  return normalizeReport(parsed, prompt);
}

async function generateDashboardSpecWithOpenAI({ prompt, apiKey }) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: prompts.dashboardSpecGenerator
        },
        {
          role: "user",
          content: JSON.stringify({
            prompt,
            schemaContext,
            dashboardSpecSchema
          })
        }
      ]
    })
  });

  if (!openAiResponse.ok) {
    const text = await openAiResponse.text();
    throw new Error(`OpenAI dashboard spec request failed: ${openAiResponse.status} ${text}`);
  }

  const payload = await openAiResponse.json();
  const content = payload.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("OpenAI dashboard spec response did not include message content");
  }

  return normalizeDashboardSpec(JSON.parse(content));
}

async function chatWithOpenAI({ messages, currentDashboardSpec, apiKey }) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const safeMessages = messages.map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: String(message.content ?? "")
  }));
  const latestUserMessage = [...safeMessages].reverse().find((message) => message.role === "user");

  const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: prompts.analysisChat
        },
        {
          role: "user",
          content: JSON.stringify({
            schemaContext,
            latestUserMessage,
            conversation: safeMessages,
            currentDashboardSpec,
            hasExistingDashboard: Boolean(currentDashboardSpec)
          })
        }
      ]
    })
  });

  if (!openAiResponse.ok) {
    const text = await openAiResponse.text();
    throw new Error(`OpenAI chat request failed: ${openAiResponse.status} ${text}`);
  }

  const payload = await openAiResponse.json();
  const content = payload.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("OpenAI chat response did not include message content");
  }

  const parsed = JSON.parse(content);
  return {
    message: String(parsed.message ?? "요구사항을 조금 더 구체화해주세요."),
    readyToGenerate: Boolean(parsed.readyToGenerate),
    reportPrompt: String(parsed.reportPrompt ?? safeMessages.map((message) => `${message.role}: ${message.content}`).join("\n"))
  };
}

function normalizeReport(value, prompt) {
  const chartTypes = new Set(["dashboard", "bar", "line", "pie", "table"]);
  const chartType = chartTypes.has(value.chartType) ? value.chartType : "dashboard";
  const apiCalls = Array.isArray(value.apiCalls) ? value.apiCalls : [];

  if (typeof value.title !== "string" || typeof value.html !== "string") {
    throw new Error("OpenAI response is missing title or html");
  }

  return {
    title: value.title,
    prompt,
    chartType,
    html: value.html,
    apiCalls: apiCalls.map((call) => ({
      table: String(call.table ?? ""),
      path: String(call.path ?? ""),
      reason: String(call.reason ?? "")
    })),
    createdAt: new Date().toISOString()
  };
}

function normalizeDashboardSpec(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Dashboard spec must be an object");
  }

  return {
    version: 1,
    title: String(value.title ?? "Untitled Dashboard"),
    description: typeof value.description === "string" ? value.description : undefined,
    dataSources: Array.isArray(value.dataSources) ? value.dataSources : [],
    transforms: Array.isArray(value.transforms) ? value.transforms : [],
    widgets: Array.isArray(value.widgets) ? value.widgets : []
  };
}

async function readJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response, statusCode, value) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
}

async function serveStatic(pathname, response) {
  const dist = resolve(root, "dist");
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(dist, normalizedPath);
  const safePath = resolve(filePath);

  if (!safePath.startsWith(dist) || !existsSync(safePath)) {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }

  response.setHeader("Content-Type", contentType(extname(safePath)));
  response.end(await readFile(safePath));
}

async function servePublicStatic(pathname, response) {
  const publicRoot = resolve(root, "public");
  const filePath = join(publicRoot, pathname);
  const safePath = resolve(filePath);

  if (!safePath.startsWith(publicRoot) || !existsSync(safePath)) {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }

  response.setHeader("Content-Type", contentType(extname(safePath)));
  response.end(await readFile(safePath));
}

function contentType(extension) {
  return {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml"
  }[extension] ?? "application/octet-stream";
}

function createPostgresPool() {
  const hasPgSettings = process.env.PGDATABASE && process.env.PGUSER;

  if (hasPgSettings) {
    return new pg.Pool({
      database: process.env.PGDATABASE,
      host: process.env.PGHOST || "localhost",
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD
    });
  }

  if (process.env.DATABASE_URL) {
    return new pg.Pool({
      connectionString: process.env.DATABASE_URL
    });
  }

  return undefined;
}

const RESERVED_QUERY_PARAMS = new Set(["sort", "page", "pageSize", "limit", "groupBy", "grain", "metrics"]);
const VIRTUAL_DATE_GROUP_FIELDS = new Set(["month", "year", "quarter", "week", "day", "date_bucket", "year_month"]);
const DATE_TRUNC_GRAINS = new Set(["day", "week", "month", "quarter", "year"]);
const FILTER_OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "between", "like", "isnull"]);

function buildWhereFromSearchParams(searchParams, columns) {
  const where = [];
  const values = [];
  let index = 1;

  for (const [key, rawValue] of searchParams.entries()) {
    if (RESERVED_QUERY_PARAMS.has(key)) {
      continue;
    }

    const parsed = parseFilterParam(key, rawValue);

    if (!columns.has(parsed.field)) {
      return { error: `Unknown filter field: ${parsed.field}` };
    }

    const columnSql = quoteIdentifier(parsed.field);

    if (parsed.op === "isnull") {
      const isNull = String(rawValue).toLowerCase() === "true" || rawValue === "1";
      where.push(isNull ? `${columnSql} IS NULL` : `${columnSql} IS NOT NULL`);
      continue;
    }

    if (parsed.op === "in") {
      const items = String(rawValue)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      if (items.length === 0) {
        return { error: `Filter ${parsed.field}__in requires at least one value` };
      }

      values.push(items);
      where.push(`${columnSql} = ANY($${index})`);
      index += 1;
      continue;
    }

    if (parsed.op === "between") {
      const [start, end] = String(rawValue).split(",").map((item) => item.trim());

      if (!start || !end) {
        return { error: `Filter ${parsed.field}__between requires two comma-separated values` };
      }

      values.push(start, end);
      where.push(`${columnSql} BETWEEN $${index} AND $${index + 1}`);
      index += 2;
      continue;
    }

    if (parsed.op === "like") {
      values.push(String(rawValue));
      where.push(`${columnSql}::text ILIKE $${index}`);
      index += 1;
      continue;
    }

    const operatorSql = {
      eq: "=",
      ne: "<>",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<="
    }[parsed.op];

    if (!operatorSql) {
      return { error: `Unsupported filter operator: ${parsed.op}` };
    }

    values.push(rawValue);
    where.push(`${columnSql} ${operatorSql} $${index}`);
    index += 1;
  }

  return { where, values, index };
}

function buildAggregateQuery(searchParams, columns, columnTypes, tableName, tableSql, where, values, nextIndex) {
  const groupByParam = searchParams.get("groupBy");

  if (!groupByParam) {
    return undefined;
  }

  const metricsParam = searchParams.get("metrics");

  if (!metricsParam) {
    return { error: "metrics are required when groupBy is provided" };
  }

  const grain = normalizeDateGrain(searchParams.get("grain") ?? "month");
  const groupFields = groupByParam
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);

  if (groupFields.length === 0) {
    return { error: "groupBy must include at least one field" };
  }

  const factAlias = "fact";
  const schemaName = quoteIdentifier(process.env.PGSCHEMA || "public");
  const dimensionJoins = new Map();
  const selectParts = [];
  const groupByParts = [];
  let selectIndex = 1;

  for (const field of groupFields) {
    const dimensionJoin = resolveDimensionJoin(tableName, field, columns);

    if (dimensionJoin) {
      dimensionJoins.set(dimensionJoin.table, dimensionJoin);
      const joinAlias = dimensionJoin.table;
      selectParts.push(
        `${quoteIdentifier(joinAlias)}.${quoteIdentifier(field)} AS ${quoteIdentifier(field)}`
      );
      groupByParts.push(String(selectIndex));
      selectIndex += 1;
      continue;
    }

    const sourceField = resolveAggregateSourceField(field, columns);

    if (!sourceField) {
      return { error: `Unknown groupBy field: ${field}` };
    }

    const qualifiedSource = `${quoteIdentifier(factAlias)}.${quoteIdentifier(sourceField)}`;

    if (shouldBucketDateField(field, sourceField, columnTypes)) {
      const bucketGrain = inferBucketGrain(field, grain);
      const bucketSql = `to_char(date_trunc('${bucketGrain}', ${qualifiedSource}), '${dateBucketFormat(bucketGrain)}')`;
      selectParts.push(`${bucketSql} AS ${quoteIdentifier(field)}`);
      groupByParts.push(String(selectIndex));
      selectIndex += 1;
      continue;
    }

    selectParts.push(`${qualifiedSource} AS ${quoteIdentifier(field)}`);
    groupByParts.push(String(selectIndex));
    selectIndex += 1;
  }

  const metricResult = buildMetricSelectParts(metricsParam, columns, factAlias);

  if (metricResult.error) {
    return metricResult;
  }

  selectParts.push(...metricResult.selectParts);

  let fromClause = `${tableSql} AS ${quoteIdentifier(factAlias)}`;

  for (const join of dimensionJoins.values()) {
    const joinAlias = join.table;
    fromClause += ` LEFT JOIN ${schemaName}.${quoteIdentifier(join.table)} AS ${quoteIdentifier(joinAlias)} ON ${quoteIdentifier(factAlias)}.${quoteIdentifier(join.leftKey)} = ${quoteIdentifier(joinAlias)}.${quoteIdentifier(join.rightKey)}`;
  }

  const qualifiedWhere = dimensionJoins.size > 0 ? qualifyWhereForFact(where, factAlias, columns) : where;
  const orderBy = buildAggregateOrderBy(searchParams.get("sort"), groupFields, metricResult.metricAliases);
  const limit = resolveAggregateLimit(searchParams, groupFields);
  const page = clampNumber(searchParams.get("page"), 1, 1000000, 1);
  const offset = (page - 1) * limit;
  const limitIndex = nextIndex;
  const offsetIndex = nextIndex + 1;
  const aggregateValues = [...values, limit, offset];

  const query = [
    `SELECT ${selectParts.join(", ")}`,
    `FROM ${fromClause}`,
    qualifiedWhere.length > 0 ? `WHERE ${qualifiedWhere.join(" AND ")}` : "",
    `GROUP BY ${groupByParts.join(", ")}`,
    orderBy,
    `LIMIT $${limitIndex} OFFSET $${offsetIndex}`
  ]
    .filter(Boolean)
    .join(" ");

  return {
    query,
    values: aggregateValues,
    groupBy: groupFields,
    grain,
    metrics: metricResult.metrics
  };
}

function buildMetricSelectParts(metricsParam, columns, factAlias = "") {
  const metrics = metricsParam
    .split(",")
    .map((metric) => metric.trim())
    .filter(Boolean);
  const selectParts = [];
  const metricAliases = [];
  const metricDefinitions = [];

  for (const metric of metrics) {
    const parsed = parseMetricParam(metric);

    if (!parsed) {
      return { error: `Invalid metric: ${metric}` };
    }

    if (parsed.field && !columns.has(parsed.field)) {
      return { error: `Unknown metric field: ${parsed.field}` };
    }

    const sql = buildMetricSql(parsed.aggregate, parsed.field, factAlias);
    const alias = parsed.alias ?? (parsed.field ? `${parsed.aggregate}_${parsed.field}` : parsed.aggregate);

    selectParts.push(`${sql} AS ${quoteIdentifier(alias)}`);
    metricAliases.push(alias);
    metricDefinitions.push({ ...parsed, alias });
  }

  return { selectParts, metricAliases, metrics: metricDefinitions };
}

function parseMetricParam(metric) {
  const distinctMatch = metric.match(/^count_distinct:([A-Za-z0-9_]+)$/);

  if (distinctMatch) {
    const [, field] = distinctMatch;
    return {
      aggregate: "count_distinct",
      field,
      alias: `count_distinct_${field}`
    };
  }

  const match = metric.match(/^(sum|avg|min|max|count)(?::([A-Za-z0-9_]+))?$/);

  if (!match) {
    return undefined;
  }

  const [, aggregate, field] = match;

  return {
    aggregate,
    field,
    alias: field ? `${aggregate}_${field}` : aggregate
  };
}

function buildMetricSql(aggregate, field, factAlias = "") {
  const columnSql = field
    ? factAlias
      ? `${quoteIdentifier(factAlias)}.${quoteIdentifier(field)}`
      : quoteIdentifier(field)
    : "";

  if (aggregate === "count_distinct" && field) {
    return `COUNT(DISTINCT ${columnSql})`;
  }

  if (aggregate === "count" && !field) {
    return "COUNT(*)";
  }

  if (aggregate === "count") {
    return `COUNT(${columnSql})`;
  }

  return `${aggregate.toUpperCase()}(${columnSql})`;
}

function resolveDimensionJoin(factTableName, field, factColumns) {
  if (factColumns.has(field)) {
    return undefined;
  }

  if (VIRTUAL_DATE_GROUP_FIELDS.has(field)) {
    return undefined;
  }

  for (const relationship of schemaContext.relationships ?? []) {
    if (relationship.from?.table !== factTableName) {
      continue;
    }

    const dimensionTable = allowedTables.get(relationship.to?.table);

    if (!dimensionTable) {
      continue;
    }

    const dimensionColumns = new Set(dimensionTable.columns.map((column) => column.name));

    if (!dimensionColumns.has(field)) {
      continue;
    }

    return {
      table: relationship.to.table,
      leftKey: relationship.from.column,
      rightKey: relationship.to.column,
      field
    };
  }

  return undefined;
}

function qualifyWhereForFact(where, factAlias, factColumns) {
  return where.map((clause) => {
    let qualifiedClause = clause;

    for (const column of factColumns) {
      const bare = quoteIdentifier(column);
      const prefixed = `${quoteIdentifier(factAlias)}.${bare}`;
      qualifiedClause = qualifiedClause.split(bare).join(prefixed);
    }

    return qualifiedClause;
  });
}

function resolveAggregateLimit(searchParams, groupFields) {
  const requested = clampNumber(searchParams.get("limit") ?? searchParams.get("pageSize"), 1, 20000, 200);

  if (groupFields.some(isCategoricalGroupField) && requested < 8) {
    return 50;
  }

  return requested;
}

function isCategoricalGroupField(field) {
  return /^(country|country_code|country_name|country_full|category_name|brand|gender|occupation|product_name|currency_code|store_key|customer_key|product_key)$/i.test(
    field
  );
}

function resolveAggregateSourceField(field, columns) {
  if (columns.has(field)) {
    return field;
  }

  if (VIRTUAL_DATE_GROUP_FIELDS.has(field) && columns.has("order_date")) {
    return "order_date";
  }

  if (VIRTUAL_DATE_GROUP_FIELDS.has(field) && columns.has("date")) {
    return "date";
  }

  return undefined;
}

function shouldBucketDateField(requestedField, sourceField, columnTypes) {
  if (VIRTUAL_DATE_GROUP_FIELDS.has(requestedField)) {
    return true;
  }

  return columnTypes.get(sourceField) === "date" || /_date$|_at$/i.test(sourceField);
}

function inferBucketGrain(requestedField, fallbackGrain) {
  if (requestedField === "year" || requestedField === "year_month") {
    return "year";
  }

  if (requestedField === "quarter") {
    return "quarter";
  }

  if (requestedField === "week") {
    return "week";
  }

  if (requestedField === "day" || requestedField === "date") {
    return "day";
  }

  return fallbackGrain;
}

function normalizeDateGrain(grain) {
  return DATE_TRUNC_GRAINS.has(grain) ? grain : "month";
}

function dateBucketFormat(grain) {
  if (grain === "year") {
    return "YYYY";
  }

  if (grain === "quarter") {
    return 'YYYY-"Q"Q';
  }

  if (grain === "day") {
    return "YYYY-MM-DD";
  }

  return "YYYY-MM";
}

function buildAggregateOrderBy(sort, groupFields, metricAliases) {
  if (!sort) {
    return `ORDER BY ${quoteIdentifier(groupFields[0])} ASC`;
  }

  const [column, direction = "asc"] = sort.split(":");
  const normalizedDirection = direction.toLowerCase() === "desc" ? "DESC" : "ASC";

  if (groupFields.includes(column) || metricAliases.includes(column)) {
    return `ORDER BY ${quoteIdentifier(column)} ${normalizedDirection}`;
  }

  return `ORDER BY ${quoteIdentifier(groupFields[0])} ASC`;
}

function parseFilterParam(key, value) {
  const match = key.match(/^(.+)__(eq|ne|gt|gte|lt|lte|in|between|like|isnull)$/);

  if (!match) {
    return { field: key, op: "eq" };
  }

  const [, field, op] = match;

  if (!FILTER_OPERATORS.has(op)) {
    return { field: key, op: "eq" };
  }

  return { field, op };
}

function buildOrderBy(sort, columns) {
  if (!sort) {
    return "";
  }

  const [column, direction = "asc"] = sort.split(":");

  if (!columns.has(column)) {
    return "";
  }

  const normalizedDirection = direction.toLowerCase() === "desc" ? "DESC" : "ASC";
  return `ORDER BY ${quoteIdentifier(column)} ${normalizedDirection}`;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function buildPublishedDashboardHtml(title, dashboardSpec) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script>
      window.__DASHBOARD_SPEC__ = ${JSON.stringify(dashboardSpec)};
    </script>
    <script defer src="/published-dashboard.js"></script>
    <style>
      body { margin: 0; background: #f5f7fb; color: #172033; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { padding: 24px; }
      .dashboard-spec { border: 1px solid #dde3ee; border-radius: 16px; background: #fff; padding: 20px; }
      .dashboard-spec-header { margin-bottom: 18px; }
      .dashboard-spec-header h1 { margin: 0 0 6px; }
      .dashboard-spec-header p { margin: 0; color: #687385; }
      .dashboard-spec-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 16px; }
      .dashboard-spec-widget { min-height: 180px; border: 1px solid #edf0f5; border-radius: 14px; background: #fff; padding: 16px; }
      .dashboard-spec-widget h2 { margin: 0 0 4px; font-size: 16px; }
      .dashboard-spec-widget p { margin: 0; color: #687385; font-size: 13px; }
      .dashboard-spec-widget-body { min-height: 160px; position: relative; }
      .dashboard-kpi-value { font-size: 32px; font-weight: 700; }
      .dashboard-kpi-label { color: #687385; margin-top: 6px; }
      .dashboard-table-wrap { max-height: 320px; overflow: auto; }
      .dashboard-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .dashboard-table th, .dashboard-table td { border-bottom: 1px solid #edf0f5; padding: 8px; text-align: left; }
      .dashboard-table th { color: #4b5563; font-weight: 600; }
      .description { color: #687385; }
      @media (max-width: 960px) { .dashboard-spec-widget { grid-column: span 12 !important; } }
    </style>
  </head>
  <body>
    <main id="published-dashboard"></main>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getErrorMessage(error) {
  if (error instanceof AggregateError) {
    const messages = error.errors
      .map((item) => getErrorMessage(item))
      .filter(Boolean);

    return messages.length > 0 ? messages.join("; ") : "Multiple errors occurred";
  }

  if (error instanceof Error) {
    return error.message || error.code || error.name || "Unknown server error";
  }

  return String(error || "Unknown server error");
}

function formatPostgresConnectionError(error) {
  const codes = collectErrorCodes(error);

  if (!codes.has("ECONNREFUSED") && !codes.has("ENOTFOUND") && !codes.has("ETIMEDOUT")) {
    return undefined;
  }

  const host = process.env.PGHOST || "localhost";
  const dbPort = process.env.PGPORT || 5432;
  const database = process.env.PGDATABASE || "postgres";

  return `PostgreSQL is not reachable at ${host}:${dbPort} (database: ${database}). Start PostgreSQL, confirm .env settings, then restart npm run dev.`;
}

function collectErrorCodes(error) {
  const codes = new Set();

  if (error instanceof AggregateError) {
    for (const item of error.errors) {
      for (const code of collectErrorCodes(item)) {
        codes.add(code);
      }
    }
  }

  if (error && typeof error === "object" && "code" in error && error.code) {
    codes.add(String(error.code));
  }

  return codes;
}

function loadEnv(path) {
  if (!existsSync(path)) {
    return;
  }

  const lines = readFileSync(path, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function readPrompt(filename) {
  return readFileSync(resolve(root, "prompts", filename), "utf8").trim();
}

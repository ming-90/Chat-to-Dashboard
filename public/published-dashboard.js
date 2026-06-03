(function () {
  const ChartConstructor = window.Chart;
  const spec = window.__DASHBOARD_SPEC__;
  const root = document.getElementById("published-dashboard");

  if (!root || !spec) {
    return;
  }

  renderDashboard(root, spec).catch((error) => {
    root.innerHTML = `<section class="dashboard-spec"><h1>Dashboard render failed</h1><p class="description">${escapeHtml(error.message || String(error))}</p></section>`;
  });

  async function renderDashboard(container, dashboardSpec) {
    container.innerHTML = `
      <section class="dashboard-spec">
        <header class="dashboard-spec-header">
          <h1>${escapeHtml(dashboardSpec.title)}</h1>
          ${dashboardSpec.description ? `<p>${escapeHtml(dashboardSpec.description)}</p>` : ""}
        </header>
        <div class="dashboard-spec-grid">
          ${dashboardSpec.widgets.map(renderWidgetShell).join("")}
        </div>
      </section>
    `;

    const context = await loadDataContext(dashboardSpec);

    for (const widget of dashboardSpec.widgets) {
      const body = container.querySelector(`[data-widget-id="${cssEscape(widget.id)}"] .dashboard-spec-widget-body`);
      if (!body) continue;
      renderWidget(body, widget, context[widget.source] || []);
    }
  }

  function appendDashboardFilter(params, filter) {
    const paramKey = filter.op === "eq" ? filter.field : `${filter.field}__${filter.op}`;
    if (filter.op === "in") {
      params.set(paramKey, (filter.values || []).map(String).join(","));
      return;
    }
    if (filter.op === "between") {
      const values = filter.values && filter.values.length >= 2 ? filter.values : [filter.value ?? "", ""];
      params.set(paramKey, `${values[0]},${values[1]}`);
      return;
    }
    if (filter.op === "isnull") {
      params.set(paramKey, String(filter.value ?? true));
      return;
    }
    params.set(paramKey, String(filter.value ?? ""));
  }

  function buildDataSourceUrl(path, filters) {
    const queryIndex = path.indexOf("?");
    const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
    const params = new URLSearchParams(queryIndex === -1 ? "" : path.slice(queryIndex + 1));
    for (const filter of filters || []) {
      appendDashboardFilter(params, filter);
    }
    const serialized = params.toString();
    return serialized ? `${pathname}?${serialized}` : pathname;
  }

  async function loadDataContext(dashboardSpec) {
    const context = {};

    await Promise.all(
      dashboardSpec.dataSources.map(async (source) => {
        const requestPath = buildDataSourceUrl(source.path, source.filters);
        const response = await fetch(requestPath);
        if (!response.ok) {
          throw new Error(`Failed to load ${requestPath}: ${response.status} ${await readErrorBody(response)}`);
        }
        const payload = await response.json();
        context[source.id] = Array.isArray(payload.data) ? payload.data : [];
      })
    );

    for (const transform of dashboardSpec.transforms) {
      if (transform.type === "join") {
        const left = resolveDatasetRows(context, dashboardSpec, transform.left || transform.source);
        const right = resolveDatasetRows(context, dashboardSpec, transform.right);
        context[transform.id] = joinRows(left, right, transform.leftKey || "", transform.rightKey || "");
        continue;
      }

      if (transform.type === "deriveDateBucket") {
        const source = resolveDatasetRows(context, dashboardSpec, transform.source);
        const dateField = transform.dateField || "order_date";
        const bucketField = `${dateField}_${transform.grain || "month"}`;
        context[transform.id] = source.map((row) => ({
          ...row,
          date_bucket: formatDateBucket(row[dateField], transform.grain || "month"),
          [bucketField]: formatDateBucket(row[dateField], transform.grain || "month")
        }));
        continue;
      }

      if (transform.type === "groupBy") {
        context[transform.id] = groupRows(resolveDatasetRows(context, dashboardSpec, transform.source), transform.groupBy || [], transform.metrics || []);
        continue;
      }

      if (transform.type === "sort" || transform.type === "topN") {
        const baseRows = resolveDatasetRows(context, dashboardSpec, transform.source);
        const source = transform.groupBy?.length || transform.metrics?.length
          ? groupRows(baseRows, transform.groupBy || [], transform.metrics || [])
          : [...baseRows];
        const sortBy = chooseSortField(source, transform.sortBy, transform.metrics?.[0]?.id);
        const direction = transform.direction || "desc";
        const limit = resolveTransformLimit(transform, source.length);
        context[transform.id] = source.sort((left, right) => compareValues(left[sortBy], right[sortBy], direction)).slice(0, limit);
      }
    }

    return context;
  }

  function renderWidgetShell(widget) {
    return `
      <article class="dashboard-spec-widget" data-widget-id="${escapeHtml(widget.id)}" style="grid-column: span ${getWidgetColumnSpan(widget.size)};">
        <header>
          <h2>${escapeHtml(widget.title)}</h2>
          ${widget.description ? `<p>${escapeHtml(widget.description)}</p>` : ""}
        </header>
        <div class="dashboard-spec-widget-body">Loading...</div>
      </article>
    `;
  }

  function renderWidget(container, widget, rows) {
    if (widget.type === "kpi") return renderKpi(container, widget, rows);
    if (widget.type === "table") return renderTable(container, widget, rows);
    return renderChart(container, widget, rows);
  }

  function renderKpi(container, widget, rows) {
    const metric = widget.metric;
    const value = metric ? aggregateRows(rows, metric.aggregate, metric.field || metric.id) : rows.length;
    container.innerHTML = `<div class="dashboard-kpi-value">${formatNumber(value)}</div>${metric?.label ? `<div class="dashboard-kpi-label">${escapeHtml(metric.label)}</div>` : ""}`;
  }

  function renderChart(container, widget, rows) {
    if (!ChartConstructor) {
      container.innerHTML = `<p class="description">Chart.js failed to load.</p>`;
      return;
    }
    if (rows.length === 0) {
      container.innerHTML = `<p class="description">No rows available for this chart.</p>`;
      return;
    }

    const labelField = chooseLabelField(rows, widget.x || widget.labelField);
    const valueField = chooseValueField(rows, widget.y || widget.valueField || widget.metric?.id);
    const seriesField = resolveSeriesField(widget, rows, labelField);

    if (!hasChartValues(rows, valueField)) {
      const requested = widget.y || widget.valueField || widget.metric?.id || "auto";
      container.innerHTML = `<p class="description">No numeric values found for this chart. Check widget field mappings (y: ${escapeHtml(requested)}).</p>`;
      return;
    }

    const isPieLike = widget.type === "pieChart";
    const chartType = widget.type === "lineChart" ? "line" : isPieLike ? "doughnut" : "bar";
    const chartData = seriesField
      ? buildMultiSeriesChartData(rows, labelField, valueField, seriesField)
      : {
          labels: rows.map((row, index) => String(row[labelField] ?? `#${index + 1}`)),
          datasets: [{
            label: widget.title,
            data: rows.map((row) => toNumber(row[valueField])),
            borderColor: "#2563eb",
            backgroundColor: chartType === "pie" ? palette(rows.length) : "#60a5fa",
            tension: 0.25
          }]
        };

    const canvas = document.createElement("canvas");
    container.replaceChildren(canvas);

    new ChartConstructor(canvas, {
      type: chartType,
      data: {
        labels: chartData.labels,
        datasets: chartData.datasets.map((dataset) => styleChartDataset(dataset, chartType, chartData.labels.length))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        ...(isPieLike ? { cutout: String(widget.options?.cutout || "55%") } : {}),
        plugins: { legend: { display: isPieLike || Boolean(seriesField) } }
      }
    });
  }

  function styleChartDataset(dataset, chartType, labelCount) {
    if (chartType !== "doughnut" && chartType !== "pie") {
      return { ...dataset, tension: 0.25 };
    }
    const sliceCount = dataset.data.length || labelCount;
    const colors = Array.isArray(dataset.backgroundColor) && dataset.backgroundColor.length === sliceCount
      ? dataset.backgroundColor
      : palette(sliceCount);
    return { ...dataset, backgroundColor: colors, borderColor: "#ffffff", borderWidth: 1 };
  }

  function resolveSeriesField(widget, rows, labelField) {
    const requested = widget.series || (typeof widget.options?.series === "string" ? widget.options.series : undefined);
    if (requested) {
      const resolved = chooseLabelField(rows, requested);
      return resolved || undefined;
    }
    if (widget.type !== "lineChart" && widget.type !== "barChart") return undefined;
    if (!isTemporalGroupField(labelField)) return undefined;
    const candidates = ["category_name", "brand", "sub_category_name", "country", "country_full", "product_name", "store_key"];
    return candidates.find((field) => {
      if (field === labelField) return false;
      const values = rows.map((row) => String(row[field] ?? "").trim()).filter(Boolean);
      return values.length > 0 && new Set(values).size > 1;
    });
  }

  function buildMultiSeriesChartData(rows, labelField, valueField, seriesField) {
    const labels = Array.from(new Set(rows.map((row) => String(row[labelField] ?? "")).filter(Boolean))).sort((left, right) => compareValues(left, right, "asc"));
    const seriesNames = Array.from(new Set(rows.map((row) => String(row[seriesField] ?? "")).filter(Boolean))).sort((left, right) => compareValues(left, right, "asc"));
    const colors = palette(seriesNames.length);
    return {
      labels,
      datasets: seriesNames.map((seriesName, index) => ({
        label: seriesName,
        data: labels.map((label) => {
          const match = rows.find((row) => String(row[labelField] ?? "") === label && String(row[seriesField] ?? "") === seriesName);
          return toNumber(match?.[valueField]);
        }),
        borderColor: colors[index],
        backgroundColor: colors[index]
      }))
    };
  }

  function renderTable(container, widget, rows) {
    const columns = widget.columns?.length ? widget.columns : Object.keys(rows[0] || {}).slice(0, 6);
    if (rows.length === 0 || columns.length === 0) {
      container.innerHTML = `<p class="description">No rows available.</p>`;
      return;
    }
    container.innerHTML = `
      <div class="dashboard-table-wrap">
        <table class="dashboard-table">
          <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
          <tbody>${rows.slice(0, 50).map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(formatCell(row[column]))}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
      </div>
    `;
  }

  function resolveDatasetRows(context, dashboardSpec, key) {
    if (!key) return [];
    if (context[key]) return context[key];
    const source = dashboardSpec.dataSources.find((entry) => entry.id === key || entry.table === key);
    return source ? context[source.id] || [] : [];
  }

  function joinRows(left, right, leftKey, rightKey) {
    if (left.length === 0 || right.length === 0) return left;
    const rightIndex = new Map();
    for (const row of right) {
      const key = normalizeJoinKey(row[rightKey]);
      if (key) rightIndex.set(key, row);
    }
    return left.map((row) => {
      const joinValue = row[leftKey];
      if (joinValue === undefined || joinValue === null || String(joinValue).trim() === "") return row;
      const merged = { ...row, ...(rightIndex.get(normalizeJoinKey(joinValue)) || {}) };
      if (/^\d{4}-\d{2}$/.test(String(row.month || ""))) merged.month = row.month;
      if (/^\d{4}-\d{2}$/.test(String(row.date_bucket || ""))) merged.date_bucket = row.date_bucket;
      return merged;
    });
  }

  function normalizeJoinKey(value) {
    if (value === undefined || value === null) return "";
    const date = new Date(String(value));
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
    return String(value);
  }

  function groupRows(rows, fields, metrics) {
    const grouped = new Map();
    for (const row of rows) {
      const key = fields.map((field) => resolveGroupValue(row, field)).join("\u0001");
      grouped.set(key, [...(grouped.get(key) || []), row]);
    }
    return Array.from(grouped.entries()).map(([key, group]) => {
      const output = {};
      key.split("\u0001").forEach((value, index) => {
        output[fields[index]] = value;
      });
      for (const metric of metrics) {
        output[metric.id] = aggregateRows(group, metric.aggregate, metric.field || metric.id);
      }
      return output;
    }).sort((left, right) => compareValues(left[fields[0]], right[fields[0]], "asc"));
  }

  function aggregateRows(rows, aggregate, field) {
    if (aggregate === "count_distinct" && field) {
      return new Set(rows.map((row) => String(row[field] ?? "")).filter(Boolean)).size;
    }
    if (aggregate === "count") {
      const metricField = resolveMetricField(rows, field);
      if (metricField) {
        const hasValues = rows.some((row) => {
          const value = row[metricField];
          return value !== undefined && value !== null && String(value).trim() !== "";
        });
        if (hasValues) {
          return rows.reduce((sum, row) => sum + toNumber(row[metricField]), 0);
        }
      }
      return rows.length;
    }
    const metricField = resolveMetricField(rows, field);
    const values = rows.map((row) => toNumber(metricField ? row[metricField] : undefined));
    if (aggregate === "avg") return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
    if (aggregate === "min") return Math.min(...values);
    if (aggregate === "max") return Math.max(...values);
    return values.reduce((sum, value) => sum + value, 0);
  }

  function compareValues(left, right, direction) {
    const comparison = String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true });
    return direction === "desc" ? comparison * -1 : comparison;
  }

  function resolveMetricField(rows, requested) {
    if (!requested) return undefined;
    const candidates = [
      requested,
      `sum_${requested}`,
      `avg_${requested}`,
      `min_${requested}`,
      `max_${requested}`,
      `count_${requested}`,
      `count_distinct_${requested}`
    ];
    return candidates.find((candidate) => rows.some((row) => isNumericValue(row[candidate])));
  }

  function hasChartValues(rows, valueField) {
    return Boolean(valueField) && rows.some((row) => isNumericValue(row[valueField]));
  }

  function chooseSortField(rows, requested, fallback) {
    return resolveMetricField(rows, requested) || resolveMetricField(rows, fallback) || firstNumericField(rows) || "";
  }

  function chooseValueField(rows, requested) {
    return resolveMetricField(rows, requested) || firstNumericField(rows) || "";
  }

  function chooseLabelField(rows, requested) {
    if (requested && rows.some((row) => row[requested] !== undefined && String(row[requested] ?? "").trim() !== "")) return requested;
    return firstLabelField(rows) || "";
  }

  function firstLabelField(rows) {
    const sample = rows.find((row) => Object.keys(row).length > 0);
    if (!sample) return undefined;
    const keys = Object.keys(sample);
    const preferred = keys.find((key) => /date_bucket|bucket|month|quarter|year|date/i.test(key) && sample[key] !== undefined);
    if (preferred) return preferred;
    return keys.find((key) => typeof sample[key] === "string") || keys.find((key) => typeof sample[key] !== "number");
  }

  function firstNumericField(rows) {
    const keys = new Set();
    for (const row of rows) {
      for (const key of Object.keys(row)) keys.add(key);
    }
    const ordered = Array.from(keys);
    const metricKey = ordered.find(
      (key) => /^(sum_|avg_|min_|max_|count_distinct_|count$)/i.test(key) && rows.some((row) => isNumericValue(row[key]))
    );
    if (metricKey) return metricKey;
    return ordered.find((key) => !isDimensionField(key) && rows.some((row) => isNumericValue(row[key])));
  }

  function formatDateBucket(value, grain) {
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return "unknown";
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    if (grain === "year") return String(year);
    if (grain === "quarter") return `${year}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
    if (grain === "day") return `${year}-${month}-${String(date.getUTCDate()).padStart(2, "0")}`;
    return `${year}-${month}`;
  }

  function resolveGroupValue(row, field) {
    const existing = row[field];
    const grain = inferGroupGrain(field);
    const dateValue = findDateValue(row);

    if (existing !== undefined && existing !== null && String(existing).trim() !== "") {
      const existingText = String(existing);
      if (grain && dateValue && isMonthName(existingText)) return formatDateBucket(dateValue, grain);
      if (field === "order_date" || (grain && looksLikeIsoDate(existingText))) return formatDateBucket(existing, grain);
      if (/^\d{4}-\d{2}$/.test(existingText) || /^\d{4}$/.test(existingText) || /^\d{4}-Q\d$/.test(existingText)) return existingText;
      if (!grain) return existingText;
    }

    if (!dateValue) return "unknown";
    return formatDateBucket(dateValue, grain || "month");
  }

  function resolveTransformLimit(transform, sourceLength) {
    const requested = transform.limit || (transform.type === "topN" ? 10 : sourceLength);
    if (transform.type !== "topN") return requested;
    const groupFields = transform.groupBy || [];
    if (groupFields.some(isTemporalGroupField) && requested < 12) return sourceLength;
    if (groupFields.some(isCategoricalGroupField) && requested < 8) return Math.min(sourceLength, 50);
    return requested;
  }

  function isTemporalGroupField(field) {
    return /^(date_bucket|year_month|month|quarter|year|day|week|order_date|.*_date)$/i.test(field);
  }

  function isCategoricalGroupField(field) {
    return /^(country|country_code|country_name|country_full|category_name|brand|gender|occupation|product_name|currency_code|store_key|customer_key|product_key)$/i.test(field);
  }

  function inferGroupGrain(field) {
    if (/year_month|date_bucket|^month$/i.test(field)) return "month";
    if (/quarter/i.test(field)) return "quarter";
    if (/^year$/i.test(field)) return "year";
    if (/^day$|^date$/i.test(field)) return "day";
    if (field === "order_date" || /_date$/.test(field)) return "month";
    return undefined;
  }

  function looksLikeIsoDate(value) {
    return /^\d{4}-\d{2}-\d{2}/.test(value) || value.includes("T");
  }

  function isMonthName(value) {
    return /^(January|February|March|April|May|June|July|August|September|October|November|December)$/i.test(value);
  }

  function findDateValue(row) {
    const preferred = ["order_date", "date", "delivery_date", "created_at", "createdAt"];
    const preferredKey = preferred.find((key) => row[key] !== undefined && !Number.isNaN(new Date(String(row[key])).getTime()));
    if (preferredKey) return row[preferredKey];
    const dateKey = Object.keys(row).find((key) => /date/i.test(key) && !Number.isNaN(new Date(String(row[key])).getTime()));
    return dateKey ? row[dateKey] : undefined;
  }

  function getWidgetColumnSpan(size) {
    if (size === "small") return 3;
    if (size === "medium") return 6;
    return 12;
  }

  function isNumericValue(value) {
    if (value === undefined || value === null) return false;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") return false;
      return Number.isFinite(Number(trimmed));
    }
    return false;
  }

  function isDimensionField(key) {
    return /^(country|region|category|brand|segment|channel|month|year|quarter|date_bucket)$/i.test(key)
      || /_key$/i.test(key)
      || /name$/i.test(key);
  }

  function toNumber(value) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  }

  function formatCell(value) {
    return typeof value === "number" ? formatNumber(value) : String(value ?? "");
  }

  function palette(count) {
    const colors = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2", "#db2777"];
    return Array.from({ length: count }, (_, index) => colors[index % colors.length]);
  }

  async function readErrorBody(response) {
    try {
      const payload = await response.json();
      return payload?.error || JSON.stringify(payload);
    } catch {
      return response.statusText;
    }
  }

  function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/"/g, '\\"');
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();

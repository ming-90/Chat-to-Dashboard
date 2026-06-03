import {
  generateDashboardSpec,
  generateReport,
  getPublishedReport,
  listPublishedReports,
  publishDashboard,
  sendAnalysisChat,
  updatePublishedDashboard,
  type PublishedReportSummary
} from "./domain/reportApi";
import { attachSandboxApiProxy, renderSandbox } from "./domain/sandbox";
import { renderDashboard } from "./domain/dashboardRenderer";
import type { DashboardSpec } from "./domain/dashboardSpec";
import type { ChatMessage, GeneratedReport } from "./domain/types";
import "./styles/main.css";

const defaultPrompt =
  "Show revenue by product as a bar chart. Use the latest order data from the CRUD APIs.";

let currentReport: GeneratedReport | undefined;
let publishedUrl: string | undefined;
let chatMessages: ChatMessage[] = [
  {
    role: "assistant",
    content:
      "어떤 분석을 보고 싶은지 편하게 말해주세요. 지표, 기간, 비교 기준, 필터, 차트 형태를 같이 정리한 뒤 draft preview로 확인하고, 마음에 들면 Publish로 저장 링크를 만들 수 있습니다."
  }
];
let latestReportPrompt = defaultPrompt;
let publishedReports: PublishedReportSummary[] = [];
let editingPublishedId: string | undefined;

attachSandboxApiProxy();
void bootstrap();

async function bootstrap(): Promise<void> {
  await refreshPublishedReports();
  renderApp();
}

function renderApp(): void {
  const app = document.querySelector<HTMLDivElement>("#app");

  if (!app) {
    throw new Error("App root not found.");
  }

  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <section class="panel">
          <div class="panel-section">
            <h1 class="title">chat-to-dashboard</h1>
            <p class="description">
              Chat through the analysis, generate draft previews, then publish the version you want to keep.
            </p>
          </div>
          <div class="panel-section">
            <label for="chat-input"><strong>Analysis chat</strong></label>
            <div id="chat-log" class="chat-log">${renderChatMessages()}</div>
            <textarea id="chat-input" class="prompt" placeholder="예: 월별 매출 추이를 상품 카테고리별로 비교하고 싶어"></textarea>
            <div class="actions">
              <button id="send-chat" class="button">Send</button>
              <button id="generate" class="button secondary" ${canGenerateFromChat() ? "" : "disabled"}>Generate draft preview</button>
              <button id="save" class="button secondary" ${currentReport?.dashboardSpec ? "" : "disabled"}>${editingPublishedId ? "Update published" : "Publish link"}</button>
              ${editingPublishedId ? `<button id="cancel-edit" class="button secondary">Cancel edit</button>` : ""}
            </div>
            <p class="description" style="margin-top: 10px;">
              ${editingPublishedId ? "Editing a published page. Update saves the same link." : "Draft previews are temporary. Publishing saves the current draft and creates a stable link."}
            </p>
          </div>
          <div class="panel-section">
            <h2 class="title">Published pages</h2>
            <ul class="published-list">
              ${renderPublishedReports()}
            </ul>
          </div>
        </section>
      </aside>
      <main class="main">
        <div class="preview-header">
          <div>
            <h2 class="title">${escapeHtml(renderPreviewTitle())}</h2>
            <p id="share-url" class="description">${renderShareText()}</p>
          </div>
          <button id="copy-link" class="button secondary" ${publishedUrl ? "" : "disabled"}>Copy link</button>
        </div>
        <section id="preview"></section>
        <section class="panel" style="margin-top: 16px;">
          <div class="panel-section">
            <h2 class="title">Generation details</h2>
            <p class="description">${renderApiSummary()}</p>
          </div>
          <div class="panel-section">
            <pre class="code">${escapeHtml(currentReport?.html ?? "Generate a draft preview to inspect the generated HTML + JavaScript.")}</pre>
          </div>
        </section>
      </main>
    </div>
  `;

  bindEvents();
  renderCurrentPreview();
  scrollChatToBottom();
}

function bindEvents(): void {
  document.querySelector<HTMLButtonElement>("#send-chat")?.addEventListener("click", async () => {
    await sendChatMessage();
  });

  document.querySelector<HTMLTextAreaElement>("#chat-input")?.addEventListener("keydown", async (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      await sendChatMessage();
    }
  });

  document.querySelector<HTMLButtonElement>("#generate")?.addEventListener("click", async () => {
    await createReportFromChat();
  });

  document.querySelector<HTMLButtonElement>("#save")?.addEventListener("click", async () => {
    if (!currentReport?.dashboardSpec) {
      return;
    }

    const button = document.querySelector<HTMLButtonElement>("#save");

    if (button) {
      button.disabled = true;
      button.textContent = "Publishing...";
    }

    if (editingPublishedId) {
      const updated = await updatePublishedDashboard(
        editingPublishedId,
        currentReport.title,
        currentReport.dashboardSpec
      );
      publishedUrl = updated.url;
    } else {
      const published = await publishDashboard(currentReport.title, currentReport.dashboardSpec);
      publishedUrl = published.url;
    }

    await refreshPublishedReports();
    renderApp();
  });

  document.querySelector<HTMLButtonElement>("#cancel-edit")?.addEventListener("click", () => {
    editingPublishedId = undefined;
    currentReport = undefined;
    publishedUrl = undefined;
    renderApp();
  });

  document.querySelector<HTMLButtonElement>("#copy-link")?.addEventListener("click", async () => {
    if (!publishedUrl) {
      return;
    }

    await navigator.clipboard.writeText(new URL(publishedUrl, window.location.origin).toString());
  });

  document.querySelectorAll<HTMLButtonElement>("[data-edit-report]").forEach((button) => {
    button.addEventListener("click", async () => {
      const reportId = button.dataset.editReport;

      if (!reportId) {
        return;
      }

      await loadPublishedReportForEdit(reportId);
    });
  });

}

async function sendChatMessage(): Promise<void> {
  const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
  const content = input?.value.trim() ?? "";

  if (!content) {
    return;
  }

  chatMessages = [...chatMessages, { role: "user", content }];
  if (input) {
    input.value = "";
  }

  renderApp();

  const sendButton = document.querySelector<HTMLButtonElement>("#send-chat");

  if (sendButton) {
    sendButton.disabled = true;
    sendButton.textContent = "Thinking...";
  }

  const response = await sendAnalysisChat({
    messages: chatMessages,
    currentDashboardSpec: currentReport?.dashboardSpec
  });
  chatMessages = [...chatMessages, { role: "assistant", content: response.message }];
  latestReportPrompt = response.reportPrompt || buildReportPromptFromChat();

  if (response.readyToGenerate || shouldGenerateFromMessage(content)) {
    await createReportFromChat();
    return;
  }

  renderApp();
}

async function createReportFromChat(): Promise<void> {
  if (!canGenerateFromChat()) {
    return;
  }

  const prompt = buildGenerationPrompt();
  const button = document.querySelector<HTMLButtonElement>("#generate");

  if (button) {
    button.disabled = true;
    button.textContent = "Generating...";
  }

  try {
    const dashboardSpec = await generateDashboardSpec({ prompt });
    currentReport = createReportFromDashboardSpec(prompt, dashboardSpec);
  } catch (error) {
    console.warn("Falling back to legacy HTML report generation.", error);
    currentReport = await generateReport({ prompt });
  }

  if (!editingPublishedId) {
    publishedUrl = undefined;
  }

  renderApp();
}

async function loadPublishedReportForEdit(reportId: string): Promise<void> {
  let report;

  try {
    report = await getPublishedReport(reportId);
  } catch (error) {
    alert(error instanceof Error ? error.message : "Failed to load published report.");
    return;
  }

  editingPublishedId = report.id;
  publishedUrl = report.url;
  currentReport = createReportFromDashboardSpec(
    `Edit published dashboard ${report.title}.`,
    report.dashboardSpec
  );
  chatMessages = [
    ...chatMessages,
    {
      role: "assistant",
      content: `"${report.title}" 페이지를 불러왔습니다. 채팅으로 수정한 뒤 Update published를 누르세요.`
    }
  ];
  latestReportPrompt = buildReportPromptFromChat();
  renderApp();
  await renderCurrentPreview();
}

function createReportFromDashboardSpec(prompt: string, dashboardSpec: DashboardSpec): GeneratedReport {
  return {
    title: dashboardSpec.title,
    prompt,
    chartType: "dashboard",
    html: JSON.stringify(dashboardSpec, null, 2),
    apiCalls: dashboardSpec.dataSources.map((source) => ({
      table: source.table,
      path: source.path,
      reason: source.description ?? `Load ${source.table} data for dashboard.`
    })),
    createdAt: new Date().toISOString(),
    dashboardSpec
  };
}

function renderChatMessages(): string {
  return chatMessages
    .map(
      (message) => `
        <article class="chat-message ${message.role}">
          <strong>${message.role === "assistant" ? "Assistant" : "You"}</strong>
          <p>${escapeHtml(message.content)}</p>
        </article>
      `
    )
    .join("");
}

function scrollChatToBottom(): void {
  requestAnimationFrame(() => {
    const chatLog = document.querySelector<HTMLElement>("#chat-log");

    if (!chatLog) {
      return;
    }

    chatLog.scrollTop = chatLog.scrollHeight;
  });
}

function canGenerateFromChat(): boolean {
  return chatMessages.some((message) => message.role === "user") || latestReportPrompt !== defaultPrompt;
}

function buildReportPromptFromChat(): string {
  const conversation = chatMessages.map((message) => `${message.role}: ${message.content}`).join("\n");

  return [
    "Create a dashboard analytics report from this confirmed conversation.",
    "Only use registered CRUD APIs and load fresh data at view time.",
    conversation
  ].join("\n");
}

function buildGenerationPrompt(): string {
  const requestedChange = latestReportPrompt || buildReportPromptFromChat();

  if (!currentReport?.dashboardSpec) {
    return requestedChange;
  }

  return [
    "Revise the existing dashboard spec according to the user's latest request.",
    "Preserve existing dataSources, transforms, and widgets unless the user explicitly asks to remove or replace them.",
    "If the user asks to add a statistic, chart, table, filter, or KPI, append the needed transforms/widgets to the existing dashboard.",
    "Keep existing widget ids stable when possible.",
    "",
    "Existing dashboardSpec:",
    JSON.stringify(currentReport.dashboardSpec, null, 2),
    "",
    "Latest user request and conversation summary:",
    requestedChange
  ].join("\n");
}

function isConfirmation(value: string): boolean {
  return /^(ok|okay|yes|go|좋아|오케이|ㅇㅋ|생성|만들어|진행)/i.test(value.trim());
}

function shouldGenerateFromMessage(value: string): boolean {
  if (isConfirmation(value)) {
    return true;
  }

  if (!currentReport?.dashboardSpec) {
    return false;
  }

  return /(추가|넣어|포함|더\s*보여|보여줘|바꿔|변경|수정|삭제|제거|add|include|show|change|update|remove)/i.test(value);
}

function renderCurrentPreview(): void {
  const preview = document.querySelector<HTMLElement>("#preview");

  if (!preview) {
    return;
  }

  if (!currentReport) {
    preview.innerHTML = `
      <div class="panel">
        <div class="panel-section">
          <h2 class="title">No draft yet</h2>
          <p class="description">Chat through the request, then generate a draft preview to inspect the page before publishing.</p>
        </div>
      </div>
    `;
    return;
  }

  if (currentReport.dashboardSpec) {
    renderDashboard(preview, currentReport.dashboardSpec).catch((error) => {
      preview.innerHTML = `
        <div class="panel">
          <div class="panel-section">
            <h2 class="title">Dashboard render failed</h2>
            <p class="description">${escapeHtml(error instanceof Error ? error.message : "Unknown render error")}</p>
          </div>
        </div>
      `;
    });
    return;
  }

  renderSandbox(preview, currentReport.html);
}

function renderPublishedReports(): string {
  if (publishedReports.length === 0) {
    return `<li class="published-empty">No published pages yet.</li>`;
  }

  return publishedReports
    .map(
      (report) => `
        <li class="published-item ${editingPublishedId === report.id ? "is-editing" : ""}">
          <div class="published-item-main">
            <strong class="published-title">${escapeHtml(report.title)}</strong>
            <time class="published-date" datetime="${escapeHtml(report.updatedAt)}">${escapeHtml(formatPublishedDate(report.updatedAt))}</time>
          </div>
          <div class="published-actions">
            <button type="button" class="button secondary" data-edit-report="${escapeHtml(report.id)}">Edit</button>
            <a class="button secondary published-open" href="${escapeHtml(report.url)}" target="_blank" rel="noopener noreferrer">Open</a>
          </div>
        </li>
      `
    )
    .join("");
}

async function refreshPublishedReports(): Promise<void> {
  try {
    publishedReports = await listPublishedReports();
  } catch (error) {
    console.warn("Failed to load published reports.", error);
    publishedReports = [];
  }
}

function formatPublishedDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function renderShareText(): string {
  if (!publishedUrl) {
    return currentReport
      ? "Draft preview. Publish it to create a stable report link."
      : "No draft yet. Generate a draft preview from the chat.";
  }

  if (editingPublishedId) {
    return `Editing published link: ${new URL(publishedUrl, window.location.origin).toString()}`;
  }

  return `Published link: ${new URL(publishedUrl, window.location.origin).toString()}`;
}

function renderPreviewTitle(): string {
  if (!currentReport) {
    return "Draft Preview";
  }

  if (editingPublishedId) {
    return `${currentReport.title} (editing)`;
  }

  return publishedUrl ? currentReport.title : `${currentReport.title} (draft)`;
}

function renderApiSummary(): string {
  if (!currentReport) {
    return "The generator will show selected CRUD API calls here.";
  }

  return currentReport.apiCalls
    .map((call) => `${call.path} (${call.reason})`)
    .join(" ");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

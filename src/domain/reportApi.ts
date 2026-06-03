import { generateReport as generateLocalReport } from "./generator";
import type { DashboardSpec } from "./dashboardSpec";
import type { AnalysisChatRequest, AnalysisChatResponse, AnalysisRequest, GeneratedReport } from "./types";

export interface PublishDashboardResponse {
  id: string;
  url: string;
}

export interface PublishedReportSummary {
  id: string;
  title: string;
  url: string;
  updatedAt: string;
}

export async function sendAnalysisChat(request: AnalysisChatRequest): Promise<AnalysisChatResponse> {
  try {
    const response = await fetch("/api/analysis-chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`Analysis chat failed with status ${response.status}`);
    }

    return (await response.json()) as AnalysisChatResponse;
  } catch (error) {
    console.warn("Falling back to local analysis chat.", error);
    return createLocalChatResponse(request);
  }
}

export async function generateReport(request: AnalysisRequest): Promise<GeneratedReport> {
  try {
    const response = await fetch("/api/generate-report", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`OpenAI generation failed with status ${response.status}`);
    }

    return (await response.json()) as GeneratedReport;
  } catch (error) {
    console.warn("Falling back to local report generator.", error);
    return generateLocalReport(request);
  }
}

export async function generateDashboardSpec(request: AnalysisRequest): Promise<DashboardSpec> {
  const response = await fetch("/api/generate-dashboard-spec", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new Error(`Dashboard spec generation failed with status ${response.status}`);
  }

  return (await response.json()) as DashboardSpec;
}

export async function publishDashboard(title: string, dashboardSpec: DashboardSpec): Promise<PublishDashboardResponse> {
  const response = await fetch("/api/publish-dashboard", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ title, dashboardSpec })
  });

  if (!response.ok) {
    throw new Error(`Publish failed with status ${response.status}`);
  }

  return (await response.json()) as PublishDashboardResponse;
}

export interface PublishedReportDetail extends PublishedReportSummary {
  dashboardSpec: DashboardSpec;
}

export async function getPublishedReport(reportId: string): Promise<PublishedReportDetail> {
  const response = await fetch(`/api/published-reports/${encodeURIComponent(reportId)}`);

  if (!response.ok) {
    let detail = `status ${response.status}`;

    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) {
        detail = payload.error;
      }
    } catch {
      // Ignore non-JSON error bodies.
    }

    throw new Error(`Failed to load published report: ${detail}`);
  }

  return (await response.json()) as PublishedReportDetail;
}

export async function updatePublishedDashboard(
  reportId: string,
  title: string,
  dashboardSpec: DashboardSpec
): Promise<PublishDashboardResponse & { title: string; updatedAt: string }> {
  const response = await fetch(`/api/published-reports/${encodeURIComponent(reportId)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ title, dashboardSpec })
  });

  if (!response.ok) {
    throw new Error(`Update failed with status ${response.status}`);
  }

  return (await response.json()) as PublishDashboardResponse & { title: string; updatedAt: string };
}

export async function listPublishedReports(): Promise<PublishedReportSummary[]> {
  const response = await fetch("/api/published-reports");

  if (!response.ok) {
    throw new Error(`Failed to load published reports with status ${response.status}`);
  }

  const payload = (await response.json()) as { reports?: PublishedReportSummary[] };
  return Array.isArray(payload.reports) ? payload.reports : [];
}

function createLocalChatResponse(request: AnalysisChatRequest): AnalysisChatResponse {
  const latestUserMessage = [...request.messages].reverse().find((message) => message.role === "user");
  const reportPrompt = request.messages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  if (latestUserMessage && (isConfirmation(latestUserMessage.content) || (request.currentDashboardSpec && isRevisionRequest(latestUserMessage.content)))) {
    return {
      message: request.currentDashboardSpec
        ? "좋습니다. 기존 대시보드는 유지하고 요청하신 내용을 추가/수정하겠습니다."
        : "좋습니다. 지금까지 정리한 요구사항으로 분석 페이지를 생성하겠습니다.",
      readyToGenerate: true,
      reportPrompt
    };
  }

  return {
    message:
      "요구사항을 더 구체화해볼게요. 보고 싶은 지표, 시간 단위, 비교 기준을 알려주세요. 준비되면 'OK' 또는 '생성해줘'라고 입력하면 페이지를 만들겠습니다.",
    readyToGenerate: false,
    reportPrompt
  };
}

function isConfirmation(value: string): boolean {
  return /^(ok|okay|yes|go|좋아|오케이|ㅇㅋ|생성|만들어|진행)/i.test(value.trim());
}

function isRevisionRequest(value: string): boolean {
  return /(추가|넣어|포함|더\s*보여|보여줘|바꿔|변경|수정|삭제|제거|add|include|show|change|update|remove)/i.test(value);
}

interface SandboxFetchRequest {
  type: "sandbox:fetch";
  requestId: string;
  path: string;
}

interface SandboxFetchResponse {
  type: "sandbox:fetch:response";
  requestId: string;
  ok: boolean;
  status: number;
  body: unknown;
}

export function renderSandbox(container: HTMLElement, html: string): void {
  const iframe = document.createElement("iframe");
  iframe.className = "preview-frame";
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.srcdoc = injectRuntime(html);

  container.replaceChildren(iframe);
}

export function attachSandboxApiProxy(): () => void {
  const listener = async (event: MessageEvent<SandboxFetchRequest>) => {
    if (!event.source || event.data?.type !== "sandbox:fetch") {
      return;
    }

    const response = await createResponse(event.data);
    event.source.postMessage(response, { targetOrigin: "*" });
  };

  window.addEventListener("message", listener);

  return () => window.removeEventListener("message", listener);
}

async function createResponse(request: SandboxFetchRequest): Promise<SandboxFetchResponse> {
  try {
    if (!request.path.startsWith("/api/")) {
      throw new Error(`Only registered CRUD API paths are allowed: ${request.path}`);
    }

    const apiResponse = await fetch(request.path);
    const body = await apiResponse.json();

    return {
      type: "sandbox:fetch:response",
      requestId: request.requestId,
      ok: apiResponse.ok,
      status: apiResponse.status,
      body
    };
  } catch (error) {
    return {
      type: "sandbox:fetch:response",
      requestId: request.requestId,
      ok: false,
      status: 400,
      body: {
        message: error instanceof Error ? error.message : "Unknown sandbox API error"
      }
    };
  }
}

function injectRuntime(html: string): string {
  const runtime = `
<script>
  (() => {
    const pending = new Map();

    window.fetch = (path) => {
      const requestId = crypto.randomUUID();
      const normalizedPath = String(path);

      return new Promise((resolve) => {
        pending.set(requestId, resolve);
        parent.postMessage({ type: "sandbox:fetch", requestId, path: normalizedPath }, "*");
      }).then((payload) => ({
        ok: payload.ok,
        status: payload.status,
        json: async () => payload.body
      }));
    };

    window.addEventListener("message", (event) => {
      if (event.data?.type !== "sandbox:fetch:response") {
        return;
      }

      const resolve = pending.get(event.data.requestId);
      if (!resolve) {
        return;
      }

      pending.delete(event.data.requestId);
      resolve(event.data);
    });
  })();
</script>`;

  return html.replace("</head>", `${runtime}</head>`);
}

const TIMEOUT_MS = 15_000;
const BASE_URL = "https://api.vapi.ai";

export class VapiApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`Vapi API error (${status})`);
    this.name = "VapiApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.VAPI_API_KEY ?? ""}`,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text.slice(0, 500);
    }

    if (!res.ok) {
      throw new VapiApiError(res.status, parsed);
    }

    return parsed as T;
  } finally {
    clearTimeout(timeout);
  }
}

export const vapiClient = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body }),
};

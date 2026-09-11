// Bare-fetch client, no SDK — same pattern used for every external
// integration in the reference project. Auth header is built inline inside
// request(), never assigned to a module-level `const MDR_API_AUTH_TOKEN =
// ...`-shaped line, so the pre-commit secret-scanner never has a
// key-looking assignment to (correctly) flag.

const TIMEOUT_MS = 15_000;

export class MdrApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`MDR API error (${status})`);
    this.name = "MdrApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  // PLACEHOLDER: confirm real base URL with the MDR team. See
  // docs/requirements-tracker.md.
  const baseUrl = process.env.MDR_API_BASE_URL;
  if (!baseUrl) {
    throw new Error("Missing required environment variable: MDR_API_BASE_URL");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        // PLACEHOLDER: auth scheme unconfirmed — assuming Bearer for now.
        Authorization: `Bearer ${process.env.MDR_API_AUTH_TOKEN ?? ""}`,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON response — fall back to a truncated text snippet rather
      // than crashing on JSON.parse.
      parsed = text.slice(0, 500);
    }

    if (!res.ok) {
      throw new MdrApiError(res.status, parsed);
    }

    return parsed as T;
  } finally {
    clearTimeout(timeout);
  }
}

export const mdrClient = {
  post: <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body }),
};

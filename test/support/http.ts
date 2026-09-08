/**
 * HTTP helpers for the ~20 cases that go through the network stack.
 *
 * `fetch` against a real listener rather than supertest: Node has had a global
 * fetch for several major versions, so this adds no dependency, and it exercises
 * the actual HTTP server — status codes, JSON serialisation and Nest exception
 * filters all included, which is the point of testing an endpoint at all.
 */
export interface JsonResponse<T = unknown> {
  status: number;
  body: T;
  /** Raw text, for asserting that something is absent from the whole payload. */
  text: string;
}

export async function getJson<T = unknown>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<JsonResponse<T>> {
  return request<T>(baseUrl, path, { method: 'GET', ...init });
}

export async function postJson<T = unknown>(
  baseUrl: string,
  path: string,
  body?: unknown,
): Promise<JsonResponse<T>> {
  return request<T>(baseUrl, path, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function request<T>(
  baseUrl: string,
  path: string,
  init: RequestInit,
): Promise<JsonResponse<T>> {
  const response = await fetch(new URL(path, baseUrl), init);
  const text = await response.text();

  let body: T;
  try {
    body = text ? (JSON.parse(text) as T) : (undefined as T);
  } catch {
    body = text as T;
  }

  return { status: response.status, body, text };
}

import { vi, type Mock } from "vitest";

export interface ApiFetchFixtureRequest {
  method: string;
  url: string;
  path: string;
  init?: RequestInit;
  body?: unknown;
}

export type ApiFetchFixtureHandler = (
  request: ApiFetchFixtureRequest,
) => Response | Promise<Response>;

export interface ApiFetchFixtureRoute {
  method?: string;
  path: string | RegExp;
  body?: unknown;
  status?: number;
  headers?: HeadersInit;
  handler?: ApiFetchFixtureHandler;
}

export interface ApiFetchFixture {
  fetch: Mock<typeof fetch>;
  requests: ApiFetchFixtureRequest[];
  restore(): void;
}

const TEST_API_ORIGIN = "http://symphony-web-fixture.local";

export function jsonApiResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
}

export function createApiFetchFixture(routes: ApiFetchFixtureRoute[]): ApiFetchFixture {
  const originalFetch = globalThis.fetch;
  const requests: ApiFetchFixtureRequest[] = [];
  const normalizedRoutes = routes.map((route) => ({
    ...route,
    method: (route.method ?? "GET").toUpperCase(),
  }));

  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const request = await normalizeRequest(input, init);
    requests.push(request);
    const route = normalizedRoutes.find((candidate) => routeMatches(candidate, request));
    if (!route) {
      throw new Error(`Unhandled test API fetch ${request.method} ${request.path}`);
    }
    if (route.handler) return route.handler(request);
    return jsonApiResponse(route.body ?? null, {
      status: route.status ?? 200,
      headers: route.headers,
    });
  });

  globalThis.fetch = fetchMock as typeof fetch;

  return {
    fetch: fetchMock,
    requests,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

export const installApiFetchFixture = createApiFetchFixture;

async function normalizeRequest(input: RequestInfo | URL, init?: RequestInit): Promise<ApiFetchFixtureRequest> {
  const requestInput = input instanceof Request ? input : null;
  const rawUrl = requestInput?.url ?? String(input);
  const method = (init?.method ?? requestInput?.method ?? "GET").toUpperCase();
  const url = new URL(rawUrl, TEST_API_ORIGIN);
  return {
    method,
    url: url.toString(),
    path: `${url.pathname}${url.search}`,
    init,
    body: await normalizeBody(init?.body ?? requestInput?.body ?? null),
  };
}

async function normalizeBody(body: BodyInit | ReadableStream<Uint8Array> | null | undefined): Promise<unknown> {
  if (!body) return null;
  if (typeof body === "string") return parseJsonIfPossible(body);
  if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
  if (body instanceof FormData) return Object.fromEntries(body.entries());
  if (body instanceof Blob) return parseJsonIfPossible(await body.text());
  return body;
}

function parseJsonIfPossible(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function routeMatches(route: ApiFetchFixtureRoute & { method: string }, request: ApiFetchFixtureRequest): boolean {
  if (route.method !== request.method) return false;
  if (typeof route.path === "string") return route.path === request.path;
  return route.path.test(request.path);
}

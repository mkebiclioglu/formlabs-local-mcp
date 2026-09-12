/**
 * Thin fetch wrapper around the PreFormServer HTTP API.
 *
 * Centralizes the base URL and timeouts, translates error responses into
 * PreFormError, and hides the `?async=true` + poll `/operations/{id}/` dance
 * behind postAsync / getAsync.
 */

import type { Config } from "./config.js";

export type Json = Record<string, unknown>;
export type ProgressCallback = (fraction: number) => Promise<void>;

export class PreFormError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    public readonly detail: string,
    public readonly body?: unknown,
  ) {
    super(`[${status}] ${code ?? "error"}: ${detail}`);
    this.name = "PreFormError";
  }
}

const READ_TIMEOUT_MS = 620_000; // PreFormServer caps blocking calls at 10 minutes.

export class PreFormClient {
  private ready = false;
  private readying: Promise<void> | undefined;

  constructor(
    private readonly config: Config,
    /**
     * Runs once before the first HTTP call. The server uses it to start
     * PreFormServer lazily, so the MCP handshake is instant and a missing
     * PreFormServer surfaces as a tool error the model can explain.
     */
    private readonly beforeFirstRequest?: () => Promise<void>,
  ) {}

  /** Forget readiness so the next request re-runs beforeFirstRequest (used after a connection failure). */
  reset(): void {
    this.ready = false;
    this.readying = undefined;
  }

  async ensureReady(): Promise<void> {
    if (this.ready || !this.beforeFirstRequest) return;
    if (!this.readying) {
      this.readying = this.beforeFirstRequest().then(
        () => {
          this.ready = true;
        },
        (err) => {
          this.readying = undefined;
          throw err;
        },
      );
    }
    await this.readying;
  }

  async request(method: string, path: string, body?: unknown, params?: Record<string, string>): Promise<unknown> {
    await this.ensureReady();
    const url = new URL(this.config.baseUrl + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    let resp: Response;
    try {
      const init: RequestInit = { method, signal: AbortSignal.timeout(READ_TIMEOUT_MS) };
      if (body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      resp = await fetch(url, init);
    } catch (err) {
      this.reset(); // PreFormServer may have died; the next call restarts it
      throw new PreFormError(0, "CONNECTION_FAILED", `PreFormServer at ${this.config.baseUrl} did not answer (${(err as Error).message}). It may have crashed; the next call will restart it.`);
    }
    return handle(resp);
  }

  get(path: string, params?: Record<string, string>): Promise<unknown> {
    return this.request("GET", path, undefined, params);
  }
  post(path: string, body: unknown = {}, params?: Record<string, string>): Promise<unknown> {
    return this.request("POST", path, body, params);
  }
  put(path: string, body: unknown): Promise<unknown> {
    return this.request("PUT", path, body);
  }
  delete(path: string): Promise<unknown> {
    return this.request("DELETE", path);
  }

  /** POST with ?async=true, then poll until the operation finishes. */
  postAsync(path: string, body: unknown = {}, progress?: ProgressCallback): Promise<unknown> {
    return this.asyncOperation("POST", path, body, progress);
  }

  /** GET with ?async=true (validation endpoints), then poll until done. */
  getAsync(path: string, progress?: ProgressCallback): Promise<unknown> {
    return this.asyncOperation("GET", path, undefined, progress);
  }

  private async asyncOperation(method: string, path: string, body: unknown, progress?: ProgressCallback): Promise<unknown> {
    const accepted = await this.request(method, path, body, { async: "true" });
    const opId = isRecord(accepted) ? (accepted["operationId"] ?? accepted["operation_id"]) : undefined;
    if (typeof opId !== "string" || !opId) return accepted; // server answered synchronously
    return this.pollOperation(opId, progress);
  }

  async pollOperation(operationId: string, progress?: ProgressCallback): Promise<unknown> {
    const deadline = Date.now() + this.config.pollTimeoutMs;
    let last = -1;
    for (;;) {
      const op = (await this.get(`/operations/${operationId}/`)) as Json;
      const status = op["status"];
      const fraction = Number(op["progress"] ?? 0);
      if (progress && fraction !== last) {
        try {
          await progress(fraction);
        } catch {
          /* progress is best effort */
        }
        last = fraction;
      }
      if (status === "SUCCEEDED") return op["result"] ?? null;
      if (status === "FAILED") {
        const err = isRecord(op["result"]) ? op["result"]["error"] : undefined;
        const code = isRecord(err) ? String(err["code"] ?? "") || undefined : undefined;
        const message = isRecord(err) ? String(err["message"] ?? "Operation failed") : "Operation failed";
        throw new PreFormError(500, code, message, op);
      }
      if (Date.now() > deadline) {
        throw new PreFormError(408, "OPERATION_TIMEOUT", `Operation ${operationId} did not complete within ${this.config.pollTimeoutMs / 1000}s`);
      }
      await new Promise((r) => setTimeout(r, this.config.pollIntervalMs));
    }
  }
}

export function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function handle(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (resp.ok) {
    if (resp.status === 204 || text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  let code: string | undefined;
  let message = text;
  let body: unknown;
  try {
    body = JSON.parse(text);
    const err = isRecord(body) ? body["error"] : undefined;
    if (isRecord(err)) {
      code = typeof err["code"] === "string" ? err["code"] : undefined;
      message = typeof err["message"] === "string" ? err["message"] : message;
    }
  } catch {
    /* not JSON */
  }
  throw new PreFormError(resp.status, code, message, body);
}

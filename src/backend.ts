/**
 * A backend owns the PreFormServer process (or the tunnel to one) and maps
 * file paths between this machine and the one PreFormServer runs on.
 */
export interface Backend {
  readonly mode: "local" | "remote";
  ensureRunning(): Promise<void>;
  shutdown(): Promise<void>;
  /** Make a validated local input file visible to PreFormServer; returns the path to send. */
  stageInput(localPath: string): Promise<string>;
  /** Path PreFormServer should write to for a validated local output file. */
  outputPath(localPath: string): Promise<string>;
  /** After PreFormServer wrote the output, make sure it exists at the local path. */
  collectOutput(localPath: string): Promise<void>;
}

export async function waitUntilReachable(baseUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const resp = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(5000) });
      if (resp.status < 500) return;
    } catch {
      /* not yet */
    }
    if (signal?.aborted) throw new Error("Aborted while waiting for PreFormServer");
    if (Date.now() > deadline) throw new Error(`PreFormServer at ${baseUrl} did not answer within ${Math.round(timeoutMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function isReachable(baseUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2000) });
    return resp.status < 500;
  } catch {
    return false;
  }
}

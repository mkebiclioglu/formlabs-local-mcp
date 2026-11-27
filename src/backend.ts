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
  /** Directory PreFormServer should write into for a validated local output directory. */
  outputDir(localDir: string): Promise<string>;
  /**
   * After PreFormServer wrote files into the directory from outputDir, make sure each is in
   * localDir and return the local paths. `serverFiles` are the paths PreFormServer reported.
   */
  collectOutputDir(localDir: string, serverDir: string, serverFiles: string[]): Promise<string[]>;
}

/**
 * Local names for files PreFormServer says it wrote into `serverDir`. A reported path outside
 * that directory, or a name that is not a plain file name, is refused rather than followed.
 */
export function namesInServerDir(serverDir: string, serverFiles: string[]): string[] {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const dir = norm(serverDir);
  return serverFiles.map((f) => {
    const slash = f.replace(/\\/g, "/");
    const name = slash.slice(slash.lastIndexOf("/") + 1);
    if (norm(slash.slice(0, slash.lastIndexOf("/"))) !== dir || !/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
      throw new Error(`PreFormServer reported a file outside the export directory: ${JSON.stringify(f)}`);
    }
    return name;
  });
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

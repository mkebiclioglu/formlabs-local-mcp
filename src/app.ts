import type { Backend } from "./backend.js";
import { PreFormClient } from "./client.js";
import type { Config } from "./config.js";
import { LocalBackend } from "./preform.js";
import { RemoteBackend } from "./remote.js";

export interface AppContext {
  config: Config;
  client: PreFormClient;
  backend: Backend;
  log: (line: string) => void;
  close(): Promise<void>;
}

export function createApp(config: Config, log: (line: string) => void = (l) => console.error(l)): AppContext {
  const backend: Backend = config.remote
    ? new RemoteBackend(config, { localPort: config.preformServerPort, log })
    : new LocalBackend(config, log);
  const client = new PreFormClient(config, () => backend.ensureRunning());
  return {
    config,
    client,
    backend,
    log,
    async close() {
      await backend.shutdown();
    },
  };
}

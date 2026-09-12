/**
 * MCP wiring: registers every tool from ./tools.ts on an McpServer and serves
 * it over stdio. Progress is forwarded as notifications/progress when the
 * client supplied a progress token.
 */

import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createRequire } from "node:module";
import type { AppContext } from "./app.js";
import { PathNotAllowed } from "./paths.js";
import { PreFormError } from "./client.js";
import { tools, type ToolCtx } from "./tools.js";

const require = createRequire(import.meta.url);
export const VERSION: string = (require("../package.json") as { version: string }).version;

export const INSTRUCTIONS =
  "Prepares and sends 3D print jobs through a local Formlabs PreFormServer. " +
  "Typical flow: create_scene -> import_model -> auto_orient -> auto_support -> auto_layout (SLA) or auto_pack (SLS) -> " +
  "get_print_validation -> estimate_print_time -> save_form or print_to_printer. " +
  "File paths must be absolute and live under the user's home directory. " +
  "If health_check reports PreFormServer is not installed, ask the user and then call install_preform_server. " +
  "Always confirm with the user before print_to_printer.";

function progressReporter(ctx: ServerContext): ToolCtx["progress"] {
  const token = ctx.mcpReq._meta?.progressToken;
  let last = -1;
  return async (fraction, message) => {
    if (token === undefined) return;
    const value = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    if (value <= last) return; // progress must increase for the same token
    last = value;
    try {
      await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: value, total: 100, message } });
    } catch {
      /* clients without progress support must never break a call */
    }
  };
}

function errorText(err: unknown): string {
  if (err instanceof PreFormError) return `${err.code ?? "error"}: ${err.detail}`;
  if (err instanceof PathNotAllowed) return `PATH_NOT_ALLOWED: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export function createMcpServer(app: AppContext): McpServer {
  const server = new McpServer({ name: "formlabs", version: VERSION }, { instructions: INSTRUCTIONS, capabilities: { tools: {} } });
  for (const t of tools) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.input, annotations: t.annotations },
      async (args, ctx) => {
        try {
          const result = await t.handler(app, args as never, { progress: progressReporter(ctx), signal: ctx.mcpReq.signal });
          return { content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }] };
        } catch (err) {
          app.log(`[tool:${t.name}] ${errorText(err)}`);
          return { isError: true, content: [{ type: "text", text: errorText(err) }] };
        }
      },
    );
  }
  return server;
}

export async function serve(app: AppContext): Promise<void> {
  const server = createMcpServer(app);
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  transport.onclose = () => void shutdown();
  await server.connect(transport);
  app.log(`formlabs-local-mcp ${VERSION} ready (${JSON.stringify(app.config.summary())})`);
}

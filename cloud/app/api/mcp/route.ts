/**
 * The hosted MCP endpoint (Streamable HTTP). Authenticated with a Formbridge
 * MCP token: `Authorization: Bearer fb_mcp_...`. Each token is bound to one
 * environment, so the tool surface never needs an environment argument.
 */
import { createMcpHandler, McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { TOOLS } from "@/lib/mcp/catalog";
import { errorInfo, gatedCall, ToolError } from "@/lib/mcp/execute";
import { effectivePolicy, loadPolicies } from "@/lib/policy";
import { serviceClient } from "@/lib/supabase/service";
import { bearerFrom, resolveToken, type ResolvedToken } from "@/lib/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const REQUEST_BUDGET_MS = (maxDuration - 15) * 1000;

const INSTRUCTIONS =
  "Formbridge: a hosted, permissioned gateway to a Formlabs print environment (a simulated demo farm or a real PreForm setup via the local connector). " +
  "Typical flow: list_devices -> create_scene (codes from list_printer_types / list_materials) -> import_model -> auto_orient -> auto_support -> auto_layout (SLA) or auto_pack (SLS) -> get_print_validation -> estimate_print_time -> print_to_printer. " +
  "print_to_printer and other sensitive tools may return status=pending_approval with an approval_id: the owner approves in the dashboard; poll get_approval. " +
  "Track prints with get_print_job / list_print_jobs / get_device. In a simulated environment `file` can be sample:bracket, an STL URL, or any file name. Call get_environment first if unsure what you are connected to.";

function unauthorized(message: string): Response {
  return new Response(JSON.stringify({ error: "unauthorized", message }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": `Bearer realm="formbridge", error="invalid_token", error_description="${message}"` },
  });
}

function buildServer(token: ResolvedToken, hidden: Set<string>, clientName: string | undefined, startedAt: number): McpServer {
  const server = new McpServer({ name: "formbridge", version: "1.0.0" }, { instructions: INSTRUCTIONS, capabilities: { tools: {} } });
  for (const t of TOOLS) {
    if (hidden.has(t.name)) continue;
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.input, annotations: t.annotations },
      async (args, ctx: ServerContext) => {
        const db = await serviceClient();
        const progressToken = ctx.mcpReq._meta?.progressToken;
        let last = -1;
        const progress = async (fraction: number, message: string) => {
          if (progressToken === undefined) return;
          const v = Math.max(0, Math.min(100, Math.round(fraction * 100)));
          if (v <= last) return;
          last = v;
          try {
            await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken, progress: v, total: 100, message } });
          } catch {
            /* best effort */
          }
        };
        try {
          const out = await gatedCall({ db, env: token.env, tokenId: token.id, userId: token.user_id, clientName, budgetMs: REQUEST_BUDGET_MS - (Date.now() - startedAt), progress }, t.name, (args ?? {}) as Record<string, unknown>);
          return { content: [{ type: "text", text: JSON.stringify(out.result ?? null, null, 2) }] };
        } catch (err) {
          const info = errorInfo(err);
          const text = `${info.code}: ${info.message}`;
          if (!(err instanceof ToolError)) console.error(`[mcp:${t.name}] ${text}`);
          return { isError: true, content: [{ type: "text", text }] };
        }
      },
    );
  }
  return server;
}

async function handle(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const bearer = bearerFrom(request);
  if (!bearer) return unauthorized("Missing bearer token. Create an MCP token in the Formbridge dashboard and send it as Authorization: Bearer <token>.");
  let db;
  try {
    db = await serviceClient();
  } catch (err) {
    console.error("service client", err);
    return new Response(JSON.stringify({ error: "server_misconfigured" }), { status: 500, headers: { "content-type": "application/json" } });
  }
  const token = await resolveToken(db, bearer, "mcp");
  if (!token) return unauthorized("Invalid or revoked token.");
  const policies = await loadPolicies(db, token.env.id);
  const hidden = new Set(TOOLS.filter((t) => effectivePolicy(policies, t.name) === "deny").map((t) => t.name));
  let clientName: string | undefined;
  try {
    const body = await request.clone().json();
    const msgs = Array.isArray(body) ? body : [body];
    for (const m of msgs) if (m?.method === "initialize") clientName = m?.params?.clientInfo?.name;
  } catch {
    /* not JSON or GET */
  }
  const handler = createMcpHandler(() => buildServer(token, hidden, clientName, startedAt), { onerror: (e) => console.error("[mcp]", e.message) });
  const response = await handler.fetch(request, { authInfo: { token: "redacted", clientId: token.id, scopes: [token.env.kind] } });
  const headers = new Headers(response.headers);
  headers.set("x-formbridge-environment", token.env.id);
  return new Response(response.body, { status: response.status, headers });
}

export async function POST(request: Request) {
  return handle(request);
}
export async function GET(request: Request) {
  return handle(request);
}
export async function DELETE(request: Request) {
  return handle(request);
}
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" } });
}

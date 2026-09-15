import Link from "next/link";
import { CodeBlock, TokenCreator } from "@/components/client";
import { Card } from "@/components/ui";
import { appUrl } from "@/lib/supabase/env";
import { createUserClient } from "@/lib/supabase/server";
import { createToken } from "../actions";

export default async function ConnectPage() {
  const db = await createUserClient();
  const { data: envs } = await db.from("environments").select("id, name, kind").order("created_at");
  const envList = (envs ?? []).map((e) => ({ id: String(e["id"]), name: String(e["name"]), kind: String(e["kind"]) }));
  const url = `${appUrl()}/api/mcp`;
  const createMcp = async (fd: FormData) => {
    "use server";
    fd.set("kind", "mcp");
    return createToken(fd);
  };
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Connect a client</h1>
        <p className="text-sm text-muted mt-1">Any MCP client that speaks Streamable HTTP works. The endpoint is <code className="text-ink">{url}</code>; authenticate with <code className="text-ink">Authorization: Bearer &lt;token&gt;</code>.</p>
      </div>
      <Card title="1. Create a token for the environment you want the agent to use">
        <TokenCreator create={createMcp} kind="mcp" environments={envList} defaultEnv={envList[0]?.id} />
      </Card>
      <Card title="2. Add the endpoint to your client">
        <div className="space-y-5 text-sm">
          <div>
            <h3 className="font-medium mb-1">Claude Code</h3>
            <CodeBlock code={`claude mcp add --transport http formbridge ${url} --header "Authorization: Bearer <TOKEN>"`} />
            <p className="text-xs text-muted mt-1">Then in Claude Code: “List my printers and print sample:bracket in Grey V5 on an idle Form 4.”</p>
          </div>
          <div>
            <h3 className="font-medium mb-1">Codex CLI (~/.codex/config.toml)</h3>
            <CodeBlock code={`[mcp_servers.formbridge]\nurl = "${url}"\nbearer_token_env_var = "FORMBRIDGE_TOKEN"`} />
            <p className="text-xs text-muted mt-1">Export <code>FORMBRIDGE_TOKEN=&lt;TOKEN&gt;</code> in the shell that runs Codex.</p>
          </div>
          <div>
            <h3 className="font-medium mb-1">Cursor / Windsurf / generic JSON config</h3>
            <CodeBlock code={JSON.stringify({ mcpServers: { formbridge: { url, headers: { Authorization: "Bearer <TOKEN>" } } } }, null, 2)} />
          </div>
          <div>
            <h3 className="font-medium mb-1">Claude Desktop / claude.ai custom connectors</h3>
            <p className="text-muted text-xs">These require OAuth for remote servers, which Formbridge v1 does not offer yet. Use Claude Code, Codex, Cursor or the MCP inspector for now.</p>
          </div>
        </div>
      </Card>
      <Card title="3. Connect a real PreForm machine (optional)">
        <p className="text-sm text-muted">Create a <Link href="/app" className="text-accent underline">connected environment</Link>, open its Connect tab, and run the one-line connector command on the Mac or Windows machine that has (or will get) PreFormServer. Agents then use exactly the same tools against your real printers.</p>
      </Card>
    </div>
  );
}

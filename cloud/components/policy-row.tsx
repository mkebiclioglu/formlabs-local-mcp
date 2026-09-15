"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setPolicy } from "@/app/app/actions";
import type { PolicyMode } from "@/lib/policy";
import { Badge, statusTone } from "./ui";

export function PolicyRow({ envId, row }: { envId: string; row: { tool: string; category: string; mode: PolicyMode; isDefault: boolean; description: string } }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <tr>
      <td><div className="mono">{row.tool}</div><div className="text-xs text-muted max-w-xl">{row.description.slice(0, 140)}{row.description.length > 140 ? "…" : ""}</div></td>
      <td className="text-muted">{row.category}</td>
      <td>
        <div className="flex items-center gap-2">
          <select
            className="input py-1 w-32"
            value={row.mode}
            disabled={pending}
            onChange={(e) => start(async () => { await setPolicy(envId, row.tool, e.target.value as PolicyMode); router.refresh(); })}
          >
            <option value="allow">Allow</option>
            <option value="approve">Approve</option>
            <option value="deny">Deny</option>
          </select>
          {!row.isDefault ? <button type="button" className="text-xs text-muted underline" onClick={() => start(async () => { await setPolicy(envId, row.tool, "default"); router.refresh(); })}>reset</button> : <Badge tone={statusTone(row.mode)}>default</Badge>}
        </div>
      </td>
    </tr>
  );
}

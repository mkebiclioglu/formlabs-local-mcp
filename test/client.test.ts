import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { PreFormClient, PreFormError } from "../src/client.js";
import { fakePreform, json, makeConfig } from "./helpers.js";

const servers: Server[] = [];
afterEach(() => { for (const s of servers) s.close(); servers.length = 0; });

async function up(routes: Parameters<typeof fakePreform>[0]) {
  const f = await fakePreform(routes);
  servers.push(f.server);
  return { ...f, client: new PreFormClient(makeConfig({ baseUrl: f.url })) };
}

describe("PreFormClient", () => {
  it("returns JSON", async () => {
    const { client } = await up({ "GET /": (_r, _b, res) => json(res, 200, { version: "3.62.1" }) });
    expect(await client.get("/")).toEqual({ version: "3.62.1" });
  });

  it("translates error bodies into PreFormError", async () => {
    const { client } = await up({ "POST /scene/": (_r, _b, res) => json(res, 400, { error: { code: "INPUT_ERROR", message: "Scene type not supported" } }) });
    const err = await client.post("/scene/", {}).catch((e) => e);
    expect(err).toBeInstanceOf(PreFormError);
    expect(err.code).toBe("INPUT_ERROR");
    expect(err.status).toBe(400);
    expect(String(err)).toContain("Scene type not supported");
  });

  it("polls async operations and reports progress", async () => {
    let polls = 0;
    const { client, calls } = await up({
      "POST /scene/default/auto-orient/": (_r, _b, res) => json(res, 202, { operationId: "op-1" }),
      "GET /operations/op-1/": (_r, _b, res) => json(res, 200, ++polls < 2 ? { status: "IN_PROGRESS", progress: 0.5 } : { status: "SUCCEEDED", progress: 1, result: { n: 3 } }),
    });
    const seen: number[] = [];
    const result = await client.postAsync("/scene/default/auto-orient/", { models: "ALL" }, async (p) => { seen.push(p); });
    expect(result).toEqual({ n: 3 });
    expect(seen).toEqual([0.5, 1]);
    expect(calls[0]?.path).toBe("/scene/default/auto-orient/");
  });

  it("supports GET async operations", async () => {
    const { client } = await up({
      "GET /scene/default/cup-detection/": (_r, _b, res) => json(res, 202, { operationId: "op-c" }),
      "GET /operations/op-c/": (_r, _b, res) => json(res, 200, { status: "SUCCEEDED", progress: 1, result: { per_model_results: { m1: { cup_count: 2 } } } }),
    });
    const r = (await client.getAsync("/scene/default/cup-detection/")) as { per_model_results: Record<string, { cup_count: number }> };
    expect(r.per_model_results["m1"]?.cup_count).toBe(2);
  });

  it("raises on FAILED operations with the server's code", async () => {
    const { client } = await up({
      "POST /scene/default/auto-support/": (_r, _b, res) => json(res, 202, { operationId: "op-f" }),
      "GET /operations/op-f/": (_r, _b, res) => json(res, 200, { status: "FAILED", progress: 0, result: { error: { code: "SUPPORT_GEN_FAILED", message: "Bad mesh" } } }),
    });
    const err = await client.postAsync("/scene/default/auto-support/", {}).catch((e) => e);
    expect(err.code).toBe("SUPPORT_GEN_FAILED");
  });

  it("passes inline results through when the server answers synchronously", async () => {
    const { client } = await up({ "POST /scene/default/auto-orient/": (_r, _b, res) => json(res, 200, { oriented: 1 }) });
    expect(await client.postAsync("/scene/default/auto-orient/", {})).toEqual({ oriented: 1 });
  });

  it("times out long operations", async () => {
    const { client } = await up({
      "POST /scene/default/auto-support/": (_r, _b, res) => json(res, 202, { operationId: "op-s" }),
      "GET /operations/op-s/": (_r, _b, res) => json(res, 200, { status: "IN_PROGRESS", progress: 0.1 }),
    });
    const err = await client.postAsync("/scene/default/auto-support/", {}).catch((e) => e);
    expect(err.code).toBe("OPERATION_TIMEOUT");
  });

  it("runs beforeFirstRequest once and retries it after failure", async () => {
    const f = await fakePreform({ "GET /": (_r, _b, res) => json(res, 200, { version: "x" }) });
    servers.push(f.server);
    let attempts = 0;
    const client = new PreFormClient(makeConfig({ baseUrl: f.url }), async () => { if (++attempts === 1) throw new Error("PreFormServer missing"); });
    await expect(client.get("/")).rejects.toThrow(/missing/);
    expect(await client.get("/")).toEqual({ version: "x" });
    await client.get("/");
    expect(attempts).toBe(2);
  });
});

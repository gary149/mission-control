import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

// Stands in for a gateway's `/models` catalog endpoint. `models` is the exact
// list this instance currently serves; tests mutate it between requests.
function fakeGateway(): { server: Server; baseUrl: () => string; models: string[] } {
  const state = { models: [] as string[] };
  const server = createServer((req, res) => {
    if (req.url === "/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: state.models.map((id) => ({ id })) }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return {
    server,
    baseUrl: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    models: state.models,
  };
}

describe("checkGatewayModelServed", () => {
  let home: string;
  let gw: ReturnType<typeof fakeGateway>;

  before(async () => {
    home = mkdtempSync(join(tmpdir(), "mc-test-preflight-"));
    process.env.MC_HOME = home;
    process.env.TESTGW_API_KEY = "test-key";
    gw = fakeGateway();
    await new Promise<void>((resolve) => gw.server.listen(0, "127.0.0.1", resolve));
    writeFileSync(
      join(home, "config.toml"),
      `[gateway.testgw]\nbase_url_openai = "${gw.baseUrl()}"\nenv_var = "TESTGW_API_KEY"\n`,
    );
  });

  after(async () => {
    await new Promise<void>((resolve) => gw.server.close(() => resolve()));
    delete process.env.TESTGW_API_KEY;
    rmSync(home, { recursive: true, force: true });
  });

  test("refuses a model absent from the gateway's current catalog", async () => {
    const { checkGatewayModelServed } = await import("../src/core/auth.ts");
    const { loadConfig } = await import("../src/core/config.ts");
    gw.models.length = 0;
    gw.models.push("acme/known-model");

    await assert.rejects(
      checkGatewayModelServed(
        { model: "acme/typo-model", auth: { mode: "gateway", gateway: "testgw" } } as never,
        loadConfig(),
      ),
      /does not currently serve model "acme\/typo-model"/,
    );
  });

  test("passes silently when the model IS in the catalog", async () => {
    const { checkGatewayModelServed } = await import("../src/core/auth.ts");
    const { loadConfig } = await import("../src/core/config.ts");
    gw.models.length = 0;
    gw.models.push("acme/known-model");

    await checkGatewayModelServed(
      { model: "acme/known-model", auth: { mode: "gateway", gateway: "testgw" } } as never,
      loadConfig(),
    );
  });

  test("fails OPEN (does not throw) when the gateway is unreachable", async () => {
    const { checkGatewayModelServed } = await import("../src/core/auth.ts");
    const { loadConfig } = await import("../src/core/config.ts");
    const config = loadConfig();
    config.gateways.testgw!.base_url_openai = "http://127.0.0.1:1"; // nothing listens here

    await checkGatewayModelServed(
      { model: "acme/whatever", auth: { mode: "gateway", gateway: "testgw" } } as never,
      config,
    );
  });

  test("fails OPEN when the catalog response is empty or malformed", async () => {
    const { checkGatewayModelServed } = await import("../src/core/auth.ts");
    const { loadConfig } = await import("../src/core/config.ts");
    gw.models.length = 0; // empty data[]: nothing confident to refuse on

    await checkGatewayModelServed(
      { model: "acme/whatever", auth: { mode: "gateway", gateway: "testgw" } } as never,
      loadConfig(),
    );
  });

  test("is a no-op outside gateway mode, and when no model is given", async () => {
    const { checkGatewayModelServed } = await import("../src/core/auth.ts");
    const { loadConfig } = await import("../src/core/config.ts");
    const config = loadConfig();

    await checkGatewayModelServed({ model: "acme/whatever", auth: { mode: "subscription" } } as never, config);
    await checkGatewayModelServed({ model: null, auth: { mode: "gateway", gateway: "testgw" } } as never, config);
  });
});

import type { AdapterContext, ConnectorCall } from "@rakazo/adapter-kit";
import { IntegrationProviderConfigSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ComposioClient } from "./composio-connector.js";
import {
  ComposioConnector,
  ConnectorRegistry,
  composioGmailApprovalRequired,
} from "./composio-connector.js";
import { catalogEntries, resolveCatalogCall } from "./lazy-tool-catalog.js";

function fixture(authConfigs: Record<string, string> = { gmail: "approved-auth" }) {
  const created: Array<Record<string, unknown>> = [];
  let accounts: Array<Record<string, unknown>> = [
    {
      id: "gmail-account",
      status: "ACTIVE",
      isDisabled: false,
      toolkit: { slug: "gmail" },
      authConfig: { id: "approved-auth", isDisabled: false },
    },
  ];
  let fail = false;
  const execute = vi.fn(
    async (_tool: string, _args: Record<string, unknown>, _options?: unknown) => ({
      data: { ok: true },
      error: null,
    }),
  );
  const authorize = vi.fn(async () => ({
    id: "gmail-account",
    redirectUrl: "https://consent.example.test",
  }));
  const sessions = new Map();
  const list = vi.fn(async () => {
    if (fail) throw new Error("synthetic metadata outage");
    return { items: accounts };
  });
  const client = {
    create: vi.fn(async (_user: string, config: Record<string, unknown>) => {
      created.push(config);
      const sessionId = String(created.length);
      const session = {
        sessionId,
        toolkits: async () => ({
          items: [
            {
              slug: "gmail",
              name: "Gmail",
              connection: {
                isActive: true,
                authConfig: { id: "approved-auth" },
                connectedAccount: { id: "gmail-account", status: "ACTIVE" },
              },
            },
            { slug: "github", name: "GitHub" },
          ],
        }),
        tools: async () => [{ name: "GMAIL_GET_MESSAGE", parameters: { type: "object" } }],
        execute,
        authorize,
      };
      sessions.set(sessionId, session);
      return session;
    }),
    sessions: { use: async (id: string) => sessions.get(id) },
    connectedAccounts: {
      list,
      waitForConnection: async () => ({ id: "gmail-account" }),
      delete: async () => undefined,
    },
  } as unknown as ComposioClient;
  const connector = new ComposioConnector({ client, authConfigs } as ConstructorParameters<
    typeof ComposioConnector
  >[0]);
  const context: AdapterContext = {
    operationId: "offline",
    traceId: "offline",
    userId: "user",
    spaceId: "space",
    signal: new AbortController().signal,
    connectedConnections: [
      {
        id: "native-account",
        connectorId: "composio",
        externalId: "gmail",
        providerRef: "gmail-account",
        displayName: "Synthetic",
      },
    ],
  };
  const run = async (
    tool = "GMAIL_GET_MESSAGE",
    args: Record<string, unknown> = {},
    route?: ConnectorCall["route"],
  ) => {
    const events = [];
    for await (const e of connector.execute({ tool, args, route, executionId: "fixture" }, context))
      events.push(e);
    return events;
  };
  return {
    connector,
    context,
    created,
    execute,
    authorize,
    list,
    run,
    accounts(value: typeof accounts) {
      accounts = value;
    },
    fail() {
      fail = true;
    },
  };
}

describe("Gmail exact operator auth configuration", () => {
  it("pins both catalog authorization and execution sessions to the same immutable auth configuration", async () => {
    const map = { gmail: "approved-auth" };
    const f = fixture(map);
    map.gmail = "later-mutation";
    await f.connector.begin(
      { provider: "gmail", redirectUrl: "https://native.example.test" },
      f.context,
    );
    await f.run();
    expect(f.created.length).toBeGreaterThanOrEqual(2);
    expect(
      f.created.every(
        (c) => JSON.stringify(c.authConfigs) === JSON.stringify({ gmail: "approved-auth" }),
      ),
    ).toBe(true);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.list).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: ["user"], authConfigIds: ["approved-auth"] }),
      undefined,
    );
  });
  it("refuses unbound Gmail before authorization or execution", async () => {
    const f = fixture({});
    await expect(
      f.connector.begin(
        { provider: "gmail", redirectUrl: "https://native.example.test" },
        f.context,
      ),
    ).rejects.toThrow("Gmail");
    expect(await f.run()).toMatchObject([{ type: "error" }]);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it.each([{ gmail: "" }, { " ": "id" }, { gmail: "one", GMAIL: "two" }])(
    "rejects invalid toolkit bindings %j",
    (authConfigs) => {
      expect(
        IntegrationProviderConfigSchema.safeParse({
          provider: "composio",
          apiKey: "synthetic-key",
          authConfigs,
        }).success,
      ).toBe(false);
    },
  );
  it.each([
    "wrong-config",
    "missing",
    "disabled",
    "wrong-toolkit",
    "outage",
    "legacy",
    "wrong-account",
  ])("fails closed for Gmail %s without native broad-grant fallback", async (what) => {
    const f = fixture();
    if (what === "outage") f.fail();
    else if (what === "legacy") f.context.connectedConnections![0]!.providerRef = "gmail";
    else
      f.accounts([
        {
          id: what === "wrong-account" ? "another-account" : "gmail-account",
          status: "ACTIVE",
          isDisabled: what === "disabled",
          toolkit: { slug: what === "wrong-toolkit" ? "github" : "gmail" },
          ...(what === "missing"
            ? {}
            : {
                authConfig: {
                  id: what === "wrong-config" ? "other-auth" : "approved-auth",
                  isDisabled: false,
                },
              }),
        },
      ]);
    expect(await f.run()).toMatchObject([{ type: "error" }]);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("keeps healthy unrelated apps usable during Gmail metadata failure", async () => {
    const f = fixture();
    f.fail();
    f.context.connectedConnections!.push({
      id: "github-native",
      connectorId: "composio",
      externalId: "github",
      providerRef: "github-account",
      displayName: "GitHub",
    });
    expect(await f.run("GITHUB_GET_REPOS")).toMatchObject([{ type: "result" }]);
    expect(f.created.at(-1)!.toolkits).toEqual(["github"]);
  });
  it("preserves multi-account explicit selection and refuses a selector outside native pins", async () => {
    const f = fixture();
    f.context.connectedConnections!.push({
      id: "second-native",
      connectorId: "composio",
      externalId: "gmail",
      providerRef: "second-account",
      displayName: "Second",
    });
    f.accounts(
      ["gmail-account", "second-account"].map((id) => ({
        id,
        status: "ACTIVE",
        isDisabled: false,
        toolkit: { slug: "gmail" },
        authConfig: { id: "approved-auth", isDisabled: false },
      })),
    );
    expect(await f.run("GMAIL_GET_MESSAGE", { account: "second-account" })).toMatchObject([
      { type: "result" },
    ]);
    expect(f.created.at(-1)!.multiAccount).toMatchObject({
      enable: true,
      requireExplicitSelection: true,
    });
    expect(f.execute.mock.calls[0]![2]).toEqual({ account: "second-account" });
    expect(await f.run("GMAIL_GET_MESSAGE", { account: "unowned-account" })).toMatchObject([
      { type: "error" },
    ]);
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it("rejects an approved route after auth-config or native account substitution", async () => {
    const original = fixture();
    const [tool] = await original.connector.discoverTools(original.context);
    const changed = fixture({ gmail: "new-auth" });
    changed.accounts([
      {
        id: "gmail-account",
        status: "ACTIVE",
        isDisabled: false,
        toolkit: { slug: "gmail" },
        authConfig: { id: "new-auth", isDisabled: false },
      },
    ]);
    expect(await changed.run("GMAIL_GET_MESSAGE", {}, tool!.route)).toMatchObject([
      { type: "error" },
    ]);
    expect(changed.execute).not.toHaveBeenCalled();
    original.context.connectedConnections![0]!.id = "changed-native-id";
    expect(await original.run("GMAIL_GET_MESSAGE", {}, tool!.route)).toMatchObject([
      { type: "error" },
    ]);
    expect(original.execute).not.toHaveBeenCalled();
  });
  it("uses actual registry dispatch identity for hidden targets, not namespace collisions", () => {
    const registry = new ConnectorRegistry([]);
    const hidden = { tool: "GMAIL_GET_MESSAGE", args: {}, executionId: "hidden" };
    expect(composioGmailApprovalRequired(hidden, registry)).toBe(true);
    expect(
      composioGmailApprovalRequired(
        {
          ...hidden,
          route: { connectorId: "mcp", resourceId: "unrelated", toolName: "GMAIL_GET_MESSAGE" },
        },
        registry,
      ),
    ).toBe(false);
    expect(() =>
      composioGmailApprovalRequired(
        { ...hidden, tool: "COMPOSIO_MULTI_EXECUTE_TOOL", args: { tools: "opaque" } },
        registry,
      ),
    ).toThrow("explicit tool targets");
  });
  it("retains account binding through the actual native lazy catalog resolver", async () => {
    const f = fixture();
    const [tool] = await f.connector.discoverTools(f.context);
    const entries = catalogEntries([tool!]);
    const resolved = resolveCatalogCall(
      {
        tool: "composio_execute_tool",
        route: { connectorId: "composio", toolName: "__catalog_execute" },
        args: { id: entries[0]!.id, arguments: {} },
        executionId: "lazy-gmail",
      },
      entries,
    );
    expect(resolved!.call.route).toMatchObject(tool!.route!);
    expect(composioGmailApprovalRequired(resolved!.call)).toBe(true);
    expect(
      await f.run(resolved!.call.tool, resolved!.call.args, resolved!.call.route),
    ).toMatchObject([{ type: "result" }]);
    expect(f.execute).toHaveBeenCalledOnce();
  });
});

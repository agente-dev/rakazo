// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  approve: vi.fn(),
  catalog: vi.fn(),
  accounts: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  revoke: vi.fn(),
  status: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  appConnected: vi.fn(),
  setRule: vi.fn(),
  listRules: vi.fn(),
  tools: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    me: api.me,
    mcp: {
      servers: {
        list: api.list,
        create: api.create,
        update: api.update,
        remove: api.remove,
        test: api.test,
      },
      assignments: { approve: api.approve },
    },
    connections: {
      catalog: api.catalog,
      list: api.accounts,
      begin: api.begin,
      complete: api.complete,
      revoke: api.revoke,
      tools: api.tools,
    },
    messaging: {
      status: api.status,
      link: { start: api.link },
      identities: { unlink: api.unlink },
    },
    onboarding: { appConnected: api.appConnected },
    approvalRules: { set: api.setRule, list: api.listRules },
    capabilities: { catalogSearch: vi.fn() },
  },
}));
vi.mock("../../lib/mcp-connect", () => ({ connectMcpOauth: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((out, part, index) => out + part + (values[index] ?? ""), ""),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: Record<string, unknown>) => <button {...props} />,
  Input: (props: Record<string, unknown>) => <input {...props} />,
  Disclosure: ({ summary, children }: { summary: ReactNode; children: ReactNode }) => (
    <details>
      <summary>{summary}</summary>
      {children}
    </details>
  ),
}));
import { IntegrationSetup, businessRegistration } from "./IntegrationSetup";
import { connectMcpOauth } from "../../lib/mcp-connect";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  const rules: unknown[] = [];
  api.setRule.mockImplementation(async (rule) => {
    rules.push(rule);
    return rule;
  });
  api.listRules.mockImplementation(async () => rules);
  api.tools.mockResolvedValue([{ name: "GMAIL_SEND_EMAIL", description: "Synthetic send tool" }]);
  api.me.mockResolvedValue({ userId: "user-a", spaceId: "space-a" });
  api.list.mockResolvedValue([]);
  api.accounts.mockResolvedValue([]);
  api.status.mockResolvedValue({
    enabled: true,
    providers: ["telegram"],
    openSignup: false,
    identities: [],
  });
  api.create.mockResolvedValue({ id: "server-a" });
  api.update.mockResolvedValue({ id: "server-a" });
  api.test.mockResolvedValue({ health: { status: "ok", toolCount: 6 } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => root.render(<IntegrationSetup botId="bot-a" />));
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === text);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
async function fill(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    host
      .querySelector("section form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

it("shows all five selected providers in the existing integration component", async () => {
  await mount();
  for (const name of ["Gmail", "Fakturownia", "KeyCRM", "wFirma", "Telegram"])
    expect(host.textContent).toContain(name);
  expect(host.textContent).toContain("Add MCP server");
  expect(api.create).not.toHaveBeenCalled();
  expect(api.begin).not.toHaveBeenCalled();
});
it("registers KeyCRM through the native encrypted-secret API and clears credentials", async () => {
  await mount();
  await click("KeyCRM");
  await fill("API token", "synthetic-token");
  await fill("Account name", "Example office");
  await submit();
  expect(api.create).toHaveBeenCalledTimes(1);
  expect(api.setRule).toHaveBeenCalledTimes(24);
  expect(api.setRule.mock.invocationCallOrder[0]).toBeLessThan(
    api.create.mock.invocationCallOrder[0]!,
  );
  const config = api.create.mock.calls[0]![0];
  const decoded = JSON.parse(Buffer.from(config.secret, "base64url").toString());
  expect(decoded.binding).toMatchObject({
    userId: "user-a",
    spaceId: "space-a",
    accountId: config.slug,
  });
  expect(decoded.credentials.token).toBe("synthetic-token");
  expect(config.transport).toBe("streamable_http");
  expect(config.endpoint).toBe("http://127.0.0.1:45181/mcp");
  expect(api.approve).toHaveBeenCalledWith({ botId: "bot-a", serverId: "server-a" });
  expect(host.querySelector<HTMLInputElement>('[aria-label="API token"]')!.value).toBe("");
  expect(host.textContent).not.toContain("synthetic-token");
  expect(host.textContent).toContain("Verify access with a permitted read");
});
it("refuses an actor/space change before persisting a credential", async () => {
  await mount();
  await click("KeyCRM");
  await fill("API token", "synthetic-token");
  api.me.mockResolvedValue({ userId: "user-b", spaceId: "space-a" });
  await submit();
  expect(api.create).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLInputElement>('[aria-label="API token"]')!.value).toBe("");
});
it("uses the same native account for reconnect and removes only the selected account", async () => {
  const row = {
    id: "server-a",
    slug: "agente-pl-keycrm-fixture",
    name: "Example office",
    endpoint: "http://127.0.0.1:45181/mcp",
    description: "Office account",
  };
  api.list.mockResolvedValue([
    row,
    { ...row, id: "server-b", slug: "agente-pl-keycrm-sibling", name: "Other office" },
  ]);
  await mount();
  await click("KeyCRM");
  await click("Reconnect");
  await fill("API token", "synthetic-new-key");
  await submit();
  expect(api.update.mock.calls[0]![0]).toMatchObject({
    id: "server-a",
    config: { slug: row.slug },
  });
  expect(api.create).not.toHaveBeenCalled();
  await click("Disconnect");
  expect(api.remove).toHaveBeenCalledWith({ id: "server-a" });
  expect(api.remove).toHaveBeenCalledTimes(1);
});
it("uses native Composio catalog and authorization flow for Gmail", async () => {
  api.catalog.mockResolvedValue([
    { connectorId: "composio", slug: "gmail", name: "Gmail", connected: false, noAuth: false },
  ]);
  api.begin.mockResolvedValue({
    connectionId: "gmail-a",
    authorizationUrl: "https://auth.example.test/fixture",
  });
  api.complete.mockResolvedValue({ id: "gmail-a", status: "connected" });
  vi.spyOn(window, "open").mockImplementation(() => null);
  await mount();
  await click("Connect Gmail");
  expect(api.catalog).toHaveBeenCalledWith({ connectorId: "composio", query: "gmail" });
  expect(api.begin).toHaveBeenCalledWith({
    connectorId: "composio",
    provider: "gmail",
    displayName: "Gmail",
  });
  expect(api.appConnected).toHaveBeenCalledWith({
    botId: "bot-a",
    provider: "gmail",
    connectorId: "composio",
  });
  expect(api.create).not.toHaveBeenCalled();
});
it("links the upstream Telegram bot without requesting personal conversations or sending a message", async () => {
  api.link.mockResolvedValue({ code: "synthetic-link-code", expiresAt: "2026-10-24T22:00:00Z" });
  await mount();
  await click("Telegram");
  expect(host.textContent).toContain("Existing personal conversations are not included");
  await click("Link Telegram bot");
  expect(api.link).toHaveBeenCalledWith({ botId: "bot-a" });
  expect(host.textContent).toContain("synthetic-link-code");
  expect(api.create).not.toHaveBeenCalled();
});
it("keeps business registration browser-safe and validates domains and all three wFirma keys", () => {
  const base = {
    provider: "wfirma" as const,
    accountId: "fixture",
    name: "Office",
    userId: "u",
    spaceId: "s",
    token: "",
    accessKey: "synthetic-access",
    secretKey: "synthetic-secret",
    appKey: "synthetic-app",
    host: "",
  };
  expect(
    JSON.parse(Buffer.from(businessRegistration(base).secret, "base64url").toString()).credentials,
  ).toEqual({ accessKey: base.accessKey, secretKey: base.secretKey, appKey: base.appKey });
  expect(() => businessRegistration({ ...base, appKey: "" })).toThrow();
  expect(() =>
    businessRegistration({
      ...base,
      provider: "fakturownia",
      token: "synthetic",
      host: "http://127.0.0.1",
    }),
  ).toThrow();
});

it("refuses to install or assign a write-capable account when native approval policy did not persist", async () => {
  await mount();
  await click("KeyCRM");
  await fill("API token", "synthetic-token");
  api.listRules.mockResolvedValue([]);
  await submit();
  expect(api.create).not.toHaveBeenCalled();
  expect(api.approve).not.toHaveBeenCalled();
});

it("retains Fakturownia hosted read-only OAuth without requiring a REST token", async () => {
  vi.mocked(connectMcpOauth).mockResolvedValue("connected");
  await mount();
  await click("Fakturownia");
  await fill("Account domain", "fixture-office");
  await click("Connect with Fakturownia");
  expect(api.create.mock.calls[0]![0]).toMatchObject({
    endpoint: "https://fixture-office.fakturownia.pl/mcp",
    transport: "streamable_http",
  });
  expect(api.create.mock.calls[0]![0].secret).toBeUndefined();
  expect(connectMcpOauth).toHaveBeenCalledWith("server-a");
});

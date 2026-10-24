// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  navigate: vi.fn(),
  bots: vi.fn(),
  catalog: vi.fn(),
  accounts: vi.fn(),
  servers: vi.fn(),
  capabilities: vi.fn(),
  catalogSearch: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    bots: { list: api.bots },
    connections: { catalog: api.catalog, list: api.accounts },
    mcp: { servers: { list: api.servers } },
    capabilities: { list: api.capabilities, catalogSearch: api.catalogSearch },
  },
}));
vi.mock("../components/integrations/IntegrationSetup", () => ({
  IntegrationSetup: ({ botId }: { botId?: string }) => (
    <div data-testid="office-setup">
      <output>{botId}</output>
      <input aria-label="Synthetic credential" />
    </div>
  ),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => api.navigate }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: () => null,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((out, part, index) => out + part + (values[index] ?? ""), ""),
  }),
}));
vi.mock("@rakazo/ui-web", () => {
  const container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Badge: container,
    Card: container,
    CardContent: container,
    CardHeader: container,
    CardTitle: container,
    Dialog: container,
    DialogClose: container,
    DialogContent: container,
    DialogHeader: container,
    DialogTitle: container,
    Spinner: () => null,
    Button: ({ variant: _variant, size: _size, ...props }: Record<string, unknown>) => (
      <button {...props} />
    ),
    Input: (props: Record<string, unknown>) => <input {...props} />,
    NativeSelect: (props: Record<string, unknown>) => <select {...props} />,
    NativeSelectOption: (props: Record<string, unknown>) => <option {...props} />,
    Disclosure: ({ summary, children }: { summary: ReactNode; children: ReactNode }) => (
      <details>
        <summary>{summary}</summary>
        {children}
      </details>
    ),
  };
});
import { PluginsOverlay } from "./PluginsOverlay";
import { IntegrationSetupPage } from "./IntegrationSetup";
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  api.bots.mockResolvedValue([
    { id: "bot-a", name: "Synthetic A" },
    { id: "bot-b", name: "Synthetic B" },
  ]);
  api.catalog.mockResolvedValue([]);
  api.accounts.mockResolvedValue([]);
  api.servers.mockResolvedValue([]);
  api.capabilities.mockResolvedValue([]);
  api.catalogSearch.mockResolvedValue({ enabled: false, results: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("opens the same office setup from the main apps screen without opening Advanced", async () => {
  await act(async () => {
    root.render(<PluginsOverlay onClose={() => {}} activeBotId="bot-a" />);
  });
  const button = [...host.querySelectorAll("button")].find(
    (node) => node.textContent === "Connect apps",
  )!;
  expect(button).toBeDefined();
  expect(button.closest("details")).toBeNull();
  expect(host.querySelectorAll('[data-testid="office-setup"]')).toHaveLength(0);
  await act(async () => button.click());
  expect(host.querySelectorAll('[data-testid="office-setup"]')).toHaveLength(1);
  expect(host.querySelector("output")?.textContent).toBe("bot-a");
  expect(host.querySelector("details")?.open).toBe(false);
  host.querySelector<HTMLInputElement>('[aria-label="Synthetic credential"]')!.value =
    "synthetic-unsubmitted";
  await act(async () => {
    root.render(<PluginsOverlay onClose={() => {}} activeBotId="bot-b" />);
  });
  expect(host.querySelector("output")?.textContent).toBe("bot-b");
  expect(host.querySelector<HTMLInputElement>('[aria-label="Synthetic credential"]')?.value).toBe(
    "",
  );
  await act(async () => button.click());
  expect(host.querySelectorAll('[data-testid="office-setup"]')).toHaveLength(0);
});
it("changing the selected bot remounts setup and clears its unfinished credential form", async () => {
  await act(async () => {
    root.render(<IntegrationSetupPage />);
  });
  const input = host.querySelector<HTMLInputElement>('[aria-label="Synthetic credential"]')!;
  input.value = "synthetic-unsubmitted";
  const select = host.querySelector<HTMLSelectElement>("select")!;
  await act(async () => {
    select.value = "bot-b";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.querySelector("output")?.textContent).toBe("bot-b");
  expect(host.querySelector<HTMLInputElement>('[aria-label="Synthetic credential"]')?.value).toBe(
    "",
  );
});

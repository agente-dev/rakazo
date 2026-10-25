import { describe, expect, it, vi } from "vitest";
import { configureIntegrationProvider } from "./configure-integration-provider.js";

describe("private operator integration configuration", () => {
  const config = {
    provider: "composio",
    apiKey: "synthetic-secret",
    authConfigs: { gmail: "approved-auth" },
  };
  it("uses resolved native namespace and existing settings save without another credential store", async () => {
    const actor = {
      userId: "user",
      spaceId: "space",
      operationId: "offline",
      traceId: "offline",
      signal: new AbortController().signal,
    };
    const context = vi.fn(async () => actor),
      save = vi.fn(async () => undefined);
    await configureIntegrationProvider(
      JSON.stringify({ userId: "user", spaceId: "space", config }),
      { context, save },
    );
    expect(context).toHaveBeenCalledWith("user", "space");
    expect(save).toHaveBeenCalledWith(config, actor);
  });
  it.each([
    "invalid-json",
    JSON.stringify({
      userId: "user",
      spaceId: "space",
      config: { ...config, authConfigs: { gmail: "" } },
    }),
    "x".repeat(65537),
  ])("rejects malformed private input without saving", async (input) => {
    const context = vi.fn(),
      save = vi.fn();
    await expect(configureIntegrationProvider(input, { context, save })).rejects.toBeDefined();
    expect(save).not.toHaveBeenCalled();
  });
  it("refuses a missing native membership before credential verification", async () => {
    const context = vi.fn(async () => {
        throw new Error("synthetic missing membership");
      }),
      save = vi.fn();
    await expect(
      configureIntegrationProvider(JSON.stringify({ userId: "user", spaceId: "space", config }), {
        context,
        save,
      }),
    ).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
});

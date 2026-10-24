import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { McpConnectorOptions } from "@rakazo/adapters";
import { mcpStdioOptionsFromEnv } from "@rakazo/adapters";
import type { McpServer } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { matchingOfficeBinding } from "../../../packages/adapters/src/trusted-mcp-bindings.js";
import { loadEnv } from "./env.js";

const defaultOrigin = "http://127.0.0.1:5173";
const explicitOrigin = "https://native.example.test";
const otherOrigin = "https://other.example.test";
const binding = {
  kind: "office-decisions-v1" as const,
  nativeAuthority: defaultOrigin,
  officeId: "office-fixture",
  spaceId: "space-fixture",
  userId: "owner-fixture",
  botId: "requester-fixture",
  serverId: "server-fixture",
  serverRevision: 1,
  endpoint: "https://office.example.test/mcp",
  protectedTools: ["office_client_update"],
  members: [
    {
      nativeUserId: "owner-fixture",
      nativeSpaceId: "space-fixture",
      officeMemberId: "member-fixture",
    },
  ],
};
const server = {
  id: binding.serverId,
  enabled: true,
  transport: "streamable_http",
  spaceId: binding.spaceId,
  userId: binding.userId,
  revision: binding.serverRevision,
  endpoint: binding.endpoint,
  secretId: "synthetic-secret",
} as McpServer;

/** Execute the actual constructor expression in each root, not a copied options object.
 * Only the constructor/deployment services are inert; env parsing and trust matching are real.
 * No API/worker startup, listener, database or provider is needed for this composition regression.
 */
function composedOptions(path: string, source: NodeJS.ProcessEnv): McpConnectorOptions {
  const file = readFileSync(new URL(path, import.meta.url), "utf8");
  const constructors = [...file.matchAll(/new McpConnector\([\s\S]*?\n {2}\);/g)];
  expect(constructors).toHaveLength(1);
  const javascript = constructors[0]![0];
  return runInNewContext(javascript, {
    McpConnector: class {
      constructor(
        _prisma: unknown,
        _secrets: unknown,
        readonly options: McpConnectorOptions,
      ) {}
    },
    prisma: {},
    secrets: {},
    env: loadEnv(source),
    process: { env: source },
    mcpStdioOptionsFromEnv,
    mcpOAuth: {},
    events: {},
    remoteConnectors: {},
    allowPrivateEndpoint: false,
  }).options;
}

const cases: Array<{ name: string; env: NodeJS.ProcessEnv; authority: string; enabled: boolean }> =
  [
    {
      name: "absent explicit authority never enables the default binding",
      env: {},
      authority: defaultOrigin,
      enabled: false,
    },
    {
      name: "explicit local auth origin is valid",
      env: { BETTER_AUTH_URL: defaultOrigin },
      authority: defaultOrigin,
      enabled: true,
    },
    {
      name: "explicit web origin is valid",
      env: { WEB_ORIGIN: explicitOrigin },
      authority: explicitOrigin,
      enabled: true,
    },
    {
      name: "explicit auth origin is valid",
      env: { BETTER_AUTH_URL: explicitOrigin },
      authority: explicitOrigin,
      enabled: true,
    },
    {
      name: "mismatched binding is refused",
      env: { BETTER_AUTH_URL: otherOrigin },
      authority: explicitOrigin,
      enabled: false,
    },
    {
      name: "absent authority also refuses a nondefault binding",
      env: {},
      authority: explicitOrigin,
      enabled: false,
    },
    {
      name: "empty auth origin disables",
      env: { BETTER_AUTH_URL: "" },
      authority: defaultOrigin,
      enabled: false,
    },
    {
      name: "empty web origin disables",
      env: { WEB_ORIGIN: "" },
      authority: defaultOrigin,
      enabled: false,
    },
    {
      name: "empty auth origin does not fall through to web origin",
      env: { BETTER_AUTH_URL: "", WEB_ORIGIN: explicitOrigin },
      authority: explicitOrigin,
      enabled: false,
    },
    {
      name: "auth origin wins conflicting web origin",
      env: { BETTER_AUTH_URL: explicitOrigin, WEB_ORIGIN: otherOrigin },
      authority: explicitOrigin,
      enabled: true,
    },
    {
      name: "lower-priority web binding cannot win a conflict",
      env: { BETTER_AUTH_URL: otherOrigin, WEB_ORIGIN: explicitOrigin },
      authority: explicitOrigin,
      enabled: false,
    },
    {
      name: "empty web origin does not disable explicit auth origin",
      env: { BETTER_AUTH_URL: explicitOrigin, WEB_ORIGIN: "" },
      authority: explicitOrigin,
      enabled: true,
    },
  ];

describe("Office explicit authority in API and worker composition", () => {
  it.each(cases)("$name", ({ env, authority, enabled }) => {
    const source = {
      DATABASE_URL: "postgresql://synthetic.invalid/offline",
      NODE_ENV: "test",
      ...env,
      TRUSTED_MCP_BINDINGS: JSON.stringify([{ ...binding, nativeAuthority: authority }]),
    };
    const api = composedOptions("./app.ts", source);
    const worker = composedOptions("../../worker/src/index.ts", source);
    for (const options of [api, worker]) {
      expect(options.trustedBindings).toHaveLength(1);
      expect(
        Boolean(
          matchingOfficeBinding(
            options.trustedBindings!,
            server,
            binding,
            options.trustedNativeAuthority,
          ),
        ),
      ).toBe(enabled);
      expect(options.trustedNativeAuthority).toBe(env.BETTER_AUTH_URL ?? env.WEB_ORIGIN);
    }
  });
});

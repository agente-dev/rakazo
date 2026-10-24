import type { McpServer } from "@rakazo/db";
import { z } from "zod";

const identity = z.string().min(1).max(200);
const Binding = z
  .object({
    kind: z.literal("office-decisions-v1"),
    nativeAuthority: z.url(),
    officeId: identity,
    spaceId: identity,
    userId: identity,
    botId: identity,
    serverId: identity,
    serverRevision: z.number().int().positive(),
    endpoint: z.url().refine((value) => {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }),
    protectedTools: z.array(identity).min(1).max(20),
    members: z
      .array(
        z
          .object({ nativeUserId: identity, nativeSpaceId: identity, officeMemberId: identity })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();
export type TrustedOfficeBinding = z.infer<typeof Binding>;

/** Deployment configuration, NOT MCP settings or a tool-supplied trust flag. */
export function trustedMcpBindingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TrustedOfficeBinding[] {
  if (!env.TRUSTED_MCP_BINDINGS) return [];
  try {
    const parsed = z.array(Binding).max(1000).safeParse(JSON.parse(env.TRUSTED_MCP_BINDINGS));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function matchingOfficeBinding(
  bindings: readonly TrustedOfficeBinding[],
  server: McpServer,
  scope: { spaceId: string; userId: string; botId?: string },
  nativeAuthority: string | undefined,
): TrustedOfficeBinding | undefined {
  const candidates = bindings.filter(
    (b) =>
      b.spaceId === scope.spaceId &&
      b.userId === scope.userId &&
      b.botId === scope.botId &&
      b.serverId === server.id,
  );
  if (candidates.length !== 1) return undefined;
  const b = candidates[0]!;
  if (
    !nativeAuthority ||
    b.nativeAuthority !== nativeAuthority ||
    !server.enabled ||
    server.transport !== "streamable_http" ||
    server.spaceId !== b.spaceId ||
    server.userId !== b.userId ||
    server.revision !== b.serverRevision ||
    server.endpoint !== b.endpoint ||
    !server.secretId
  )
    return undefined;
  return b;
}

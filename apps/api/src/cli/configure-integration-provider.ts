import { pathToFileURL } from "node:url";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { createSecretStore, IntegrationProviderSettings } from "@rakazo/adapters";
import type { IntegrationProviderConfig } from "@rakazo/contracts";
import { IntegrationProviderOperatorInputSchema } from "@rakazo/contracts";
import { resolveEncryptionKey } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createDb, requireMembership, runAsSystem } from "@rakazo/db";

const MAX_INPUT_BYTES = 65536;

/** Private OS/database operator ingress, never a browser route or an identity grant.
 * Existing membership selects the encrypted secret namespace, not operator authorization.
 */
export async function configureIntegrationProvider(
  input: string,
  deps: {
    context(userId: string, spaceId: string): Promise<AdapterContext>;
    save(config: IntegrationProviderConfig, context: AdapterContext): Promise<void>;
  },
) {
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES)
    throw new Error("Configuration input is too large");
  const parsed = IntegrationProviderOperatorInputSchema.parse(JSON.parse(input));
  const context = await deps.context(parsed.userId, parsed.spaceId);
  await deps.save(parsed.config, context);
}

async function main() {
  if (process.argv.length !== 2 || process.stdin.isTTY)
    throw new Error("Private standard input is required");
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES)
      throw new Error("Configuration input is too large");
  }
  loadRootEnv();
  if (!process.env.DATABASE_URL) throw new Error("Database configuration is required");
  const { prisma, pool } = createDb(process.env.DATABASE_URL);
  const key = resolveEncryptionKey(process.env);
  const secrets = createSecretStore(key, process.env);
  try {
    await secrets.start();
    const settings = new IntegrationProviderSettings(prisma, secrets, key);
    await runAsSystem("private integration provider configuration", () =>
      configureIntegrationProvider(input, {
        context: async (userId, spaceId) => {
          const actor = await requireMembership(prisma, userId, spaceId);
          return {
            operationId: "operator-provider-configuration",
            traceId: "operator-provider-configuration",
            ...actor,
            signal: AbortSignal.timeout(60000),
          };
        },
        save: (config, context) => settings.save(config, context),
      }),
    );
    process.stdout.write("Integration provider configured\n");
  } finally {
    await secrets.close();
    await prisma.$disconnect();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Could not configure integration provider.\n");
    process.exitCode = 1;
  });
}

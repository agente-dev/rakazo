import * as z from "zod";

export const IntegrationProviderIdSchema = z.enum(["composio", "pipedream"]);
/** Operator-owned toolkit bindings; identifiers are never repaired or silently merged. */
export const IntegrationAuthConfigsSchema = z
  .record(z.string().min(1).max(100), z.string().min(1).max(200))
  .superRefine((bindings, ctx) => {
    const seen = new Set<string>();
    for (const [toolkit, id] of Object.entries(bindings)) {
      const key = toolkit.toLowerCase();
      if (
        !toolkit.trim() ||
        toolkit !== toolkit.trim() ||
        !id.trim() ||
        id !== id.trim() ||
        seen.has(key)
      ) {
        ctx.addIssue({
          code: "custom",
          path: [toolkit],
          message: "Toolkit authentication bindings must be nonblank and unambiguous",
        });
      }
      seen.add(key);
    }
  });

export const IntegrationProviderConfigSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("composio"),
    apiKey: z.string().trim().min(1).max(16384),
    authConfigs: IntegrationAuthConfigsSchema.optional(),
  }),
  z.object({
    provider: z.literal("pipedream"),
    clientId: z.string().trim().min(1).max(512),
    clientSecret: z.string().trim().min(1).max(16384),
    projectId: z.string().trim().min(1).max(512),
    environment: z.enum(["production", "development"]).default("production"),
  }),
]);
export type IntegrationProviderConfig = z.infer<typeof IntegrationProviderConfigSchema>;
export type IntegrationProviderId = z.infer<typeof IntegrationProviderIdSchema>;
export const IntegrationSetupStateSchema = z.object({
  canConfigure: z.boolean(),
  needsSetup: z.boolean(),
  webUrl: z.string().url(),
  providers: z.array(z.object({ id: IntegrationProviderIdSchema, configured: z.boolean() })),
});
export type IntegrationSetupState = z.infer<typeof IntegrationSetupStateSchema>;

/** Private operator command input; deliberately not exposed by the forbidden browser save. */
export const IntegrationProviderOperatorInputSchema = z
  .object({
    userId: z.string().min(1),
    spaceId: z.string().min(1),
    config: IntegrationProviderConfigSchema,
  })
  .strict();

import { z } from "zod";

const identity = z.string().min(1).max(200);
export const OfficeDecisionInput = z.object({ officeId: identity, requestId: z.uuid() }).strict();
export const OfficeDecisionDelivery = z.object({
  state: z.enum(["activity-only", "delivery-failed", "native-send-accepted"]),
  retryable: z.boolean(),
});
export type OfficeDecisionDelivery = z.infer<typeof OfficeDecisionDelivery>;

/** Values-free response from the authenticated, operator-bound Office read tool. */
export const OfficeDecisionRead = z.object({
  version: z.literal(1),
  office_id: identity,
  request_id: z.uuid(),
  requester_bot_id: identity,
  office_member_id: identity,
  authorized: z.literal(true),
  status: z.enum(["pending", "approved", "rejected", "expired", "stale"]),
  decision_id: identity.nullable(),
});
export type OfficeDecisionRead = z.infer<typeof OfficeDecisionRead>;

/** Server-only provenance; never accepted from a browser or model argument. */
export const OfficeRequestProvenance = z.object({
  version: z.literal(1),
  officeId: identity,
  requestId: z.uuid(),
  spaceId: identity,
  userId: identity,
  botId: identity,
  serverId: identity,
  serverRevision: z.number().int().positive(),
  threadId: identity,
  groupId: identity.nullable(),
  runId: identity,
  runLeaseFence: z.number().int().nonnegative(),
  toolExecutionId: identity,
  toolName: identity,
  humanMessageId: identity,
  messageId: identity,
  historyGeneration: z.number().int().nonnegative(),
});
export type OfficeRequestProvenance = z.infer<typeof OfficeRequestProvenance>;

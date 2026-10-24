import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { McpConnector } from "@rakazo/adapters";
import type { Actor, OfficeDecisionDelivery } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  deliverRecordedOfficeRejection,
  findOfficeRequestForDelivery,
  runAsSystem,
} from "@rakazo/db";

/** The only cross-employee authority: one recorded request, fixed canonical rejection.
 * Nothing here returns A's target, private messages, tool content or history to B.
 */
export async function deliverOfficeRejection(
  deps: {
    prisma: PrismaClient;
    mcp?: Pick<McpConnector, "officeBindingFor" | "officeBindingsForActor" | "readOfficeDecision">;
    events: Pick<ThreadEvents, "notify">;
    jobs: JobPublisher;
  },
  actor: Actor,
  input: { officeId: string; requestId: string },
  signal: AbortSignal,
): Promise<OfficeDecisionDelivery> {
  const activity = { state: "activity-only", retryable: false } as const;
  if (!deps.mcp) return activity;
  try {
    return await runAsSystem("Office decision: deliver exact recorded rejection", async () => {
      // Existing authenticated native actor stays the caller. No impersonated actor/send RPC.
      const member = await deps.prisma.spaceMember.findFirst({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
        select: { id: true },
      });
      if (!member) return activity;
      const eligibleBindings = deps.mcp!.officeBindingsForActor(input.officeId, actor);
      if (!eligibleBindings.length) return activity;
      const receipt = await findOfficeRequestForDelivery(
        deps.prisma,
        input.officeId,
        input.requestId,
      );
      if (!receipt) return activity;
      const binding = deps.mcp!.officeBindingFor(receipt);
      if (!binding || !eligibleBindings.includes(binding)) return activity;
      const decision = await deps.mcp!.readOfficeDecision(binding, input.requestId, actor, signal);
      if (decision?.status !== "rejected" || !decision.decision_id) return activity;
      const delivery = await deliverRecordedOfficeRejection(deps.prisma, receipt, actor, decision);
      if (!delivery) return activity;
      if (delivery.eventSeq !== null) {
        // A missed wake never changes the durable message/run. Explicit retry reuses it.
        await deps.events.notify(receipt.threadId, delivery.eventSeq).catch(() => undefined);
      }
      if (delivery.status === "queued") await deps.jobs.enqueue(runContinueJob(delivery.runId));
      return { state: "native-send-accepted", retryable: false } as const;
    });
  } catch {
    // Office decision was committed by the caller's separate Office transaction.
    // Never re-decide or repeat a protected tool when native delivery fails.
    return { state: "delivery-failed", retryable: true };
  }
}

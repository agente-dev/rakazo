import type {
  Actor,
  MessageBlock,
  OfficeDecisionRead,
  OfficeRequestProvenance,
} from "@rakazo/contracts";
import { OfficeRequestProvenance as Provenance } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction, sendMessageInTransaction } from "./events.js";
import { lockOwnedGroup } from "./groups.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { runAsSystemInTransaction } from "./row-security.js";
import { withTransactionRetry } from "./transaction-retry.js";

export type OfficeReceiptSource = Omit<
  OfficeRequestProvenance,
  "version" | "messageId" | "humanMessageId" | "historyGeneration" | "threadId" | "groupId"
>;

/** No chat lookup by bot id: only a real human-origin run can produce a receipt. */
export async function recordOfficeRequest(prisma: PrismaClient, source: OfficeReceiptSource) {
  const hint = await prisma.run.findFirst({
    where: {
      id: source.runId,
      spaceId: source.spaceId,
      userId: source.userId,
      botId: source.botId,
    },
    select: { threadId: true, sourceMessageId: true },
  });
  if (!hint?.sourceMessageId) return null;
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${hint.threadId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM messages WHERE id = ${hint.sourceMessageId}
        AND "threadId" = ${hint.threadId} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${source.runId}
        AND "spaceId" = ${source.spaceId} AND "userId" = ${source.userId} FOR SHARE`;
      const run = await tx.run.findFirst({
        where: {
          id: source.runId,
          spaceId: source.spaceId,
          userId: source.userId,
          botId: source.botId,
          threadId: hint.threadId,
          status: "running",
          leaseFence: source.runLeaseFence,
          trigger: { in: ["user", "follow_up", "reaction"] },
        },
        select: {
          id: true,
          threadId: true,
          sourceMessage: { select: { id: true, role: true, threadId: true } },
          thread: {
            select: {
              groupId: true,
              userId: true,
              spaceId: true,
              externalConversationId: true,
              historyCompactionGeneration: true,
            },
          },
        },
      });
      const human = run?.sourceMessage;
      if (
        !run ||
        !human ||
        human.role !== "user" ||
        human.threadId !== run.threadId ||
        run.thread.externalConversationId ||
        run.thread.userId !== source.userId ||
        run.thread.spaceId !== source.spaceId
      )
        return null;
      const candidate = {
        ...source,
        version: 1 as const,
        threadId: run.threadId,
        groupId: run.thread.groupId,
        humanMessageId: human.id,
        messageId: "pending",
        historyGeneration: run.thread.historyCompactionGeneration,
      };
      if (
        !(await validateOrigin(
          tx,
          candidate,
          { spaceId: source.spaceId, userId: source.userId },
          false,
        ))
      )
        return null;
      // The request key serializes separate threads as well as retries of this execution.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`office:${source.officeId}:${source.requestId}`}))::text`;
      const existingRows = await runAsSystemInTransaction(
        tx,
        "Office receipt: exact request conflict check",
        () =>
          tx.officeRequestReceipt.findMany({
            where: { officeId: source.officeId, requestId: source.requestId },
            take: 2,
          }),
      );
      const existing = existingRows[0];
      if (existing) {
        if (existing.ambiguous) return null;
        const parsed = Provenance.safeParse({ ...existing, version: 1 });
        if (
          existingRows.length !== 1 ||
          !parsed.success ||
          !sameSource({ ...parsed.data, runLeaseFence: source.runLeaseFence }, candidate)
        ) {
          await runAsSystemInTransaction(
            tx,
            "Office receipt: reject exact conflicting request",
            () =>
              tx.officeRequestReceipt.updateMany({
                where: { officeId: source.officeId, requestId: source.requestId },
                data: { ambiguous: true },
              }),
          );
          return null;
        }
        return (await validateOrigin(
          tx,
          parsed.data,
          { spaceId: source.spaceId, userId: source.userId },
          true,
        ))
          ? parsed.data
          : null;
      }
      const blocks: MessageBlock[] = [{ kind: "meta", text: "Approval pending" }];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        botId: source.botId,
        runId: source.runId,
        role: "bot",
        blocks,
        clientNonce: `office-request:v1:${source.officeId}:${source.requestId}`,
      });
      const receipt: OfficeRequestProvenance = { ...candidate, messageId: message.id };
      const { version: _version, ...data } = receipt;
      await tx.officeRequestReceipt.create({ data });
      await appendEventInTransaction(tx, {
        spaceId: source.spaceId,
        threadId: run.threadId,
        botId: source.botId,
        runId: source.runId,
        type: "thread.message.created",
        // Existing event envelope keeps older web/desktop/mobile clients compatible.
        payload: { messageId: message.id, role: "bot", blocks, officeRequest: receipt },
      });
      return receipt;
    }),
  );
}

export async function findOfficeRequest(
  prisma: PrismaClient,
  spaceId: string,
  officeId: string,
  requestId: string,
): Promise<OfficeRequestProvenance | null> {
  const row = await prisma.officeRequestReceipt.findUnique({
    where: { spaceId_officeId_requestId: { spaceId, officeId, requestId } },
  });
  const parsed = Provenance.safeParse(row && !row.ambiguous && { ...row, version: 1 });
  return parsed.success ? parsed.data : null;
}

export async function findOfficeRequestForDelivery(
  prisma: PrismaClient,
  officeId: string,
  requestId: string,
) {
  const rows = await prisma.officeRequestReceipt.findMany({
    where: { officeId, requestId },
    take: 2,
  });
  if (rows.length !== 1 || rows[0]!.ambiguous) return null;
  const parsed = Provenance.safeParse({ ...rows[0], version: 1 });
  return parsed.success ? parsed.data : null;
}

function sameSource(a: OfficeRequestProvenance, b: OfficeRequestProvenance) {
  return (
    a.officeId === b.officeId &&
    a.requestId === b.requestId &&
    a.spaceId === b.spaceId &&
    a.userId === b.userId &&
    a.botId === b.botId &&
    a.serverId === b.serverId &&
    a.serverRevision === b.serverRevision &&
    a.threadId === b.threadId &&
    a.groupId === b.groupId &&
    a.runId === b.runId &&
    a.runLeaseFence === b.runLeaseFence &&
    a.toolExecutionId === b.toolExecutionId &&
    a.toolName === b.toolName &&
    a.humanMessageId === b.humanMessageId &&
    a.historyGeneration === b.historyGeneration
  );
}

/** Thread first, then group/bot and membership, matching clear/send lock order. */
async function validateOrigin(
  tx: Prisma.TransactionClient,
  r: OfficeRequestProvenance,
  caller: Pick<Actor, "spaceId" | "userId">,
  requireMarker: boolean,
) {
  const thread = await tx.thread.findFirst({
    where: {
      id: r.threadId,
      spaceId: r.spaceId,
      userId: r.userId,
      historyCompactionGeneration: r.historyGeneration,
      externalConversationId: null,
    },
    select: { botId: true, groupId: true },
  });
  if (
    !thread ||
    thread.groupId !== r.groupId ||
    (r.groupId ? thread.botId !== null : thread.botId !== r.botId)
  )
    return false;
  // Individual message deletion need not take the history-clear thread lock.
  await tx.$queryRaw`SELECT id FROM messages WHERE "threadId" = ${r.threadId}
    AND id IN (${r.humanMessageId}, ${r.messageId}) ORDER BY id FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM runs WHERE id = ${r.runId}
    AND "threadId" = ${r.threadId} AND "spaceId" = ${r.spaceId} FOR SHARE`;
  const members = await tx.$queryRaw<Array<{ spaceId: string; userId: string }>>`
    SELECT "spaceId", "userId" FROM space_members WHERE
      ("spaceId" = ${r.spaceId} AND "userId" = ${r.userId}) OR
      ("spaceId" = ${caller.spaceId} AND "userId" = ${caller.userId}) FOR SHARE`;
  if (
    ![{ spaceId: r.spaceId, userId: r.userId }, caller].every((scope) =>
      members.some((member) => member.spaceId === scope.spaceId && member.userId === scope.userId),
    )
  )
    return false;
  await tx.$queryRaw`SELECT id FROM bots WHERE id = ${r.botId} FOR SHARE`;
  if (
    !(await tx.bot.findFirst({
      where: {
        id: r.botId,
        userId: r.userId,
        spaceId: r.spaceId,
        archivedAt: null,
      },
      select: { id: true },
    }))
  )
    return false;
  if (r.groupId) {
    await lockOwnedGroup(tx, { spaceId: r.spaceId, userId: r.userId }, r.groupId);
    if (
      !(await tx.chatGroup.findFirst({
        where: {
          id: r.groupId,
          spaceId: r.spaceId,
          userId: r.userId,
          archivedAt: null,
          members: { some: { botId: r.botId } },
        },
        select: { id: true },
      }))
    )
      return false;
  }
  const run = await tx.run.findFirst({
    where: {
      id: r.runId,
      threadId: r.threadId,
      spaceId: r.spaceId,
      userId: r.userId,
      botId: r.botId,
      sourceMessageId: r.humanMessageId,
      status: { not: "cancelled" },
      trigger: { in: ["user", "follow_up", "reaction"] },
    },
    select: { id: true },
  });
  if (
    !run ||
    !(await tx.message.findFirst({
      where: {
        id: r.humanMessageId,
        threadId: r.threadId,
        role: "user",
      },
      select: { id: true },
    }))
  )
    return false;
  return (
    !requireMarker ||
    Boolean(
      await tx.message.findFirst({
        where: {
          id: r.messageId,
          threadId: r.threadId,
          role: "bot",
          botId: r.botId,
          runId: r.runId,
          clientNonce: `office-request:v1:${r.officeId}:${r.requestId}`,
        },
        select: { id: true },
      }),
    )
  );
}

export function officeRejectionText(requestId: string) {
  return `Office request ${requestId} was rejected by a human. This is the authoritative outcome for the original request. Tell the employee the change was rejected. Do not submit the change again without a new explicit human request.`;
}

/** Internal integration actor, not a general cross-user send or an origin-reading RPC.
 * The caller has already read the canonical decision through the pinned authenticated MCP server.
 */
export async function deliverRecordedOfficeRejection(
  prisma: PrismaClient,
  receipt: OfficeRequestProvenance,
  actor: Pick<Actor, "spaceId" | "userId">,
  decision: OfficeDecisionRead,
) {
  if (
    decision.status !== "rejected" ||
    !decision.decision_id ||
    !decision.authorized ||
    decision.request_id !== receipt.requestId ||
    decision.office_id !== receipt.officeId ||
    decision.requester_bot_id !== receipt.botId
  )
    return null;
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${receipt.threadId} FOR UPDATE`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`office:${receipt.officeId}:${receipt.requestId}`}))::text`;
      const row = await tx.officeRequestReceipt.findUnique({
        where: {
          spaceId_officeId_requestId: {
            spaceId: receipt.spaceId,
            officeId: receipt.officeId,
            requestId: receipt.requestId,
          },
        },
      });
      const parsed = Provenance.safeParse(row && { ...row, version: 1 });
      if (
        !row ||
        row.ambiguous ||
        !parsed.success ||
        !sameSource(parsed.data, receipt) ||
        row.messageId !== receipt.messageId ||
        !(await validateOrigin(tx, parsed.data, actor, true))
      )
        return null;
      // Pin and assignment are rechecked under the same transaction before replay OR insertion.
      await tx.$queryRaw`SELECT id FROM mcp_servers WHERE id = ${receipt.serverId} FOR SHARE`;
      if (
        !(await tx.botMcpServer.findFirst({
          where: {
            botId: receipt.botId,
            serverId: receipt.serverId,
            spaceId: receipt.spaceId,
            userId: receipt.userId,
            server: {
              enabled: true,
              revision: receipt.serverRevision,
              spaceId: receipt.spaceId,
              userId: receipt.userId,
            },
          },
          select: { id: true },
        }))
      )
        return null;
      if (row.decisionId && row.decisionId !== decision.decision_id) return null;
      const nonce = `office-decision:v1:${receipt.officeId}:${receipt.requestId}:rejected`;
      if (row.deliveryMessageId) {
        const message = await tx.message.findFirst({
          where: {
            id: row.deliveryMessageId,
            threadId: receipt.threadId,
            role: "system",
            replyToMessageId: receipt.messageId,
            clientNonce: nonce,
          },
          select: { id: true, blocks: true },
        });
        const expectedBlocks = [{ kind: "text", text: officeRejectionText(receipt.requestId) }];
        if (!message || JSON.stringify(message.blocks) !== JSON.stringify(expectedBlocks))
          return null;
        const run = row.deliveryRunId
          ? await tx.run.findFirst({
              where: {
                id: row.deliveryRunId,
                threadId: receipt.threadId,
                spaceId: receipt.spaceId,
                userId: receipt.userId,
                botId: receipt.botId,
                status: { not: "cancelled" },
              },
              select: { id: true, status: true },
            })
          : null;
        return run
          ? { messageId: message.id, runId: run.id, eventSeq: null, status: run.status }
          : null;
      }
      // Ordinary user sends can name a nonce, but cannot manufacture this internal effect.
      if (
        await tx.message.findUnique({
          where: {
            threadId_clientNonce: {
              threadId: receipt.threadId,
              clientNonce: nonce,
            },
          },
          select: { id: true },
        })
      )
        return null;
      const text = officeRejectionText(receipt.requestId);
      const result = await sendMessageInTransaction(
        tx,
        {
          spaceId: receipt.spaceId,
          userId: receipt.userId,
          threadId: receipt.threadId,
          botId: receipt.botId,
          trigger: "follow_up",
          prompt: text,
          blocks: [{ kind: "text", text }],
          linkMessageToRun: true,
          clientNonce: nonce,
        },
        {
          replyToMessageId: receipt.messageId,
          decision: {
            officeId: receipt.officeId,
            requestId: receipt.requestId,
            decisionId: decision.decision_id!,
            byUserId: actor.userId,
            bySpaceId: actor.spaceId,
          },
        },
      );
      const run = result.run ?? result.busy;
      if (!run) throw new Error("Office delivery has no run");
      await tx.officeRequestReceipt.update({
        where: {
          spaceId_officeId_requestId: {
            spaceId: receipt.spaceId,
            officeId: receipt.officeId,
            requestId: receipt.requestId,
          },
        },
        data: {
          decisionId: decision.decision_id,
          deliveryMessageId: result.message.id,
          deliveryRunId: run.id,
        },
      });
      return {
        messageId: result.message.id,
        runId: run.id,
        eventSeq: result.event.seq,
        status: "queued",
      };
    }),
  );
}

/** A rejection turn is not a new human instruction to repeat a protected operation. */
export async function officeProtectedCallBlocked(
  prisma: PrismaClient,
  runId: string,
  botId: string,
) {
  const run = await prisma.run.findFirst({
    where: { id: runId, botId },
    select: { threadId: true },
  });
  if (!run) return true;
  const decision = await prisma.message.findFirst({
    where: {
      threadId: run.threadId,
      role: "system",
      clientNonce: { startsWith: "office-decision:v1:" },
    },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  if (!decision) return false;
  const human = await prisma.message.findFirst({
    where: {
      threadId: run.threadId,
      role: "user",
      seq: { gt: decision.seq },
    },
    select: { id: true },
  });
  return !human;
}

/** A durable integration source remains report-only even if a later human turn arrives. */
export async function officeDecisionRunReportOnly(
  prisma: PrismaClient,
  run: {
    id: string;
    sourceMessageId: string | null;
    threadId: string;
    botId: string;
    userId: string;
    spaceId: string;
  },
) {
  if (!run.sourceMessageId) return false;
  const receipt = await prisma.officeRequestReceipt.findFirst({
    where: {
      deliveryMessageId: run.sourceMessageId,
      threadId: run.threadId,
      botId: run.botId,
      userId: run.userId,
      spaceId: run.spaceId,
      ambiguous: false,
    },
    select: { decisionId: true },
  });
  if (!receipt?.decisionId) return false;
  return Boolean(
    await prisma.message.findFirst({
      where: {
        id: run.sourceMessageId,
        threadId: run.threadId,
        role: "system",
        clientNonce: { startsWith: "office-decision:v1:" },
      },
      select: { id: true },
    }),
  );
}

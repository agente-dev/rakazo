-- Additive only: older API versions do not read this optional integration table.
CREATE TABLE "office_request_receipts" (
  "spaceId" TEXT NOT NULL,
  "officeId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "serverRevision" INTEGER NOT NULL,
  "threadId" TEXT NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE,
  "groupId" TEXT,
  "runId" TEXT NOT NULL,
  "toolExecutionId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "humanMessageId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "historyGeneration" INTEGER NOT NULL,
  "decisionId" TEXT,
  "ambiguous" BOOLEAN NOT NULL DEFAULT false,
  "deliveryMessageId" TEXT,
  "deliveryRunId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("spaceId", "officeId", "requestId")
);
CREATE INDEX "office_request_receipts_threadId_idx" ON "office_request_receipts"("threadId");
ALTER TABLE "office_request_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "office_request_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "office_request_receipts_scope" ON "office_request_receipts"
  USING (current_setting('app.rls_bypass', true) = 'on' OR
    ("spaceId" = current_setting('app.space_id', true) AND "userId" = current_setting('app.user_id', true)))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR
    ("spaceId" = current_setting('app.space_id', true) AND "userId" = current_setting('app.user_id', true)));

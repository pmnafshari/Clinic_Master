-- Voice tool calls must be auditable before the caller has been identified,
-- so an audit row can exist without a user.
ALTER TABLE "AuditLog" ALTER COLUMN "userId" DROP NOT NULL;

-- Correlates every tool call made in one conversation.
--
-- This stores `session.logId`, NOT `session.sessionId`. The sessionId is a
-- 256-bit bearer credential: whoever holds one can resume the conversation
-- inside the session TTL, read back whatever intake collected, and inherit the
-- session's patientId. Writing it here would leave live credentials at rest in
-- a table any DB read, backup, or ops query can reach. The logId is the
-- non-secret correlation id, which is all an audit trail needs. The column is
-- named for what it holds so the next reader is not misled.
ALTER TABLE "AuditLog" ADD COLUMN "sessionLogId" TEXT;

CREATE INDEX "AuditLog_sessionLogId_idx" ON "AuditLog"("sessionLogId");

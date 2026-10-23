import { desc, eq } from "drizzle-orm";
import { authorize, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import { auditLogs } from "@/server/db/schema";

const REDACTED_KEYS = new Set(["password", "passwordHash", "token", "accessToken", "refreshToken", "secret"]);

function sanitizePayload(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(sanitizePayload);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTED_KEYS.has(k) ? "[REDACTED]" : sanitizePayload(v);
    }
    return out;
  }
  return value;
}

export interface RecordAuditInput {
  ctx?: ActorContext | null;
  action: string;
  entityType: string;
  entityId: string;
  warehouseId?: string | null;
  beforeData?: unknown;
  afterData?: unknown;
  reason?: string | null;
}

/**
 * Append an immutable audit entry inside the active transaction (`tx`).
 */
export async function recordAudit(tx: DbExecutor, input: RecordAuditInput): Promise<number> {
  const [inserted] = await tx
    .insert(auditLogs)
    .values({
      actorUserId: input.ctx?.user.id ?? null,
      actorName: input.ctx?.user.name ?? "SYSTEM",
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      warehouseId: input.warehouseId ?? null,
      beforeData: input.beforeData !== undefined ? sanitizePayload(input.beforeData) : null,
      afterData: input.afterData !== undefined ? sanitizePayload(input.afterData) : null,
      reason: input.reason ?? null,
      requestId: input.ctx?.requestId ?? null,
      ipAddress: input.ctx?.ipAddress ?? null,
    })
    .returning({ id: auditLogs.id });

  return inserted!.id;
}

export async function listAuditLogs(
  db: DbExecutor,
  ctx: ActorContext,
  options?: { entityType?: string; limit?: number },
) {
  authorize(ctx, "audit.read");
  const limit = Math.min(options?.limit ?? 100, 500);
  if (options?.entityType) {
    return db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityType, options.entityType))
      .orderBy(desc(auditLogs.id))
      .limit(limit);
  }
  return db.select().from(auditLogs).orderBy(desc(auditLogs.id)).limit(limit);
}

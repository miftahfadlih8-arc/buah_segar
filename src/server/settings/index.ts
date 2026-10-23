import crypto from "node:crypto";
import { and, desc, eq, lte } from "drizzle-orm";
import { recordAudit } from "@/server/audit";
import { authorize, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import { settings } from "@/server/db/schema";
import { BusinessRuleError } from "@/server/errors";

export interface SetSettingInput {
  key: string;
  value: unknown;
  description?: string;
  reason: string;
  effectiveFrom?: Date;
}

/**
 * Append a new versioned setting row (settings are immutable/append-only).
 */
export async function setSetting(tx: DbExecutor, ctx: ActorContext, input: SetSettingInput) {
  authorize(ctx, "settings.manage");
  if (!input.reason.trim()) {
    throw new BusinessRuleError("Alasan perubahan pengaturan sistem wajib diisi.");
  }

  const previous = await getSetting(tx, input.key);
  const id = crypto.randomUUID();
  const [created] = await tx
    .insert(settings)
    .values({
      id,
      key: input.key,
      value: input.value,
      description: input.description ?? null,
      effectiveFrom: input.effectiveFrom ?? new Date(),
      changedBy: ctx.user.id,
      reason: input.reason.trim(),
    })
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "setting.change",
    entityType: "setting",
    entityId: input.key,
    beforeData: previous,
    afterData: created,
    reason: input.reason.trim(),
  });

  return created!;
}

/**
 * Fetch the active setting row for `key` at time `at` (defaults to `now()`).
 */
export async function getSetting<T = unknown>(
  db: DbExecutor,
  key: string,
  at: Date = new Date(),
): Promise<{ key: string; value: T; effectiveFrom: Date } | null> {
  const [row] = await db
    .select()
    .from(settings)
    .where(and(eq(settings.key, key), lte(settings.effectiveFrom, at)))
    .orderBy(desc(settings.effectiveFrom), desc(settings.createdAt))
    .limit(1);

  if (!row) return null;
  return {
    key: row.key,
    value: row.value as T,
    effectiveFrom: row.effectiveFrom,
  };
}

export async function listSettingsHistory(db: DbExecutor, ctx: ActorContext) {
  authorize(ctx, "settings.read");
  return db.select().from(settings).orderBy(desc(settings.createdAt)).limit(100);
}

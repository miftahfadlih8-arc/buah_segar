import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { recordAudit } from "@/server/audit";
import { authorize, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import { approvals } from "@/server/db/schema";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/server/errors";

export type ApprovalType =
  | "price_override"
  | "credit_limit_override"
  | "stock_adjustment"
  | "stock_count_variance"
  | "supplier_substitution"
  | "po_price_variance"
  | "po_over_tolerance"
  | "negative_stock_override"
  | "fulfillment_substitution"
  | "fulfillment_variance_override";

export interface RequestApprovalInput {
  approvalType: ApprovalType;
  sourceDocType: string;
  sourceDocId: string;
  warehouseId?: string | null;
  requestReason: string;
  ruleSnapshot?: Record<string, unknown>;
}

export async function requestApproval(
  tx: DbExecutor,
  ctx: ActorContext,
  input: RequestApprovalInput,
) {
  if (!input.requestReason.trim()) {
    throw new BusinessRuleError("Alasan permintaan persetujuan wajib diisi.");
  }
  const id = crypto.randomUUID();
  const [created] = await tx
    .insert(approvals)
    .values({
      id,
      approvalType: input.approvalType,
      sourceDocType: input.sourceDocType,
      sourceDocId: input.sourceDocId,
      warehouseId: input.warehouseId ?? null,
      status: "pending",
      requestedBy: ctx.user.id,
      requestReason: input.requestReason.trim(),
      ruleSnapshot: input.ruleSnapshot ?? null,
    })
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "approval.request",
    entityType: "approval",
    entityId: id,
    warehouseId: input.warehouseId ?? null,
    afterData: created,
    reason: input.requestReason.trim(),
  });

  return created!;
}

export interface DecideApprovalInput {
  approvalId: string;
  decision: "approved" | "rejected";
  decisionNote: string;
  expectedVersion: number;
}

export async function decideApproval(
  tx: DbExecutor,
  ctx: ActorContext,
  input: DecideApprovalInput,
) {
  const [existing] = await tx
    .select()
    .from(approvals)
    .where(eq(approvals.id, input.approvalId))
    .limit(1);

  if (!existing) {
    throw new NotFoundError("Permintaan persetujuan tidak ditemukan.");
  }

  authorize(ctx, "approvals.decide", { warehouseId: existing.warehouseId });

  if (existing.status !== "pending") {
    throw new BusinessRuleError(`Permintaan ini sudah diputuskan (${existing.status}).`);
  }

  const isOwner = ctx.roles.some((r) => r.roleCode === "owner");
  if (existing.requestedBy === ctx.user.id && !isOwner) {
    throw new BusinessRuleError(
      "Pemohon tidak dapat menyetujui permintaannya sendiri (kecuali Pemilik Bisnis).",
    );
  }

  if (!input.decisionNote.trim()) {
    throw new BusinessRuleError("Catatan keputusan persetujuan wajib diisi.");
  }

  const [updated] = await tx
    .update(approvals)
    .set({
      status: input.decision,
      decidedBy: ctx.user.id,
      decidedAt: new Date(),
      decisionNote: input.decisionNote.trim(),
      version: existing.version + 1,
    })
    .where(and(eq(approvals.id, input.approvalId), eq(approvals.version, input.expectedVersion)))
    .returning();

  if (!updated) {
    throw new ConflictError("Permintaan persetujuan telah diubah oleh pengguna lain.");
  }

  await recordAudit(tx, {
    ctx,
    action: `approval.${input.decision}`,
    entityType: "approval",
    entityId: updated.id,
    warehouseId: updated.warehouseId,
    beforeData: existing,
    afterData: updated,
    reason: input.decisionNote.trim(),
  });

  return updated;
}

export async function listApprovals(db: DbExecutor, ctx: ActorContext) {
  authorize(ctx, "approvals.read");
  return db.select().from(approvals).orderBy(desc(approvals.requestedAt)).limit(100);
}

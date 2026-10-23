import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { decideApproval, requestApproval } from "@/server/approvals";
import { listAuditLogs, recordAudit } from "@/server/audit";
import { authorize } from "@/server/authz/authorize";
import { withTransaction } from "@/server/db";
import { branches, warehouses } from "@/server/db/schema";
import {
  BusinessRuleError,
  ForbiddenError,
  IdempotencyConflictError,
  UnauthenticatedError,
} from "@/server/errors";
import { withIdempotency } from "@/server/idempotency";
import { nextDocumentNumber } from "@/server/sequences";
import { getSetting, setSetting } from "@/server/settings";
import { closeDb, createTestActor, setupTestDb } from "../helpers/test-db";

describe("Phase 2 Foundation — RBAC, Append-Only Audit, Idempotency, Sequences, Approvals, Settings", () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("enforces server-side RBAC, suspended-account checks, and cross-warehouse isolation", async () => {
    const db = await setupTestDb();
    await db.insert(branches).values({
      id: "br_bks",
      code: "BKS",
      name: "Cabang Bekasi",
      city: "Bekasi",
    });
    await db.insert(warehouses).values([
      {
        id: "wh_bks1",
        branchId: "br_bks",
        code: "BKS1",
        name: "Gudang Utama Cibitung",
        address: "Jl. Bosih Raya, Bekasi",
        isDefault: true,
      },
      {
        id: "wh_bks2",
        branchId: "br_bks",
        code: "BKS2",
        name: "Gudang Cabang Jatiasih",
        address: "Jl. Raya Jatiasih, Bekasi",
        isDefault: false,
      },
    ]);

    expect(() => authorize(null, "catalog.read")).toThrow(UnauthenticatedError);

    const wh1Operator = await createTestActor(db, {
      name: "Operator Gudang BKS1",
      grants: [{ roleCode: "warehouse", warehouseId: "wh_bks1" }],
    });

    // Allowed on assigned warehouse BKS1
    expect(() =>
      authorize(wh1Operator, "receiving.write", { warehouseId: "wh_bks1" }),
    ).not.toThrow();

    // Denied on unassigned warehouse BKS2
    expect(() =>
      authorize(wh1Operator, "receiving.write", { warehouseId: "wh_bks2" }),
    ).toThrow(ForbiddenError);

    // Denied on permission not granted to warehouse role
    expect(() => authorize(wh1Operator, "users.manage")).toThrow(ForbiddenError);

    // Suspended user is rejected even with owner role
    const suspendedOwner = await createTestActor(db, {
      status: "suspended",
      grants: [{ roleCode: "owner" }],
    });
    expect(() => authorize(suspendedOwner, "catalog.read")).toThrow(ForbiddenError);
  });

  it("writes sanitized audit logs and blocks UPDATE/DELETE via PostgreSQL trigger", async () => {
    const db = await setupTestDb();
    const owner = await createTestActor(db, {
      name: "Pemilik Uji",
      grants: [{ roleCode: "owner" }],
    });

    const auditId = await recordAudit(db, {
      ctx: owner,
      action: "user.create",
      entityType: "user",
      entityId: "usr_target",
      afterData: {
        username: "staf_gudang",
        password: "rahasia-tidak-boleh-tampil",
      },
      reason: "Pembuatan akun staf gudang baru",
    });

    const logs = await listAuditLogs(db, owner, { entityType: "user" });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.id).toBe(auditId);
    expect((logs[0]!.afterData as Record<string, unknown>).password).toBe("[REDACTED]");

    // Attempt UPDATE and DELETE directly in SQL — trigger must reject both
    const updateErr = await db
      .execute(sql`UPDATE audit_logs SET action = 'tampered' WHERE id = ${auditId}`)
      .then(
        () => null,
        (e: { cause?: Error }) => e,
      );
    expect(String(updateErr?.cause?.message ?? updateErr)).toMatch(/append-only/);

    const deleteErr = await db
      .execute(sql`DELETE FROM audit_logs WHERE id = ${auditId}`)
      .then(
        () => null,
        (e: { cause?: Error }) => e,
      );
    expect(String(deleteErr?.cause?.message ?? deleteErr)).toMatch(/append-only/);
  });

  it("enforces idempotency replay for identical payload and rejects conflicting payload", async () => {
    const db = await setupTestDb();
    const owner = await createTestActor(db, { grants: [{ roleCode: "owner" }] });

    let executions = 0;
    const first = await withTransaction((tx) =>
      withIdempotency(
        tx,
        {
          scope: "payment.record",
          key: "idem-001",
          payload: { invoiceId: "inv_1", amount: "1500000" },
          actorUserId: owner.user.id,
        },
        async () => {
          executions += 1;
          return { receiptNo: "PAY/BKS1/2610/00001", amount: "1500000" };
        },
      ),
    );
    expect(first.replayed).toBe(false);
    expect(executions).toBe(1);

    // Retry with identical key and payload replays stored response without re-running fn
    const second = await withTransaction((tx) =>
      withIdempotency(
        tx,
        {
          scope: "payment.record",
          key: "idem-001",
          payload: { amount: "1500000", invoiceId: "inv_1" },
          actorUserId: owner.user.id,
        },
        async () => {
          executions += 1;
          return { receiptNo: "PAY/BKS1/2610/00002", amount: "1500000" };
        },
      ),
    );
    expect(second.replayed).toBe(true);
    expect(second.result.receiptNo).toBe("PAY/BKS1/2610/00001");
    expect(executions).toBe(1);

    // Retry with same key but different amount throws IdempotencyConflictError
    await expect(
      withTransaction((tx) =>
        withIdempotency(
          tx,
          {
            scope: "payment.record",
            key: "idem-001",
            payload: { invoiceId: "inv_1", amount: "999999" },
            actorUserId: owner.user.id,
          },
          async () => ({ receiptNo: "NEVER" }),
        ),
      ),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("allocates gap-free document numbers and rolls back sequence on transaction failure", async () => {
    await setupTestDb();
    const fixedDate = new Date("2026-10-20T05:00:00.000Z");

    const firstNo = await withTransaction((tx) =>
      nextDocumentNumber(tx, { docType: "INV", warehouseCode: "BKS1", at: fixedDate }),
    );
    expect(firstNo).toBe("INV/BKS1/2610/00001");

    // Simulate a failed transaction that rolls back after allocating a number
    await expect(
      withTransaction(async (tx) => {
        const rolledBackNo = await nextDocumentNumber(tx, {
          docType: "INV",
          warehouseCode: "BKS1",
          at: fixedDate,
        });
        expect(rolledBackNo).toBe("INV/BKS1/2610/00002");
        throw new Error("Simulated failure before commit");
      }),
    ).rejects.toThrow(/Simulated failure/);

    // Next committed transaction must get 00002 with no gap
    const secondCommittedNo = await withTransaction((tx) =>
      nextDocumentNumber(tx, { docType: "INV", warehouseCode: "BKS1", at: fixedDate }),
    );
    expect(secondCommittedNo).toBe("INV/BKS1/2610/00002");
  });

  it("handles approval workflow and append-only versioned settings", async () => {
    const db = await setupTestDb();
    const salesUser = await createTestActor(db, {
      name: "Staf Sales",
      grants: [{ roleCode: "sales" }],
    });
    const owner = await createTestActor(db, {
      name: "Pemilik",
      grants: [{ roleCode: "owner" }],
    });

    const req = await withTransaction((tx) =>
      requestApproval(tx, salesUser, {
        approvalType: "price_override",
        sourceDocType: "sales_order",
        sourceDocId: "so_101",
        requestReason: "Diskon khusus pelanggan HORECA kontrak bulanan",
        ruleSnapshot: { minMarginPct: "10.00", proposedMarginPct: "7.50" },
      }),
    );
    expect(req.status).toBe("pending");

    // Sales cannot approve
    await expect(
      withTransaction((tx) =>
        decideApproval(tx, salesUser, {
          approvalId: req.id,
          decision: "approved",
          decisionNote: "Coba setujui sendiri",
          expectedVersion: req.version,
        }),
      ),
    ).rejects.toThrow(ForbiddenError);

    // Owner approves
    const decided = await withTransaction((tx) =>
      decideApproval(tx, owner, {
        approvalId: req.id,
        decision: "approved",
        decisionNote: "Disetujui untuk kontrak Oktober",
        expectedVersion: req.version,
      }),
    );
    expect(decided.status).toBe("approved");
    expect(decided.version).toBe(2);

    // Cannot decide an already decided approval
    await expect(
      withTransaction((tx) =>
        decideApproval(tx, owner, {
          approvalId: req.id,
          decision: "rejected",
          decisionNote: "Ubah pikiran",
          expectedVersion: decided.version,
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Versioned settings are append-only
    await withTransaction((tx) =>
      setSetting(tx, owner, {
        key: "inventory.costing_policy",
        value: { method: "lot_actual_fefo", gradeAllocation: "relative_sales_value" },
        reason: "Kebijakan awal Phase 2",
      }),
    );
    const activeSetting = await getSetting<{ method: string }>(db, "inventory.costing_policy");
    expect(activeSetting?.value.method).toBe("lot_actual_fefo");

    const delSettingErr = await db
      .execute(sql`DELETE FROM settings WHERE key = 'inventory.costing_policy'`)
      .then(
        () => null,
        (e: { cause?: Error }) => e,
      );
    expect(String(delSettingErr?.cause?.message ?? delSettingErr)).toMatch(/append-only/);
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { authorize, hasPermission, isSuperAdmin } from "@/server/authz/authorize";
import { branches, warehouses } from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";
import { closeDb, createTestActor, setupTestDb } from "../helpers/test-db";

describe("Role Segregation & Admin Universal Access", () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("grants role 'admin' and 'owner' unrestricted universal access across all modules and warehouses", async () => {
    const db = await setupTestDb();
    const adminActor = await createTestActor(db, {
      name: "Admin Sistem",
      grants: [{ roleCode: "admin" }],
    });
    const ownerActor = await createTestActor(db, {
      name: "Owner Bisnis",
      grants: [{ roleCode: "owner" }],
    });

    expect(isSuperAdmin(adminActor)).toBe(true);
    expect(isSuperAdmin(ownerActor)).toBe(true);

    const testPermissions = [
      "catalog.read",
      "catalog.write",
      "supplier.read",
      "supplier.write",
      "procurement.read",
      "procurement.write",
      "receiving.read",
      "receiving.write",
      "qc.inspect",
      "warehouse.read",
      "warehouse.write",
      "inventory.read",
      "inventory.adjust",
      "pricing.read",
      "pricing.write",
      "customer.read",
      "customer.write",
      "customer.credit_manage",
      "sales.read",
      "sales.write",
      "fulfillment.pick_pack",
      "delivery.execute",
      "ar.read",
      "ar.invoice",
      "ar.collect",
      "ap.read",
      "ap.pay",
      "gl.read",
      "gl.post",
      "returns.read",
      "returns.write",
      "users.read",
      "users.manage",
      "audit.read",
      "settings.read",
      "settings.manage",
      "approvals.read",
      "approvals.decide",
    ] as const;

    for (const perm of testPermissions) {
      // Both admin and owner must succeed on all permissions
      expect(hasPermission(adminActor, perm)).toBe(true);
      expect(hasPermission(ownerActor, perm)).toBe(true);

      expect(() => authorize(adminActor, perm)).not.toThrow();
      expect(() => authorize(ownerActor, perm)).not.toThrow();

      // Universal warehouse access - even for arbitrary warehouse IDs
      expect(() => authorize(adminActor, perm, { warehouseId: "wh_any_warehouse" })).not.toThrow();
      expect(() => authorize(ownerActor, perm, { warehouseId: "wh_any_warehouse" })).not.toThrow();
    }
  });

  it("strictly enforces segregation of duties (SoD) for non-admin operational roles", async () => {
    const db = await setupTestDb();
    await db.insert(branches).values({
      id: "br_bks",
      code: "BKS",
      name: "Cabang Bekasi",
      city: "Bekasi",
    });
    await db.insert(warehouses).values({
      id: "wh_bks1",
      branchId: "br_bks",
      code: "BKS1",
      name: "Gudang Cibitung",
      address: "Jl. Bosih Raya",
    });

    const procurementActor = await createTestActor(db, {
      name: "Staf Pengadaan",
      grants: [{ roleCode: "procurement" }],
    });
    const warehouseActor = await createTestActor(db, {
      name: "Operator Gudang",
      grants: [{ roleCode: "warehouse", warehouseId: "wh_bks1" }],
    });
    const qcActor = await createTestActor(db, {
      name: "Staf QC",
      grants: [{ roleCode: "qc" }],
    });
    const salesActor = await createTestActor(db, {
      name: "Staf Sales",
      grants: [{ roleCode: "sales" }],
    });
    const financeActor = await createTestActor(db, {
      name: "Staf Keuangan",
      grants: [{ roleCode: "finance" }],
    });

    // None of these should be super admin
    expect(isSuperAdmin(procurementActor)).toBe(false);
    expect(isSuperAdmin(warehouseActor)).toBe(false);
    expect(isSuperAdmin(qcActor)).toBe(false);
    expect(isSuperAdmin(salesActor)).toBe(false);
    expect(isSuperAdmin(financeActor)).toBe(false);

    // 1. Procurement: can do procurement and supplier, CANNOT do GL, AR, sales write, warehouse write, or users
    expect(hasPermission(procurementActor, "procurement.write")).toBe(true);
    expect(hasPermission(procurementActor, "supplier.read")).toBe(true);
    expect(hasPermission(procurementActor, "gl.read")).toBe(false);
    expect(hasPermission(procurementActor, "gl.post")).toBe(false);
    expect(hasPermission(procurementActor, "ar.read")).toBe(false);
    expect(hasPermission(procurementActor, "ar.invoice")).toBe(false);
    expect(hasPermission(procurementActor, "sales.write")).toBe(false);
    expect(hasPermission(procurementActor, "warehouse.write")).toBe(false);
    expect(hasPermission(procurementActor, "users.manage")).toBe(false);
    expect(() => authorize(procurementActor, "gl.read")).toThrow(ForbiddenError);

    // 2. Warehouse: can do warehouse, fulfillment, and delivery, CANNOT do procurement write, GL, pricing, or sales write
    expect(hasPermission(warehouseActor, "warehouse.write")).toBe(true);
    expect(hasPermission(warehouseActor, "fulfillment.pick_pack")).toBe(true);
    expect(hasPermission(warehouseActor, "delivery.execute")).toBe(true);
    expect(hasPermission(warehouseActor, "procurement.write")).toBe(false);
    expect(hasPermission(warehouseActor, "gl.read")).toBe(false);
    expect(hasPermission(warehouseActor, "pricing.write")).toBe(false);
    expect(hasPermission(warehouseActor, "sales.write")).toBe(false);
    expect(hasPermission(warehouseActor, "ar.invoice")).toBe(false);
    expect(() => authorize(warehouseActor, "pricing.write")).toThrow(ForbiddenError);

    // 3. QC: can do QC inspect and receiving read, CANNOT do procurement, sales, GL, AR, or warehouse write
    expect(hasPermission(qcActor, "qc.inspect")).toBe(true);
    expect(hasPermission(qcActor, "receiving.read")).toBe(true);
    expect(hasPermission(qcActor, "procurement.write")).toBe(false);
    expect(hasPermission(qcActor, "sales.write")).toBe(false);
    expect(hasPermission(qcActor, "gl.read")).toBe(false);
    expect(hasPermission(qcActor, "ar.invoice")).toBe(false);
    expect(hasPermission(qcActor, "warehouse.write")).toBe(false);
    expect(() => authorize(qcActor, "warehouse.write")).toThrow(ForbiddenError);

    // 4. Sales: can do sales write, pricing read, customer write, CANNOT do procurement, warehouse write, GL, AR invoice
    expect(hasPermission(salesActor, "sales.write")).toBe(true);
    expect(hasPermission(salesActor, "customer.write")).toBe(true);
    expect(hasPermission(salesActor, "pricing.read")).toBe(true);
    expect(hasPermission(salesActor, "procurement.write")).toBe(false);
    expect(hasPermission(salesActor, "warehouse.write")).toBe(false);
    expect(hasPermission(salesActor, "fulfillment.pick_pack")).toBe(false);
    expect(hasPermission(salesActor, "gl.read")).toBe(false);
    expect(hasPermission(salesActor, "ar.invoice")).toBe(false);
    expect(() => authorize(salesActor, "gl.read")).toThrow(ForbiddenError);

    // 5. Finance: can do AR, AP, GL, pricing, customer credit, CANNOT do physical warehouse write, QC inspect, delivery
    expect(hasPermission(financeActor, "ar.read")).toBe(true);
    expect(hasPermission(financeActor, "ar.invoice")).toBe(true);
    expect(hasPermission(financeActor, "ar.collect")).toBe(true);
    expect(hasPermission(financeActor, "gl.read")).toBe(true);
    expect(hasPermission(financeActor, "gl.post")).toBe(true);
    expect(hasPermission(financeActor, "customer.credit_manage")).toBe(true);
    expect(hasPermission(financeActor, "pricing.write")).toBe(true);
    expect(hasPermission(financeActor, "warehouse.write")).toBe(false);
    expect(hasPermission(financeActor, "qc.inspect")).toBe(false);
    expect(hasPermission(financeActor, "delivery.execute")).toBe(false);
    expect(hasPermission(financeActor, "users.manage")).toBe(false);
    expect(() => authorize(financeActor, "warehouse.write")).toThrow(ForbiddenError);
  });

  it("blocks suspended accounts even if they have super-admin (admin or owner) role", async () => {
    const db = await setupTestDb();
    const suspendedAdmin = await createTestActor(db, {
      name: "Admin Nonaktif",
      status: "suspended",
      grants: [{ roleCode: "admin" }],
    });
    const suspendedOwner = await createTestActor(db, {
      name: "Owner Nonaktif",
      status: "suspended",
      grants: [{ roleCode: "owner" }],
    });

    expect(() => authorize(suspendedAdmin, "catalog.read")).toThrow(ForbiddenError);
    expect(() => authorize(suspendedOwner, "catalog.read")).toThrow(ForbiddenError);
    expect(hasPermission(suspendedAdmin, "catalog.read")).toBe(false);
    expect(hasPermission(suspendedOwner, "catalog.read")).toBe(false);
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listAuditLogs } from "@/server/audit";
import { getAuth } from "@/server/auth";
import { withTransaction } from "@/server/db";
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
} from "@/server/errors";
import {
  createPackagingType,
  createProduct,
  listProductsWithDetails,
  seedStandardUomsAndPackaging,
  updateProduct,
  upsertProductUomConversion,
} from "@/server/modules/master/catalog";
import {
  createCustomer,
  listCustomers,
  seedDefaultBekasiZones,
  updateCustomerCreditPolicy,
} from "@/server/modules/master/customers";
import {
  createSupplier,
  listSuppliers,
  updateSupplier,
} from "@/server/modules/master/suppliers";
import {
  createWarehouse,
  createWarehouseLocation,
  listWarehouseLocations,
  seedDefaultBekasiWarehouse,
} from "@/server/modules/master/warehouses";
import {
  createUserAccount,
  listUsersWithRoles,
  setUserStatus,
} from "@/server/modules/users";
import { setSetting } from "@/server/settings";
import { closeDb, createTestActor, setupTestDb } from "../helpers/test-db";

describe("Phase 2 Master Data & User Management — Integration Tests", () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("manages products, default grades A/B/C, UoM conversions, and optimistic lock conflicts", async () => {
    const db = await setupTestDb();
    await withTransaction((tx) => seedStandardUomsAndPackaging(tx));

    const procurementUser = await createTestActor(db, {
      name: "Staf Pengadaan",
      grants: [{ roleCode: "procurement" }],
    });
    const salesUser = await createTestActor(db, {
      name: "Staf Sales",
      grants: [{ roleCode: "sales" }],
    });

    // Sales cannot create products
    await expect(
      withTransaction((tx) =>
        createProduct(tx, salesUser, {
          sku: "MNG-HARUM-01",
          name: "Mangga Harum Manis Probolinggo",
          category: "Buah Lokal",
          baseUomCode: "kg",
          defaultShelfLifeDays: 6,
          isCatchWeight: true,
          ripenessTracking: true,
          storageCondition: "ambient",
          taxCode: "PPN_EXEMPT",
          minMarginPct: "12.00",
          minSellingPrice: "18000",
        }),
      ),
    ).rejects.toThrow(ForbiddenError);

    // Procurement creates product with default grades A/B/C
    const mangga = await withTransaction((tx) =>
      createProduct(tx, procurementUser, {
        sku: "MNG-HARUM-01",
        name: "Mangga Harum Manis Probolinggo",
        category: "Buah Lokal",
        variety: "Harum Manis Matang Pohon",
        baseUomCode: "kg",
        defaultShelfLifeDays: 6,
        isCatchWeight: true,
        ripenessTracking: true,
        storageCondition: "ambient",
        taxCode: "PPN_EXEMPT",
        minMarginPct: "12.00",
        minSellingPrice: "18000",
      }),
    );

    // Add UoM conversion: 1 peti ≈ 22 kg (nominal catch-weight)
    await withTransaction((tx) =>
      upsertProductUomConversion(tx, procurementUser, {
        productId: mangga.id,
        uomCode: "peti",
        factorToBase: "22",
        isNominal: true,
        requiresActualWeight: true,
        defaultPackagingTypeId: "pkg_peti_kayu",
      }),
    );

    await withTransaction((tx) =>
      createPackagingType(tx, procurementUser, {
        code: "KRAT-VENT-25",
        name: "Krat Ventilasi 25 Kg",
        defaultTareKg: "1.950",
        isReusable: true,
      }),
    );

    const catalogList = await listProductsWithDetails(db, salesUser);
    expect(catalogList).toHaveLength(1);
    expect(catalogList[0]!.grades.map((g) => g.code)).toEqual(["A", "B", "C"]);
    expect(catalogList[0]!.uomConversions).toHaveLength(1);
    expect(catalogList[0]!.uomConversions[0]!.factorToBase).toBe("22.0000");

    // Update product version 1 -> 2
    const updated = await withTransaction((tx) =>
      updateProduct(tx, procurementUser, {
        id: mangga.id,
        sku: mangga.sku,
        name: "Mangga Harum Manis Super Probolinggo",
        category: mangga.category,
        variety: mangga.variety,
        baseUomCode: "kg",
        isCatchWeight: true,
        defaultShelfLifeDays: 7,
        ripenessTracking: true,
        storageCondition: "ambient",
        taxCode: "PPN_EXEMPT",
        minMarginPct: "14.00",
        minSellingPrice: "19500",
        isActive: true,
        expectedVersion: 1,
      }),
    );
    expect(updated.version).toBe(2);

    // Stale expectedVersion (1) must throw ConflictError
    await expect(
      withTransaction((tx) =>
        updateProduct(tx, procurementUser, {
          id: mangga.id,
          sku: mangga.sku,
          name: "Stale Update",
          category: mangga.category,
          baseUomCode: "kg",
          isCatchWeight: true,
          defaultShelfLifeDays: 7,
          ripenessTracking: true,
          storageCondition: "ambient",
          taxCode: "PPN_EXEMPT",
          minMarginPct: "14.00",
          minSellingPrice: "19500",
          isActive: true,
          expectedVersion: 1,
        }),
      ),
    ).rejects.toThrow(ConflictError);
  });

  it("manages suppliers and masks bank account / NPWP for warehouse roles", async () => {
    const db = await setupTestDb();
    const procurement = await createTestActor(db, {
      grants: [{ roleCode: "procurement" }],
    });
    const warehouseOp = await createTestActor(db, {
      grants: [{ roleCode: "warehouse" }],
    });

    const sup = await withTransaction((tx) =>
      createSupplier(tx, procurement, {
        code: "SUP-MLG-01",
        name: "Kelompok Tani Apel & Jeruk Batu",
        supplierType: "koperasi",
        originRegion: "Batu, Malang, Jawa Timur",
        contactPerson: "Pak Hendra",
        phone: "081234567890",
        paymentTermsDays: 7,
        bankName: "BRI",
        bankAccountNo: "005101998877665",
        bankAccountHolder: "KT Batu Makmur",
        npwp: "012345678901000",
        leadTimeDays: 2,
      }),
    );

    const updatedSup = await withTransaction((tx) =>
      updateSupplier(tx, procurement, {
        id: sup.id,
        code: sup.code,
        name: sup.name,
        supplierType: "koperasi",
        originRegion: sup.originRegion,
        contactPerson: "Pak Hendra Wijaya",
        phone: sup.phone,
        paymentTermsDays: 14,
        bankName: sup.bankName,
        bankAccountNo: sup.bankAccountNo,
        bankAccountHolder: sup.bankAccountHolder,
        npwp: sup.npwp,
        leadTimeDays: 2,
        isActive: true,
        expectedVersion: 1,
      }),
    );
    expect(updatedSup.version).toBe(2);

    // Procurement has supplier.read_bank -> sees full bank account
    const forProcurement = await listSuppliers(db, procurement);
    expect(forProcurement[0]!.bankAccountNo).toBe("005101998877665");

    // Warehouse operator lacks supplier.read_bank -> sees masked bank account & NPWP
    const forWarehouse = await listSuppliers(db, warehouseOp);
    expect(forWarehouse[0]!.bankAccountNo).toBe("****7665");
    expect(forWarehouse[0]!.npwp).toBe("****1000");
  });

  it("enforces credit limit permissions, B2C feature flag, and customer audit logs", async () => {
    const db = await setupTestDb();
    await withTransaction((tx) => seedDefaultBekasiZones(tx));

    const sales = await createTestActor(db, { grants: [{ roleCode: "sales" }] });
    const finance = await createTestActor(db, { grants: [{ roleCode: "finance" }] });
    const owner = await createTestActor(db, { grants: [{ roleCode: "owner" }] });

    // Sales cannot create a customer with creditLimit > 0
    await expect(
      withTransaction((tx) =>
        createCustomer(tx, sales, {
          code: "CUST-HRC-01",
          name: "Hotel Horison Ultima Bekasi",
          segment: "horeca",
          priceTier: "horeca",
          shippingAddress: "Jl. KH. Noer Ali, Bekasi Selatan",
          deliveryZoneId: "zone_bks_selatan",
          paymentTermsDays: 14,
          creditLimit: "25.000.000",
        }),
      ),
    ).rejects.toThrow(ForbiddenError);

    // Sales can create cash customer (creditLimit = 0, paymentTermsDays = 0)
    const cust = await withTransaction((tx) =>
      createCustomer(tx, sales, {
        code: "CUST-HRC-01",
        name: "Hotel Horison Ultima Bekasi",
        segment: "horeca",
        priceTier: "horeca",
        contactPerson: "Chef Bima",
        phone: "081199887766",
        shippingAddress: "Jl. KH. Noer Ali, Bekasi Selatan",
        deliveryZoneId: "zone_bks_selatan",
        paymentTermsDays: 0,
        creditLimit: "0",
      }),
    );
    expect(cust.creditLimit).toBe("0.00");

    // Finance sets credit limit & 14-day terms with mandatory reason
    const creditUpdated = await withTransaction((tx) =>
      updateCustomerCreditPolicy(tx, finance, {
        customerId: cust.id,
        creditLimit: "25.000.000",
        paymentTermsDays: 14,
        creditHold: false,
        reason: "Kontrak pasokan buah bulanan terverifikasi",
        expectedVersion: 1,
      }),
    );
    expect(creditUpdated.creditLimit).toBe("25000000.00");
    expect(creditUpdated.paymentTermsDays).toBe(14);

    // Direct consumer (B2C) blocked while setting is disabled
    await expect(
      withTransaction((tx) =>
        createCustomer(tx, sales, {
          code: "CUST-B2C-01",
          name: "Konsumen Perorangan Galaxy",
          segment: "konsumen_langsung",
          priceTier: "ritel",
          shippingAddress: "Taman Galaxy, Bekasi Selatan",
          paymentTermsDays: 0,
          creditLimit: "0",
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Owner enables B2C setting -> B2C customer creation succeeds
    await withTransaction((tx) =>
      setSetting(tx, owner, {
        key: "sales.enable_direct_consumer",
        value: { enabled: true },
        reason: "Uji coba penjualan eceran akhir pekan",
      }),
    );
    const b2cCust = await withTransaction((tx) =>
      createCustomer(tx, sales, {
        code: "CUST-B2C-01",
        name: "Konsumen Perorangan Galaxy",
        segment: "konsumen_langsung",
        priceTier: "ritel",
        shippingAddress: "Taman Galaxy, Bekasi Selatan",
        paymentTermsDays: 0,
        creditLimit: "0",
      }),
    );
    expect(b2cCust.segment).toBe("konsumen_langsung");

    const allCustomers = await listCustomers(db, sales);
    expect(allCustomers).toHaveLength(2);

    const creditAudit = await listAuditLogs(db, owner, { entityType: "customer" });
    expect(creditAudit.some((a) => a.action === "customer.credit_change")).toBe(true);
  });

  it("manages warehouses, locations, Better Auth users, and protects the last active owner", async () => {
    const db = await setupTestDb();
    const { branchId, warehouseId } = await withTransaction((tx) =>
      seedDefaultBekasiWarehouse(tx),
    );
    const owner = await createTestActor(db, {
      name: "Pemilik Utama",
      grants: [{ roleCode: "owner" }],
    });

    const newWh = await withTransaction((tx) =>
      createWarehouse(tx, owner, {
        branchId,
        code: "BKS2",
        name: "Gudang Transit Cikarang",
        address: "Kawasan Industri Jababeka, Cikarang",
        isDefault: false,
      }),
    );
    await withTransaction((tx) =>
      createWarehouseLocation(tx, owner, {
        warehouseId: newWh.id,
        code: "COLD-CKR-01",
        name: "Cold Room Cikarang 1",
        zoneType: "cold_room",
        temperatureMinC: "2.0",
        temperatureMaxC: "5.0",
      }),
    );

    const locations = await listWarehouseLocations(db, owner, warehouseId);
    expect(locations.length).toBeGreaterThanOrEqual(6);

    // Owner creates a warehouse staff account via Better Auth
    const createdStaff = await createUserAccount(db, owner, {
      name: "Rudi Hartono",
      username: "rudi_gudang",
      email: "rudi.gudang@bekasi-buah.test",
      phone: "081388776655",
      password: "SandiGudang2026!",
      roleCode: "warehouse",
      warehouseId,
    });
    expect(createdStaff.username).toBe("rudi_gudang");

    // Verify Better Auth sign-in works with username + password
    const auth = getAuth();
    const signInRes = await auth.api.signInUsername({
      body: {
        username: "rudi_gudang",
        password: "SandiGudang2026!",
      },
    });
    expect(signInRes?.user.id).toBe(createdStaff.id);

    // Owner cannot suspend themselves
    await expect(
      withTransaction((tx) =>
        setUserStatus(tx, owner, {
          userId: owner.user.id,
          status: "suspended",
          reason: "Coba nonaktifkan diri sendiri",
          expectedVersion: 1,
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Suspend the staff account
    const suspended = await withTransaction((tx) =>
      setUserStatus(tx, owner, {
        userId: createdStaff.id,
        status: "suspended",
        reason: "Mutasi tugas sementara",
        expectedVersion: 1,
      }),
    );
    expect(suspended.status).toBe("suspended");

    const userList = await listUsersWithRoles(db, owner);
    expect(userList.some((u) => u.username === "rudi_gudang" && u.status === "suspended")).toBe(
      true,
    );
  });
});

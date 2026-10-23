import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Core master data tables for Phase 2:
 * Branches, Warehouses, Warehouse Locations, UoMs, Packaging Types,
 * Products, Product Grades, Product UoM Conversions, Suppliers,
 * Delivery Zones, and Customers.
 */

export const branches = pgTable("branches", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  city: text("city").notNull().default("Bekasi"),
  address: text("address"),
  isActive: boolean("is_active").notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const warehouses = pgTable(
  "warehouses",
  {
    id: text("id").primaryKey(),
    branchId: text("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    address: text("address").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("warehouses_branch_idx").on(t.branchId)],
);

export const warehouseLocations = pgTable(
  "warehouse_locations",
  {
    id: text("id").primaryKey(),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    zoneType: text("zone_type", {
      enum: ["receiving", "cold_room", "ambient", "quarantine", "dispatch", "reject"],
    }).notNull(),
    temperatureMinC: numeric("temperature_min_c", { precision: 5, scale: 1 }),
    temperatureMaxC: numeric("temperature_max_c", { precision: 5, scale: 1 }),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("warehouse_locations_wh_code_uidx").on(t.warehouseId, t.code)],
);

export const uoms = pgTable("uoms", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  dimension: text("dimension", { enum: ["weight", "count", "package"] }).notNull(),
  isBaseAllowed: boolean("is_base_allowed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const packagingTypes = pgTable("packaging_types", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  defaultTareKg: numeric("default_tare_kg", { precision: 10, scale: 3 }).notNull().default("0.000"),
  isReusable: boolean("is_reusable").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable(
  "products",
  {
    id: text("id").primaryKey(),
    sku: text("sku").notNull().unique(),
    barcode: text("barcode").unique(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    variety: text("variety"),
    baseUomCode: text("base_uom_code")
      .notNull()
      .references(() => uoms.code, { onDelete: "restrict" }),
    isCatchWeight: boolean("is_catch_weight").notNull().default(true),
    defaultShelfLifeDays: integer("default_shelf_life_days").notNull(),
    ripenessTracking: boolean("ripeness_tracking").notNull().default(true),
    storageCondition: text("storage_condition", { enum: ["cold", "ambient"] })
      .notNull()
      .default("cold"),
    taxCode: text("tax_code", { enum: ["PPN_EXEMPT", "PPN_11"] })
      .notNull()
      .default("PPN_EXEMPT"),
    minMarginPct: numeric("min_margin_pct", { precision: 6, scale: 2 }).notNull().default("10.00"),
    minSellingPrice: numeric("min_selling_price", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("products_category_idx").on(t.category), index("products_name_idx").on(t.name)],
);

export const productGrades = pgTable(
  "product_grades",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    qualityRank: integer("quality_rank").notNull().default(1),
    minWeightGram: integer("min_weight_gram"),
    maxDefectPct: numeric("max_defect_pct", { precision: 5, scale: 2 }),
    priceMultiplierPct: numeric("price_multiplier_pct", { precision: 6, scale: 2 })
      .notNull()
      .default("100.00"),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("product_grades_product_code_uidx").on(t.productId, t.code)],
);

export const productUomConversions = pgTable(
  "product_uom_conversions",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    uomCode: text("uom_code")
      .notNull()
      .references(() => uoms.code, { onDelete: "restrict" }),
    factorToBase: numeric("factor_to_base", { precision: 14, scale: 4 }).notNull(),
    isNominal: boolean("is_nominal").notNull().default(true),
    requiresActualWeight: boolean("requires_actual_weight").notNull().default(true),
    defaultPackagingTypeId: text("default_packaging_type_id").references(() => packagingTypes.id, {
      onDelete: "set null",
    }),
    barcode: text("barcode"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("product_uom_conversions_uidx").on(t.productId, t.uomCode)],
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    supplierType: text("supplier_type", {
      enum: ["petani", "kebun", "grosir", "importir", "koperasi"],
    }).notNull(),
    originRegion: text("origin_region").notNull(),
    contactPerson: text("contact_person"),
    phone: text("phone"),
    address: text("address"),
    paymentTermsDays: integer("payment_terms_days").notNull().default(0),
    bankName: text("bank_name"),
    bankAccountNo: text("bank_account_no"),
    bankAccountHolder: text("bank_account_holder"),
    npwp: text("npwp"),
    leadTimeDays: integer("lead_time_days").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("suppliers_type_idx").on(t.supplierType)],
);

export const deliveryZones = pgTable("delivery_zones", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  city: text("city").notNull().default("Bekasi"),
  minOrderAmount: numeric("min_order_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
  defaultDeliveryFee: numeric("default_delivery_fee", { precision: 18, scale: 2 }).notNull().default("0.00"),
  isActive: boolean("is_active").notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customers = pgTable(
  "customers",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    segment: text("segment", {
      enum: [
        "toko_buah",
        "pedagang_pasar",
        "ritel_reseller",
        "horeca",
        "kedai_jus",
        "korporat",
        "konsumen_langsung",
      ],
    }).notNull(),
    priceTier: text("price_tier", {
      enum: ["grosir", "semi_grosir", "ritel", "horeca"],
    })
      .notNull()
      .default("grosir"),
    contactPerson: text("contact_person"),
    phone: text("phone"),
    whatsapp: text("whatsapp"),
    email: text("email"),
    shippingAddress: text("shipping_address").notNull(),
    billingAddress: text("billing_address"),
    deliveryZoneId: text("delivery_zone_id").references(() => deliveryZones.id, {
      onDelete: "set null",
    }),
    assignedWarehouseId: text("assigned_warehouse_id").references(() => warehouses.id, {
      onDelete: "set null",
    }),
    paymentTermsDays: integer("payment_terms_days").notNull().default(0),
    creditLimit: numeric("credit_limit", { precision: 18, scale: 2 }).notNull().default("0.00"),
    creditHold: boolean("credit_hold").notNull().default(false),
    npwp: text("npwp"),
    marketingConsent: boolean("marketing_consent").notNull().default(false),
    operationalConsent: boolean("operational_consent").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("customers_segment_idx").on(t.segment), index("customers_name_idx").on(t.name)],
);

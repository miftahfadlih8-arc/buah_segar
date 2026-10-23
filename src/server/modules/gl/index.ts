import crypto from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { businessDate } from "@/lib/datetime";
import { MoneyDecimal, parseMoney, roundRupiah, toDbAmount } from "@/lib/money";
import { recordAudit } from "@/server/audit";
import { authorize, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import { fiscalPeriods, glAccounts, journalEntries, journalLines, warehouses } from "@/server/db/schema";
import { BusinessRuleError, NotFoundError } from "@/server/errors";
import { evaluateCostingPolicyGate } from "@/server/modules/inventory/costing";
import { nextDocumentNumber } from "@/server/sequences";

/**
 * Canonical Chart of Accounts (COA) codes for Phase 3 (Receiving, Inventory, Spoilage, Adjustments).
 */
export const GL_ACCOUNT_CODES = {
  CASH_BANK: "1110",
  ACCOUNTS_RECEIVABLE: "1120",
  INVENTORY_FRUIT: "1140",
  AP_SUPPLIER: "2110",
  GRNI_ACCRUAL: "2115",
  VAT_OUT_LIABILITY: "2120",
  UNAPPLIED_CUSTOMER_CASH: "2130",
  OWNER_EQUITY: "3100",
  SALES_REVENUE: "4100",
  SALES_DISCOUNT_EXPENSE: "4200",
  COGS_FRUIT: "5100",
  SPOILAGE_EXPENSE: "5210",
  INVENTORY_VARIANCE: "5220",
  PURCHASE_PRICE_VARIANCE: "5230",
  BANK_CHARGES: "5240",
} as const;

export const DEFAULT_COA_ACCOUNTS = [
  {
    id: "coa_1110",
    code: GL_ACCOUNT_CODES.CASH_BANK,
    name: "Kas & Bank Operasional",
    accountType: "asset" as const,
    normalBalance: "debit" as const,
    parentCode: null,
  },
  {
    id: "coa_1120",
    code: GL_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
    name: "Piutang Usaha Pelanggan",
    accountType: "asset" as const,
    normalBalance: "debit" as const,
    parentCode: null,
  },
  {
    id: "coa_1140",
    code: GL_ACCOUNT_CODES.INVENTORY_FRUIT,
    name: "Persediaan Buah Segar",
    accountType: "asset" as const,
    normalBalance: "debit" as const,
    parentCode: null,
  },
  {
    id: "coa_2110",
    code: GL_ACCOUNT_CODES.AP_SUPPLIER,
    name: "Hutang Usaha Supplier & Petani",
    accountType: "liability" as const,
    normalBalance: "credit" as const,
    parentCode: null,
  },
  {
    id: "coa_2115",
    code: GL_ACCOUNT_CODES.GRNI_ACCRUAL,
    name: "Hutang Penerimaan Barang Belum Difakturkan (GRNI)",
    accountType: "liability" as const,
    normalBalance: "credit" as const,
    parentCode: null,
  },
  {
    id: "coa_2120",
    code: GL_ACCOUNT_CODES.VAT_OUT_LIABILITY,
    name: "Hutang PPN Keluaran",
    accountType: "liability" as const,
    normalBalance: "credit" as const,
    parentCode: null,
  },
  {
    id: "coa_2130",
    code: GL_ACCOUNT_CODES.UNAPPLIED_CUSTOMER_CASH,
    name: "Uang Muka / Kelebihan Pembayaran Pelanggan",
    accountType: "liability" as const,
    normalBalance: "credit" as const,
    parentCode: null,
  },
  {
    id: "coa_3100",
    code: GL_ACCOUNT_CODES.OWNER_EQUITY,
    name: "Modal Pemilik",
    accountType: "equity" as const,
    normalBalance: "credit" as const,
    parentCode: null,
  },
  {
    id: "coa_4100",
    code: GL_ACCOUNT_CODES.SALES_REVENUE,
    name: "Pendapatan Penjualan Buah",
    accountType: "revenue" as const,
    normalBalance: "credit" as const,
    parentCode: null,
  },
  {
    id: "coa_4200",
    code: GL_ACCOUNT_CODES.SALES_DISCOUNT_EXPENSE,
    name: "Potongan & Penyesuaian Penjualan / Klaim",
    accountType: "revenue" as const,
    normalBalance: "debit" as const,
    parentCode: null,
  },
  {
    id: "coa_5100",
    code: GL_ACCOUNT_CODES.COGS_FRUIT,
    name: "Harga Pokok Penjualan (HPP) Buah",
    accountType: "cogs" as const,
    normalBalance: "debit" as const,
    parentCode: null,
  },
  {
    id: "coa_5210",
    code: GL_ACCOUNT_CODES.SPOILAGE_EXPENSE,
    name: "Beban Susut, Busuk & Rusak Buah Pasca-Penerimaan",
    accountType: "expense" as const,
    normalBalance: "debit" as const,
    parentCode: null,
  },
  {
    id: "coa_5220",
    code: GL_ACCOUNT_CODES.INVENTORY_VARIANCE,
    name: "Beban / Selisih Penyesuaian & Opname Stok",
    accountType: "expense" as const,
    normalBalance: "debit" as const,
    parentCode: null,
  },
  {
    id: "coa_5230",
    code: GL_ACCOUNT_CODES.PURCHASE_PRICE_VARIANCE,
    name: "Selisih Harga Pembelian (Purchase Price Variance)",
    accountType: "expense" as const,
    normalBalance: "debit" as const,
    parentCode: null,
  },
  {
    id: "coa_5240",
    code: GL_ACCOUNT_CODES.BANK_CHARGES,
    name: "Beban Administrasi Bank & Kliring",
    accountType: "expense" as const,
    normalBalance: "debit" as const,
    parentCode: null,
  },
] as const;

export async function seedDefaultCoaAndFiscalPeriod(
  tx: DbExecutor,
  entryDate: string = businessDate(),
) {
  for (const acc of DEFAULT_COA_ACCOUNTS) {
    await tx
      .insert(glAccounts)
      .values({
        id: acc.id,
        code: acc.code,
        name: acc.name,
        accountType: acc.accountType,
        normalBalance: acc.normalBalance,
        parentCode: acc.parentCode,
        isPosting: true,
        isActive: true,
      })
      .onConflictDoNothing({ target: glAccounts.code });
  }

  return ensureOpenFiscalPeriod(tx, entryDate);
}

export async function ensureOpenFiscalPeriod(tx: DbExecutor, entryDate: string) {
  const parts = entryDate.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new BusinessRuleError(`Format tanggal akuntansi tidak valid: "${entryDate}"`);
  }
  const periodId = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;

  const [existing] = await tx
    .select()
    .from(fiscalPeriods)
    .where(eq(fiscalPeriods.id, periodId))
    .limit(1);

  if (existing) {
    if (existing.status !== "open") {
      throw new BusinessRuleError(
        `Periode akuntansi ${periodId} berstatus '${existing.status}' dan tidak dapat menerima posting jurnal baru.`,
      );
    }
    return existing;
  }

  await tx
    .insert(fiscalPeriods)
    .values({
      id: periodId,
      year,
      month,
      status: "open",
    })
    .onConflictDoNothing({ target: fiscalPeriods.id });

  const [created] = await tx
    .select()
    .from(fiscalPeriods)
    .where(eq(fiscalPeriods.id, periodId))
    .limit(1);

  if (!created || created.status !== "open") {
    throw new BusinessRuleError(
      `Periode akuntansi ${periodId} tidak terbuka untuk posting jurnal.`,
    );
  }
  return created;
}

export interface JournalLineInput {
  accountCode: string;
  debit?: string | number;
  credit?: string | number;
  warehouseId?: string | null;
  productId?: string | null;
  batchId?: string | null;
  description?: string;
}

export interface PostJournalEntryInput {
  entryDate?: string;
  warehouseId?: string | null;
  sourceDocType: string;
  sourceDocId: string;
  purpose: string;
  memo: string;
  lines: JournalLineInput[];
  enforceProductionGate?: boolean;
  skipDirectPermissionCheck?: boolean;
}

/**
 * Posts a balanced double-entry journal entry atomically within `tx`.
 * - Idempotent on `(sourceDocType, sourceDocId, purpose)`.
 * - Enforces `SUM(debit) === SUM(credit) > 0` both in TypeScript and via PostgreSQL DEFERRABLE constraint trigger.
 * - Evaluates the Costing Policy Gate before posting inventory valuations.
 */
export async function postJournalEntry(
  tx: DbExecutor,
  ctx: ActorContext,
  input: PostJournalEntryInput,
) {
  if (!input.skipDirectPermissionCheck) {
    authorize(ctx, "gl.post", { warehouseId: input.warehouseId ?? undefined });
  }

  if (!input.memo?.trim()) {
    throw new BusinessRuleError("Memo / keterangan jurnal wajib diisi.");
  }
  if (!input.lines || input.lines.length < 2) {
    throw new BusinessRuleError("Jurnal wajib memiliki minimal 2 baris (debit dan kredit).");
  }

  // Check if already posted for this (sourceDocType, sourceDocId, purpose)
  const [existing] = await tx
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.sourceDocType, input.sourceDocType),
        eq(journalEntries.sourceDocId, input.sourceDocId),
        eq(journalEntries.purpose, input.purpose),
      ),
    )
    .limit(1);

  if (existing) {
    const existingLines = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, existing.id))
      .orderBy(asc(journalLines.lineNo));
    return { entry: existing, lines: existingLines, idempotentReplay: true };
  }

  const entryDate = input.entryDate ?? businessDate();
  const period = await seedDefaultCoaAndFiscalPeriod(tx, entryDate);
  const gate = await evaluateCostingPolicyGate(tx, {
    enforceProductionGate: input.enforceProductionGate,
  });

  let totalDebit = new MoneyDecimal(0);
  let totalCredit = new MoneyDecimal(0);

  const normalizedLines = input.lines.map((line, idx) => {
    const debit = roundRupiah(parseMoney(line.debit ?? "0"));
    const credit = roundRupiah(parseMoney(line.credit ?? "0"));

    if (debit.lt(0) || credit.lt(0)) {
      throw new BusinessRuleError(`Baris jurnal #${idx + 1} tidak boleh bernilai negatif.`);
    }
    const isDebitOnly = debit.gt(0) && credit.isZero();
    const isCreditOnly = credit.gt(0) && debit.isZero();
    if (!isDebitOnly && !isCreditOnly) {
      throw new BusinessRuleError(
        `Baris jurnal #${idx + 1} (${line.accountCode}) wajib memiliki tepat satu sisi positif (debit saja atau kredit saja).`,
      );
    }

    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);

    return {
      lineNo: idx + 1,
      accountCode: line.accountCode,
      debit: toDbAmount(debit),
      credit: toDbAmount(credit),
      warehouseId: line.warehouseId ?? input.warehouseId ?? null,
      productId: line.productId ?? null,
      batchId: line.batchId ?? null,
      description: line.description ?? null,
    };
  });

  if (totalDebit.lte(0) || !totalDebit.eq(totalCredit)) {
    throw new BusinessRuleError(
      `Jurnal tidak seimbang: total debit (${toDbAmount(totalDebit)}) tidak sama dengan total kredit (${toDbAmount(totalCredit)}).`,
    );
  }

  let warehouseCode = "BKS1";
  if (input.warehouseId) {
    const [wh] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(eq(warehouses.id, input.warehouseId))
      .limit(1);
    if (wh) warehouseCode = wh.code;
  }

  const entryNo = await nextDocumentNumber(tx, {
    docType: "JRN",
    warehouseCode,
  });
  const entryId = `je_${crypto.randomUUID()}`;

  const [createdEntry] = await tx
    .insert(journalEntries)
    .values({
      id: entryId,
      entryNo,
      entryDate,
      fiscalPeriodId: period.id,
      warehouseId: input.warehouseId ?? null,
      sourceDocType: input.sourceDocType,
      sourceDocId: input.sourceDocId,
      purpose: input.purpose,
      memo: input.memo.trim(),
      isReversal: false,
      reversalOfEntryId: null,
      costingPolicyStatus: gate.status,
      totalDebit: toDbAmount(totalDebit),
      totalCredit: toDbAmount(totalCredit),
      postedBy: ctx.user.id,
    })
    .returning();

  const createdLines = await tx
    .insert(journalLines)
    .values(
      normalizedLines.map((l) => ({
        id: `jl_${crypto.randomUUID()}`,
        journalEntryId: entryId,
        lineNo: l.lineNo,
        accountCode: l.accountCode,
        debit: l.debit,
        credit: l.credit,
        warehouseId: l.warehouseId,
        productId: l.productId,
        batchId: l.batchId,
        description: l.description,
      })),
    )
    .returning();

  // Immediately evaluate PostgreSQL deferrable constraint trigger inside the current transaction
  await tx.execute(sql`SET CONSTRAINTS trg_journal_entry_balanced IMMEDIATE`);

  await recordAudit(tx, {
    ctx,
    action: "gl.journal_post",
    entityType: "journal_entry",
    entityId: entryId,
    warehouseId: input.warehouseId ?? null,
    afterData: { entry: createdEntry, lines: createdLines },
    reason: input.memo.trim(),
  });

  return { entry: createdEntry!, lines: createdLines, idempotentReplay: false };
}

export interface ReverseJournalEntryInput {
  journalEntryId: string;
  reason: string;
  entryDate?: string;
}

/**
 * Reverses a previously posted journal entry by inserting a new contra-entry (`isReversal = true`).
 * Does NOT mutate or delete the original entry or its lines.
 */
export async function reverseJournalEntry(
  tx: DbExecutor,
  ctx: ActorContext,
  input: ReverseJournalEntryInput,
) {
  if (!input.reason?.trim()) {
    throw new BusinessRuleError("Alasan pembalikan jurnal (reversal) wajib diisi.");
  }

  const [original] = await tx
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.id, input.journalEntryId))
    .limit(1);

  if (!original) {
    throw new NotFoundError("Jurnal yang akan dibalik tidak ditemukan.");
  }

  authorize(ctx, "gl.post", { warehouseId: original.warehouseId ?? undefined });

  const [alreadyReversed] = await tx
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.reversalOfEntryId, original.id))
    .limit(1);

  if (alreadyReversed) {
    throw new BusinessRuleError(
      `Jurnal ${original.entryNo} sudah pernah dibalik melalui jurnal ${alreadyReversed.entryNo}.`,
    );
  }

  const origLines = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.journalEntryId, original.id))
    .orderBy(asc(journalLines.lineNo));

  const entryDate = input.entryDate ?? businessDate();
  const period = await ensureOpenFiscalPeriod(tx, entryDate);

  let warehouseCode = "BKS1";
  if (original.warehouseId) {
    const [wh] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(eq(warehouses.id, original.warehouseId))
      .limit(1);
    if (wh) warehouseCode = wh.code;
  }

  const entryNo = await nextDocumentNumber(tx, {
    docType: "JRN",
    warehouseCode,
  });
  const reversalId = `je_${crypto.randomUUID()}`;

  const [reversalEntry] = await tx
    .insert(journalEntries)
    .values({
      id: reversalId,
      entryNo,
      entryDate,
      fiscalPeriodId: period.id,
      warehouseId: original.warehouseId,
      sourceDocType: "journal_entry_reversal",
      sourceDocId: original.id,
      purpose: "reversal",
      memo: `Pembalikan Jurnal ${original.entryNo}: ${input.reason.trim()}`,
      isReversal: true,
      reversalOfEntryId: original.id,
      costingPolicyStatus: original.costingPolicyStatus,
      totalDebit: original.totalCredit,
      totalCredit: original.totalDebit,
      postedBy: ctx.user.id,
    })
    .returning();

  const reversalLines = await tx
    .insert(journalLines)
    .values(
      origLines.map((l, idx) => ({
        id: `jl_${crypto.randomUUID()}`,
        journalEntryId: reversalId,
        lineNo: idx + 1,
        accountCode: l.accountCode,
        debit: l.credit,
        credit: l.debit,
        warehouseId: l.warehouseId,
        productId: l.productId,
        batchId: l.batchId,
        description: `Pembalikan: ${l.description ?? original.memo}`,
      })),
    )
    .returning();

  await tx.execute(sql`SET CONSTRAINTS trg_journal_entry_balanced IMMEDIATE`);

  await recordAudit(tx, {
    ctx,
    action: "gl.journal_reverse",
    entityType: "journal_entry",
    entityId: reversalId,
    warehouseId: original.warehouseId,
    beforeData: original,
    afterData: { entry: reversalEntry, lines: reversalLines },
    reason: input.reason.trim(),
  });

  return { entry: reversalEntry!, lines: reversalLines };
}

export async function getGlAccountBalance(
  db: DbExecutor,
  accountCode: string,
  options?: { warehouseId?: string },
): Promise<{
  accountCode: string;
  normalBalance: "debit" | "credit";
  totalDebit: string;
  totalCredit: string;
  netBalance: string;
}> {
  const [account] = await db
    .select()
    .from(glAccounts)
    .where(eq(glAccounts.code, accountCode))
    .limit(1);

  const normalBalance = account?.normalBalance ?? "debit";

  const conditions = [eq(journalLines.accountCode, accountCode)];
  if (options?.warehouseId) {
    conditions.push(eq(journalLines.warehouseId, options.warehouseId));
  }

  const [agg] = await db
    .select({
      sumDebit: sql<string>`COALESCE(SUM(${journalLines.debit}), 0)::numeric(18,2)`,
      sumCredit: sql<string>`COALESCE(SUM(${journalLines.credit}), 0)::numeric(18,2)`,
    })
    .from(journalLines)
    .where(and(...conditions));

  const debit = new MoneyDecimal(agg?.sumDebit ?? "0.00");
  const credit = new MoneyDecimal(agg?.sumCredit ?? "0.00");
  const net = normalBalance === "debit" ? debit.minus(credit) : credit.minus(debit);

  return {
    accountCode,
    normalBalance,
    totalDebit: toDbAmount(debit),
    totalCredit: toDbAmount(credit),
    netBalance: toDbAmount(net),
  };
}

export async function listChartOfAccounts(db: DbExecutor, ctx: ActorContext) {
  authorize(ctx, "gl.read");
  return db.select().from(glAccounts).orderBy(asc(glAccounts.code));
}

export async function listJournalEntriesWithLines(
  db: DbExecutor,
  ctx: ActorContext,
  options?: { warehouseId?: string; limit?: number },
) {
  authorize(ctx, "gl.read", { warehouseId: options?.warehouseId });
  const entries = await db
    .select()
    .from(journalEntries)
    .where(options?.warehouseId ? eq(journalEntries.warehouseId, options.warehouseId) : undefined)
    .orderBy(desc(journalEntries.postedAt))
    .limit(options?.limit ?? 50);

  const result = [];
  for (const entry of entries) {
    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entry.id))
      .orderBy(asc(journalLines.lineNo));
    result.push({ entry, lines });
  }
  return result;
}

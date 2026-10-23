import { sql } from "drizzle-orm";
import { periodKey } from "@/lib/datetime";
import type { DbExecutor } from "@/server/db";

export interface NextDocumentNumberInput {
  docType:
    | "PO"
    | "GRN"
    | "LOT"
    | "MOV"
    | "SPL"
    | "CNT"
    | "SQ"
    | "SO"
    | "FUL"
    | "DO"
    | "POD"
    | "CLM"
    | "INV"
    | "CN"
    | "PAY"
    | "ADJ"
    | "JRN";
  warehouseCode: string;
  at?: Date;
}

/**
 * Allocate the next gap-free sequential document number within the active transaction (`tx`).
 * Row-level locking on `document_sequences` guarantees no duplicates under concurrency, and
 * rolling back `tx` rolls back the sequence increment so no gap is left behind.
 *
 * Format: `<DOC_TYPE>/<WAREHOUSE_CODE>/<YYMM>/<00001>` (e.g. `INV/BKS1/2610/00001`)
 */
export async function nextDocumentNumber(
  tx: DbExecutor,
  input: NextDocumentNumberInput,
): Promise<string> {
  const period = periodKey(input.at ?? new Date());
  const wh = input.warehouseCode.toUpperCase();

  const res = await tx.execute<{ allocated: number }>(
    sql`INSERT INTO document_sequences (doc_type, warehouse_code, period, next_value, updated_at)
        VALUES (${input.docType}, ${wh}, ${period}, 2, now())
        ON CONFLICT (doc_type, warehouse_code, period)
        DO UPDATE SET
          next_value = document_sequences.next_value + 1,
          updated_at = now()
        RETURNING next_value - 1 AS allocated`,
  );

  const allocated = Number(res.rows[0]!.allocated);
  return `${input.docType}/${wh}/${period}/${String(allocated).padStart(5, "0")}`;
}

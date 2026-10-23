import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbExecutor } from "@/server/db";
import { idempotencyKeys } from "@/server/db/schema";
import { IdempotencyConflictError } from "@/server/errors";

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

export function hashPayload(payload: unknown): string {
  return crypto.createHash("sha256").update(canonicalize(payload)).digest("hex");
}

export interface IdempotencyOptions {
  scope: string;
  key: string;
  payload: unknown;
  actorUserId?: string | null;
  ttlHours?: number;
}

/**
 * Execute `fn` idempotently within `tx`.
 * - First call for `(scope, key)` runs `fn` and stores the JSON-serializable result.
 * - Subsequent call with the SAME `(scope, key)` and SAME `payload` returns the stored result without re-running `fn`.
 * - Subsequent call with the SAME `(scope, key)` and DIFFERENT `payload` throws `IdempotencyConflictError`.
 */
export async function withIdempotency<T>(
  tx: DbExecutor,
  options: IdempotencyOptions,
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const requestHash = hashPayload(options.payload);
  const ttlHours = options.ttlHours ?? 48;
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
  const id = crypto.randomUUID();

  // Serialize concurrent requests for the same (scope, key) inside PostgreSQL using an advisory xact lock
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${options.scope}), hashtext(${options.key}))`,
  );

  const existingRes = await tx.execute<{
    id: string;
    request_hash: string;
    status: "in_progress" | "completed";
    response_data: T;
  }>(
    sql`SELECT id, request_hash, status, response_data
        FROM idempotency_keys
        WHERE scope = ${options.scope} AND idem_key = ${options.key}
        FOR UPDATE`,
  );

  const existing = existingRes.rows[0];
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new IdempotencyConflictError(
        `Idempotency key '${options.key}' pada scope '${options.scope}' sudah dipakai dengan payload berbeda.`,
      );
    }
    return { result: existing.response_data, replayed: true };
  }

  await tx.insert(idempotencyKeys).values({
    id,
    scope: options.scope,
    idemKey: options.key,
    requestHash,
    status: "in_progress",
    actorUserId: options.actorUserId ?? null,
    expiresAt,
  });

  const result = await fn();

  await tx.execute(
    sql`UPDATE idempotency_keys
        SET status = 'completed', response_data = ${JSON.stringify(result)}::jsonb
        WHERE id = ${id}`,
  );

  return { result, replayed: false };
}

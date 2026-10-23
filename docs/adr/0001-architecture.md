# ADR 0001 — Modular Monolith Architecture & Technology Stack

- **Status:** Accepted (2026-10-20)
- **Context:** Fresh fruit distribution operating system in Bekasi, West Java, Indonesia. Initial deployment serves one legal entity and one warehouse in Bekasi, with architectural support for multiple branches, warehouses, and delivery territories.

## Decision

1. **Application topology:** Modular monolith using **Next.js (App Router) + TypeScript strict**. All business rules, pricing, credit validation, inventory movements, and accounting postings execute on the server inside explicit PostgreSQL transactions.
2. **Database:** **PostgreSQL** (`buah_dev` for development, `buah_test` for automated integration tests). Schema and migrations are managed with **Drizzle ORM + drizzle-kit** and committed under `drizzle/`.
3. **Authentication:** **Better Auth** (self-hosted, database-backed sessions, username/email + password).
4. **Authorization:** Server-side RBAC (`authorize(ctx, permission, { warehouseId })`) enforced in every domain service method. UI hiding is supplementary only.
5. **Audit & Immutability:** Append-only `audit_logs`, `inventory_movements`, and `journal_entries` protected by database triggers that reject `UPDATE` and `DELETE`.

## Consequences

- Zero microservice orchestration overhead for a single-business deployment.
- Every state change across documents, stock balances, and accounting journals is atomic in a single PostgreSQL transaction.
- Standard PostgreSQL portability allows deployment to any managed PostgreSQL provider.

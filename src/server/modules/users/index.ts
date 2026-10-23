import crypto from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/server/audit";
import { getAuth } from "@/server/auth";
import { authorize, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import { roles, sessions, userRoleAssignments, users } from "@/server/db/schema";
import { BusinessRuleError, ConflictError, NotFoundError, ValidationError } from "@/server/errors";

export const createUserAccountSchema = z.object({
  name: z.string().trim().min(2, "Nama pengguna minimal 2 karakter."),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._-]{3,30}$/, "Username harus 3–30 karakter huruf kecil/angka."),
  email: z.string().trim().toLowerCase().email("Email tidak valid."),
  phone: z.string().trim().optional().nullable(),
  password: z.string().min(8, "Kata sandi minimal 8 karakter."),
  roleCode: z.string().min(1, "Peran wajib dipilih."),
  warehouseId: z.string().optional().nullable(),
});

export const assignRoleSchema = z.object({
  userId: z.string().min(1),
  roleCode: z.string().min(1),
  warehouseId: z.string().optional().nullable(),
  reason: z.string().trim().min(2, "Alasan penugasan peran wajib diisi."),
});

export const setUserStatusSchema = z.object({
  userId: z.string().min(1),
  status: z.enum(["active", "suspended"]),
  reason: z.string().trim().min(3, "Alasan perubahan status akun wajib diisi."),
  expectedVersion: z.number().int().positive(),
});

export async function createUserAccount(
  db: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof createUserAccountSchema>,
) {
  authorize(ctx, "users.manage");
  const parsed = createUserAccountSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [roleRow] = await db.select().from(roles).where(eq(roles.code, data.roleCode)).limit(1);
  if (!roleRow) {
    throw new NotFoundError(`Peran '${data.roleCode}' tidak ditemukan.`);
  }

  const auth = getAuth();
  const signUpRes = await auth.api.signUpEmail({
    body: {
      name: data.name,
      email: data.email,
      password: data.password,
      username: data.username,
      phone: data.phone ?? undefined,
      status: "active",
    },
  });

  const userId = signUpRes.user.id;
  const assignmentId = `ura_${crypto.randomUUID().slice(0, 8)}`;

  await db.insert(userRoleAssignments).values({
    id: assignmentId,
    userId,
    roleId: roleRow.id,
    warehouseId: data.warehouseId || null,
    assignedBy: ctx.user.id,
  });

  await recordAudit(db, {
    ctx,
    action: "user.create",
    entityType: "user",
    entityId: userId,
    warehouseId: data.warehouseId || null,
    afterData: {
      id: userId,
      name: data.name,
      username: data.username,
      email: data.email,
      roleCode: data.roleCode,
      warehouseId: data.warehouseId || null,
    },
  });

  return {
    id: userId,
    name: data.name,
    username: data.username,
    email: data.email,
    roleCode: data.roleCode,
    warehouseId: data.warehouseId || null,
  };
}

export async function assignUserRole(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof assignRoleSchema>,
) {
  authorize(ctx, "users.manage");
  const parsed = assignRoleSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [roleRow] = await tx.select().from(roles).where(eq(roles.code, data.roleCode)).limit(1);
  if (!roleRow) {
    throw new NotFoundError(`Peran '${data.roleCode}' tidak ditemukan.`);
  }

  const id = `ura_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await tx
    .insert(userRoleAssignments)
    .values({
      id,
      userId: data.userId,
      roleId: roleRow.id,
      warehouseId: data.warehouseId || null,
      assignedBy: ctx.user.id,
    })
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "user_role.assign",
    entityType: "user_role_assignment",
    entityId: id,
    warehouseId: data.warehouseId || null,
    afterData: created,
    reason: data.reason,
  });

  return created!;
}

export async function setUserStatus(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof setUserStatusSchema>,
) {
  authorize(ctx, "users.manage");
  const parsed = setUserStatusSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  if (data.userId === ctx.user.id && data.status === "suspended") {
    throw new BusinessRuleError("Anda tidak dapat menonaktifkan akun Anda sendiri.");
  }

  const [existing] = await tx.select().from(users).where(eq(users.id, data.userId)).limit(1);
  if (!existing) {
    throw new NotFoundError("Pengguna tidak ditemukan.");
  }

  if (data.status === "suspended") {
    // Prevent suspending the last active owner
    const activeOwners = await tx.execute<{ cnt: number }>(sql`
      SELECT COUNT(DISTINCT u.id)::int AS cnt
      FROM users u
      INNER JOIN user_role_assignments ura ON ura.user_id = u.id
      INNER JOIN roles r ON r.id = ura.role_id
      WHERE r.code = 'owner' AND u.status = 'active' AND u.id <> ${data.userId}
    `);
    const targetIsOwner = await tx.execute<{ cnt: number }>(sql`
      SELECT COUNT(*)::int AS cnt
      FROM user_role_assignments ura
      INNER JOIN roles r ON r.id = ura.role_id
      WHERE ura.user_id = ${data.userId} AND r.code = 'owner'
    `);
    if (Number(targetIsOwner.rows[0]?.cnt ?? 0) > 0 && Number(activeOwners.rows[0]?.cnt ?? 0) === 0) {
      throw new BusinessRuleError(
        "Tidak dapat menonaktifkan satu-satunya Pemilik Bisnis yang aktif.",
      );
    }
  }

  const [updated] = await tx
    .update(users)
    .set({
      status: data.status,
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(users.id, data.userId), eq(users.version, data.expectedVersion)))
    .returning();

  if (!updated) {
    throw new ConflictError("Data pengguna telah diubah oleh pengguna lain.");
  }

  if (data.status === "suspended") {
    await tx.delete(sessions).where(eq(sessions.userId, data.userId));
  }

  await recordAudit(tx, {
    ctx,
    action: `user.status_${data.status}`,
    entityType: "user",
    entityId: updated.id,
    beforeData: { status: existing.status, version: existing.version },
    afterData: { status: updated.status, version: updated.version },
    reason: data.reason,
  });

  return updated;
}

export async function listUsersWithRoles(db: DbExecutor, ctx: ActorContext) {
  authorize(ctx, "users.read");
  const allUsers = await db.select().from(users).orderBy(asc(users.name));
  const allAssignments = await db
    .select({
      assignmentId: userRoleAssignments.id,
      userId: userRoleAssignments.userId,
      roleCode: roles.code,
      roleName: roles.name,
      warehouseId: userRoleAssignments.warehouseId,
    })
    .from(userRoleAssignments)
    .innerJoin(roles, eq(userRoleAssignments.roleId, roles.id));

  return allUsers.map((u) => ({
    ...u,
    roles: allAssignments.filter((a) => a.userId === u.id),
  }));
}

export async function listRoles(db: DbExecutor, ctx: ActorContext) {
  authorize(ctx, "users.read");
  return db.select().from(roles).orderBy(asc(roles.code));
}

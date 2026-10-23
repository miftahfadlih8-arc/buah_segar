import { eq } from "drizzle-orm";
import type { DbExecutor } from "@/server/db";
import { rolePermissions, roles, userRoleAssignments, users } from "@/server/db/schema";
import { ForbiddenError, UnauthenticatedError } from "@/server/errors";
import type { PermissionCode } from "./permissions";

export interface RoleGrant {
  roleCode: string;
  roleName: string;
  /** null = all warehouses; string = restricted to that warehouseId */
  warehouseId: string | null;
}

export interface ActorContext {
  user: {
    id: string;
    name: string;
    email: string;
    username: string | null;
    status: "active" | "suspended";
  };
  roles: RoleGrant[];
  /**
   * Map from PermissionCode to set of granted warehouseIds.
   * Presence of `"*"` in the set means global permission across all warehouses.
   */
  permissionScopes: Map<PermissionCode, Set<string>>;
  requestId?: string;
  ipAddress?: string;
}

export interface AuthorizeOptions {
  /** When provided, verifies the actor has the permission globally or for this specific warehouse. */
  warehouseId?: string | null;
}

export function isSuperAdmin(ctx: ActorContext | null | undefined): boolean {
  if (!ctx || !ctx.roles) return false;
  return ctx.roles.some((r) => r.roleCode === "owner" || r.roleCode === "admin");
}

/**
 * Enforce server-side RBAC and optional warehouse scope.
 * Throws UnauthenticatedError if no actor, or ForbiddenError if suspended / missing permission / cross-warehouse.
 * Role 'admin' and 'owner' have universal access without restriction.
 */
export function authorize(
  ctx: ActorContext | null | undefined,
  permission: PermissionCode,
  options?: AuthorizeOptions,
): asserts ctx is ActorContext {
  if (!ctx || !ctx.user) {
    throw new UnauthenticatedError();
  }
  if (ctx.user.status !== "active") {
    throw new ForbiddenError(permission, "Akun pengguna sedang dinonaktifkan.");
  }

  // Admin / Owner role can do EVERYTHING without restriction
  if (isSuperAdmin(ctx)) {
    return;
  }

  const scopes = ctx.permissionScopes.get(permission);
  if (!scopes || scopes.size === 0) {
    throw new ForbiddenError(permission, `Izin '${permission}' diperlukan untuk tindakan ini.`);
  }
  const targetWarehouse = options?.warehouseId;
  if (targetWarehouse) {
    if (!scopes.has("*") && !scopes.has(targetWarehouse)) {
      throw new ForbiddenError(
        permission,
        `Akses lintas gudang ditolak untuk gudang '${targetWarehouse}'.`,
      );
    }
  }
}

export function hasPermission(
  ctx: ActorContext | null | undefined,
  permission: PermissionCode,
  options?: AuthorizeOptions,
): boolean {
  if (!ctx || !ctx.user) return false;
  if (ctx.user.status !== "active") return false;
  if (isSuperAdmin(ctx)) return true;
  try {
    authorize(ctx, permission, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load an ActorContext from the database for a given `userId`.
 * Used by session resolution and integration tests.
 */
export async function loadActorContext(
  db: DbExecutor,
  userId: string,
  meta?: { requestId?: string; ipAddress?: string },
): Promise<ActorContext | null> {
  const [userRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!userRow) return null;

  const assignmentRows = await db
    .select({
      roleId: roles.id,
      roleCode: roles.code,
      roleName: roles.name,
      warehouseId: userRoleAssignments.warehouseId,
    })
    .from(userRoleAssignments)
    .innerJoin(roles, eq(userRoleAssignments.roleId, roles.id))
    .where(eq(userRoleAssignments.userId, userId));

  const permRows = await db
    .select({
      roleId: rolePermissions.roleId,
      permissionCode: rolePermissions.permissionCode,
    })
    .from(rolePermissions)
    .innerJoin(userRoleAssignments, eq(rolePermissions.roleId, userRoleAssignments.roleId))
    .where(eq(userRoleAssignments.userId, userId));

  const roleWarehouseMap = new Map<string, Set<string>>();
  for (const a of assignmentRows) {
    const set = roleWarehouseMap.get(a.roleId) ?? new Set<string>();
    set.add(a.warehouseId ?? "*");
    roleWarehouseMap.set(a.roleId, set);
  }

  const permissionScopes = new Map<PermissionCode, Set<string>>();
  for (const p of permRows) {
    const code = p.permissionCode as PermissionCode;
    const targetSet = permissionScopes.get(code) ?? new Set<string>();
    const whScopes = roleWarehouseMap.get(p.roleId);
    if (whScopes) {
      for (const wh of whScopes) targetSet.add(wh);
    }
    permissionScopes.set(code, targetSet);
  }

  return {
    user: {
      id: userRow.id,
      name: userRow.name,
      email: userRow.email,
      username: userRow.username,
      status: userRow.status,
    },
    roles: assignmentRows.map((a) => ({
      roleCode: a.roleCode,
      roleName: a.roleName,
      warehouseId: a.warehouseId,
    })),
    permissionScopes,
    requestId: meta?.requestId,
    ipAddress: meta?.ipAddress,
  };
}

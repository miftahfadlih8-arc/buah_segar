import { eq, sql } from "drizzle-orm";
import type { DbExecutor } from "@/server/db";
import { permissions, rolePermissions, roles } from "@/server/db/schema";
import { PERMISSIONS, SYSTEM_ROLES } from "./permissions";

/**
 * Idempotently seed the canonical permissions catalogue and system roles.
 */
export async function seedPermissionsAndRoles(db: DbExecutor): Promise<void> {
  for (const perm of PERMISSIONS) {
    await db
      .insert(permissions)
      .values({
        code: perm.code,
        module: perm.module,
        description: perm.description,
      })
      .onConflictDoUpdate({
        target: permissions.code,
        set: {
          module: sql`excluded.module`,
          description: sql`excluded.description`,
        },
      });
  }

  for (const roleDef of SYSTEM_ROLES) {
    const roleId = `role_${roleDef.code}`;
    await db
      .insert(roles)
      .values({
        id: roleId,
        code: roleDef.code,
        name: roleDef.name,
        description: roleDef.description,
        isSystem: true,
      })
      .onConflictDoUpdate({
        target: roles.code,
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          isSystem: true,
          updatedAt: new Date(),
        },
      });

    // Clean up revoked permissions for system roles to maintain strict role separation
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));

    for (const permCode of roleDef.permissions) {
      await db
        .insert(rolePermissions)
        .values({
          roleId,
          permissionCode: permCode,
        })
        .onConflictDoNothing();
    }
  }
}

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { getAuth } from "../src/server/auth";
import { seedPermissionsAndRoles } from "../src/server/authz/seed-roles";
import { closeDb, getDb } from "../src/server/db";
import { roles, userRoleAssignments, users } from "../src/server/db/schema";

async function main() {
  const username = process.env.OWNER_USERNAME?.trim();
  const name = process.env.OWNER_NAME?.trim() || "Pemilik Utama";
  const email = process.env.OWNER_EMAIL?.trim() || `${username}@bekasi-buah.local`;
  const password = process.env.OWNER_PASSWORD;

  if (!username || !password || password.length < 8) {
    throw new Error(
      "Harap tetapkan OWNER_USERNAME dan OWNER_PASSWORD (minimal 8 karakter) pada environment.",
    );
  }

  const db = getDb();
  await seedPermissionsAndRoles(db);

  const [existing] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (existing) {
    console.log(`Akun pemilik '${username}' sudah terdaftar (id: ${existing.id}).`);
    await closeDb();
    return;
  }

  const auth = getAuth();
  const created = await auth.api.signUpEmail({
    body: {
      name,
      email,
      password,
      username,
      status: "active",
    },
  });

  const [ownerRole] = await db.select().from(roles).where(eq(roles.code, "owner")).limit(1);
  if (!ownerRole) throw new Error("Peran 'owner' belum disemai.");

  await db.insert(userRoleAssignments).values({
    id: `ura_${crypto.randomUUID().slice(0, 8)}`,
    userId: created.user.id,
    roleId: ownerRole.id,
    warehouseId: null,
    assignedBy: created.user.id,
  });

  console.log(`Akun pemilik '${username}' berhasil dibuat.`);
  await closeDb();
}

main().catch((err) => {
  console.error("Gagal membuat akun pemilik:", err);
  process.exit(1);
});

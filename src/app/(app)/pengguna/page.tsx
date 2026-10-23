import { redirect } from "next/navigation";
import {
  createUserAccountAction,
  toggleUserStatusAction,
} from "@/app/(app)/actions";
import { ActionForm } from "@/components/action-form";
import { ConfirmActionButton, ModalDialogTrigger } from "@/components/ui/dialog-drawer";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  KpiCard,
  PageHeader,
  Select,
} from "@/components/ui/primitives";
import { TableSearchFilterBar } from "@/components/ui/table-toolbar";
import { requireSessionActor } from "@/server/auth/session";
import { hasPermission } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import { listWarehouses } from "@/server/modules/master/warehouses";
import { listRoles, listUsersWithRoles } from "@/server/modules/users";

export default async function PenggunaPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string }>;
}) {
  const actor = await requireSessionActor();
  if (!hasPermission(actor, "users.read")) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const statusFilter = (params.status ?? "").trim().toLowerCase();

  const [userList, roleList, warehouseList] = await Promise.all([
    listUsersWithRoles(db, actor),
    listRoles(db, actor),
    listWarehouses(db, actor),
  ]);

  const canManage = hasPermission(actor, "users.manage");

  const filteredUsers = userList.filter((u) => {
    const matchesQ =
      !q ||
      u.name.toLowerCase().includes(q) ||
      (u.username ?? "").toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      u.roles.some((r) => r.roleName.toLowerCase().includes(q));
    const matchesStatus = !statusFilter || u.status === statusFilter;
    return matchesQ && matchesStatus;
  });

  const activeUsersCount = userList.filter((u) => u.status === "active").length;
  const warehouseScopedCount = userList.filter((u) =>
    u.roles.some((r) => Boolean(r.warehouseId)),
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Manajemen Pengguna, Peran RBAC & Cakupan Gudang"
        description="Hak akses paling minimum (least privilege) ditegakkan di sisi server. Penugasan peran dapat dibatasi ke gudang tertentu atau global."
        actions={
          canManage ? (
            <ModalDialogTrigger
              triggerLabel="Buat Akun Pengguna"
              triggerVariant="primary"
              triggerIcon="plus"
              title="Buat Akun Pengguna & Tugaskan Peran RBAC"
              subtitle="Setiap akun staf wajib memiliki peran kerja dan cakupan gudang yang jelas."
              maxWidthClass="max-w-2xl"
            >
              <ActionForm
                action={createUserAccountAction}
                submitLabel="Buat Akun & Tugaskan Peran"
              >
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Nama Lengkap" htmlFor="usr-name" required>
                    <Input
                      id="usr-name"
                      name="name"
                      type="text"
                      required
                      placeholder="Agus Saputra"
                    />
                  </Field>
                  <Field label="Username Login" htmlFor="usr-username" required>
                    <Input
                      id="usr-username"
                      name="username"
                      type="text"
                      required
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      placeholder="agus_kurir"
                    />
                  </Field>
                  <Field label="Email Kerja" htmlFor="usr-email" required>
                    <Input
                      id="usr-email"
                      name="email"
                      type="email"
                      required
                      placeholder="agus.kurir@perusahaan.id"
                    />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Kata Sandi Awal (Min. 8)" htmlFor="usr-password" required>
                    <Input
                      id="usr-password"
                      name="password"
                      type="password"
                      minLength={8}
                      required
                      autoComplete="new-password"
                    />
                  </Field>
                  <Field label="Peran RBAC" htmlFor="usr-role" required>
                    <Select id="usr-role" name="roleCode" defaultValue="warehouse">
                      {roleList.map((r) => (
                        <option key={r.id} value={r.code}>
                          {r.name} ({r.code})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Cakupan Gudang" htmlFor="usr-wh">
                    <Select id="usr-wh" name="warehouseId" defaultValue="">
                      <option value="">Semua Gudang (Global)</option>
                      {warehouseList.map((w) => (
                        <option key={w.id} value={w.id}>
                          Hanya {w.code} — {w.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </ActionForm>
            </ModalDialogTrigger>
          ) : null
        }
      />

      {/* KPI Strip */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="TOTAL AKUN PENGGUNA"
          value={`${userList.length} Akun`}
          icon="users"
          iconTone="navy"
          badgeText={`${activeUsersCount} Aktif`}
          badgeTone="success"
          caption={`${userList.length - activeUsersCount} akun dinonaktifkan`}
        />
        <KpiCard
          label="DEFINISI PERAN (RBAC)"
          value={`${roleList.length} Peran`}
          icon="shield"
          iconTone="fresh"
          badgeText="Least Privilege"
          badgeTone="info"
          caption="Owner, Pengadaan, Gudang, QC, Sales, Finance, Kurir"
        />
        <KpiCard
          label="AKUN TERIKAT GUDANG"
          value={`${warehouseScopedCount} Staf`}
          icon="warehouse"
          iconTone="info"
          badgeText="Isolasi Cabang"
          badgeTone="neutral"
          caption="Akses dibatasi pada gudang yang ditugaskan"
        />
        <KpiCard
          label="PROTEKSI OWNER TERAKHIR"
          value="Aktif"
          icon="check"
          iconTone="fresh"
          badgeText="Anti-Lockout"
          badgeTone="success"
          caption="Server menolak penonaktifan pemilik aktif terakhir"
        />
      </div>

      {/* Users Table */}
      <Card noPadding>
        <CardHeader
          id="daftar-pengguna-heading"
          title="Daftar Akun Pengguna & Penugasan Peran"
          subtitle="Setiap perubahan status akun mencabut sesi aktif dan dicatat ke log audit"
          meta={<Badge tone="neutral">{filteredUsers.length} Akun</Badge>}
        />

        <TableSearchFilterBar
          placeholder="Cari nama, username, email, atau peran..."
          statusLabel="Semua Status Akun"
          statusOptions={[
            { value: "active", label: "Aktif" },
            { value: "suspended", label: "Dinonaktifkan (Suspended)" },
          ]}
          totalCount={userList.length}
          filteredCount={filteredUsers.length}
        />

        <div
          tabIndex={0}
          role="region"
          aria-labelledby="daftar-pengguna-heading"
          className="table-region"
        >
          <table className="w-full border-collapse text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3">Nama &amp; Username</th>
                <th className="px-4 py-3">Email Kerja</th>
                <th className="px-4 py-3">Peran RBAC &amp; Cakupan Gudang</th>
                <th className="px-4 py-3">Status</th>
                {canManage && <th className="px-5 py-3 text-right">Tindakan</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {filteredUsers.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50/80">
                  <th scope="row" className="px-5 py-3.5 font-semibold text-slate-900">
                    <div className="text-sm font-bold text-slate-900">{u.name}</div>
                    <div className="font-mono text-xs font-medium text-blue-600">
                      @{u.username ?? "-"} • v{u.version}
                    </div>
                  </th>
                  <td className="px-4 py-3.5 font-mono text-slate-600">{u.email}</td>
                  <td className="px-4 py-3.5">
                    <div className="flex flex-wrap gap-1.5">
                      {u.roles.map((r) => (
                        <Badge key={r.assignmentId} tone="info">
                          {r.roleName} ({r.warehouseId ?? "Semua Gudang"})
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3.5">
                    <Badge tone={u.status === "active" ? "success" : "danger"} dot>
                      {u.status === "active" ? "Aktif" : "Dinonaktifkan"}
                    </Badge>
                  </td>
                  {canManage && (
                    <td className="px-5 py-3.5 text-right">
                      {u.id !== actor.user.id ? (
                        <ConfirmActionButton
                          action={toggleUserStatusAction}
                          hiddenFields={{
                            userId: u.id,
                            expectedVersion: u.version,
                            status: u.status === "active" ? "suspended" : "active",
                          }}
                          buttonLabel={
                            u.status === "active" ? "Nonaktifkan Akun" : "Aktifkan Kembali"
                          }
                          buttonVariant={u.status === "active" ? "danger" : "secondary"}
                          confirmTitle={
                            u.status === "active"
                              ? `Nonaktifkan Akun ${u.name}?`
                              : `Aktifkan Kembali Akun ${u.name}?`
                          }
                          confirmDescription={
                            u.status === "active"
                              ? "Akun yang dinonaktifkan akan langsung kehilangan seluruh sesi login aktif."
                              : "Pengguna akan dapat masuk kembali sesuai peran yang ditugaskan."
                          }
                          confirmButtonLabel={
                            u.status === "active" ? "Ya, Nonaktifkan" : "Ya, Aktifkan"
                          }
                          reasonFieldName="reason"
                          reasonDefaultValue="Evaluasi akses pengguna oleh Administrator"
                          requireReason
                        />
                      ) : (
                        <span className="text-[11px] font-medium text-slate-400">Akun Anda</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={canManage ? 5 : 4}>
                    <EmptyState
                      icon="users"
                      title="Akun Pengguna Tidak Ditemukan"
                      description="Tidak ada pengguna yang cocok dengan filter pencarian."
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

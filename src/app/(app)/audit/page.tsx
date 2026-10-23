import { redirect } from "next/navigation";
import { updateSystemSettingAction } from "@/app/(app)/actions";
import { ActionForm } from "@/components/action-form";
import { ModalDialogTrigger } from "@/components/ui/dialog-drawer";
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
import { formatDateTime } from "@/lib/datetime";
import { listAuditLogs } from "@/server/audit";
import { requireSessionActor } from "@/server/auth/session";
import { hasPermission } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import { listSettingsHistory } from "@/server/settings";

export default async function AuditPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string }>;
}) {
  const actor = await requireSessionActor();
  if (!hasPermission(actor, "audit.read") && !hasPermission(actor, "settings.read")) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const entityFilter = (params.status ?? "").trim().toLowerCase();

  const canReadAudit = hasPermission(actor, "audit.read");
  const canReadSettings = hasPermission(actor, "settings.read");
  const canManageSettings = hasPermission(actor, "settings.manage");

  const [logs, settingsHistory] = await Promise.all([
    canReadAudit ? listAuditLogs(db, actor, { limit: 100 }) : Promise.resolve([]),
    canReadSettings ? listSettingsHistory(db, actor) : Promise.resolve([]),
  ]);

  const filteredLogs = logs.filter((log) => {
    const matchesQ =
      !q ||
      log.action.toLowerCase().includes(q) ||
      log.entityType.toLowerCase().includes(q) ||
      log.entityId.toLowerCase().includes(q) ||
      (log.actorName ?? "").toLowerCase().includes(q) ||
      (log.reason ?? "").toLowerCase().includes(q);
    const matchesEntity = !entityFilter || log.entityType.toLowerCase() === entityFilter;
    return matchesQ && matchesEntity;
  });

  const uniqueEntities = Array.from(new Set(logs.map((l) => l.entityType)));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Jejak Audit (Append-Only) & Pengaturan Sistem Berversi"
        description="Seluruh entri audit dan riwayat pengaturan sistem dilindungi trigger PostgreSQL prevent_immutable_row_mutation() sehingga tidak dapat diubah atau dihapus."
        actions={
          canManageSettings ? (
            <ModalDialogTrigger
              triggerLabel="Tambah Versi Pengaturan"
              triggerVariant="primary"
              triggerIcon="plus"
              title="Tambah Versi Pengaturan Sistem (Append-Only)"
              subtitle="Menyimpan baris pengaturan baru tanpa menimpa riwayat pengaturan sebelumnya."
            >
              <ActionForm
                action={updateSystemSettingAction}
                submitLabel="Simpan Versi Pengaturan"
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Kunci Pengaturan" htmlFor="set-key" required>
                    <Select id="set-key" name="key" defaultValue="sales.enable_direct_consumer">
                      <option value="sales.enable_direct_consumer">
                        sales.enable_direct_consumer (Kanal Konsumen Langsung B2C)
                      </option>
                      <option value="inventory.costing_policy">
                        inventory.costing_policy (Kebijakan Penilaian Persediaan)
                      </option>
                      <option value="inventory.allow_negative_stock">
                        inventory.allow_negative_stock (Izin Stok Negatif dengan Approval)
                      </option>
                    </Select>
                  </Field>
                  <Field label="Alasan Perubahan" htmlFor="set-reason" required>
                    <Input
                      id="set-reason"
                      name="reason"
                      type="text"
                      required
                      placeholder="Keputusan operasional pemilik"
                    />
                  </Field>
                </div>
                <Field label="Nilai JSON" htmlFor="set-json" required>
                  <Input
                    id="set-json"
                    name="valueJson"
                    type="text"
                    required
                    defaultValue='{"enabled": false}'
                    className="font-mono text-xs"
                  />
                </Field>
              </ActionForm>
            </ModalDialogTrigger>
          ) : null
        }
      />

      {/* KPI Summary */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="ENTRI AUDIT TERMUAT"
          value={`${logs.length} Entri`}
          icon="audit"
          iconTone="navy"
          badgeText="Immutable"
          badgeTone="navy"
          caption="Dilindungi trigger anti-UPDATE & anti-DELETE"
        />
        <KpiCard
          label="JENIS ENTITAS TERPANTAU"
          value={`${uniqueEntities.length} Entitas`}
          icon="shield"
          iconTone="fresh"
          badgeText="100% Tercatat"
          badgeTone="success"
          caption="Master, PO, GRN, Batch, SO, Kredit, Jurnal"
        />
        <KpiCard
          label="VERSI PENGATURAN SISTEM"
          value={`${settingsHistory.length} Versi`}
          icon="spark"
          iconTone="info"
          badgeText="Append-Only"
          badgeTone="info"
          caption="Riwayat perubahan konfigurasi sistem"
        />
        <KpiCard
          label="ZONA WAKTU LOG"
          value="WIB (UTC+7)"
          icon="clock"
          iconTone="warning"
          badgeText="TIMESTAMPTZ"
          badgeTone="neutral"
          caption="Asia/Jakarta untuk ketertelusuran hukum"
        />
      </div>

      {/* Audit Logs Table */}
      {canReadAudit && (
        <Card noPadding>
          <CardHeader
            id="audit-log-heading"
            title="Riwayat Jejak Audit Operasional & Keuangan"
            subtitle="Menampilkan hingga 100 entri audit terbaru beserta snapshot data sebelum & sesudah"
            meta={<Badge tone="neutral">{filteredLogs.length} Entri</Badge>}
          />

          <TableSearchFilterBar
            placeholder="Cari aksi, entitas, ID dokumen, pelaku, atau alasan..."
            statusLabel="Semua Jenis Entitas"
            statusOptions={uniqueEntities.map((e) => ({ value: e, label: e }))}
            totalCount={logs.length}
            filteredCount={filteredLogs.length}
          />

          <div
            tabIndex={0}
            role="region"
            aria-labelledby="audit-log-heading"
            className="table-region"
          >
            <table className="w-full border-collapse text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
                <tr>
                  <th className="px-5 py-3">ID &amp; Waktu (WIB)</th>
                  <th className="px-4 py-3">Pelaku (Actor)</th>
                  <th className="px-4 py-3">Tindakan &amp; Entitas</th>
                  <th className="px-5 py-3">Alasan &amp; Ringkasan Data</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {filteredLogs.map((log) => (
                  <tr key={log.id} className="align-top hover:bg-slate-50/80">
                    <th scope="row" className="tabular-nums px-5 py-3.5 whitespace-nowrap">
                      <span className="font-mono font-bold text-slate-900">#{log.id}</span>
                      <div className="mt-0.5 text-[11px] font-normal text-slate-500">
                        {formatDateTime(log.occurredAt)}
                      </div>
                    </th>
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-900">
                        {log.actorName ?? "SYSTEM"}
                      </div>
                      <div className="font-mono text-[11px] text-slate-500">
                        {log.actorUserId ?? "system"}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <Badge tone="info">{log.action}</Badge>
                      <div className="mt-1 text-[11px] text-slate-600">
                        {log.entityType}:{" "}
                        <span className="font-mono font-semibold text-slate-800">
                          {log.entityId}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-slate-700">
                      {log.reason && (
                        <div className="mb-1 font-semibold text-slate-900">
                          Alasan: {log.reason}
                        </div>
                      )}
                      <pre className="max-w-xl overflow-x-auto rounded-lg border border-slate-200/80 bg-slate-50 p-2 font-mono text-[11px] text-slate-600">
                        {JSON.stringify(log.afterData ?? log.beforeData)}
                      </pre>
                    </td>
                  </tr>
                ))}
                {filteredLogs.length === 0 && (
                  <tr>
                    <td colSpan={4}>
                      <EmptyState
                        icon="audit"
                        title="Entri Audit Tidak Ditemukan"
                        description="Tidak ada entri audit yang sesuai dengan filter pencarian Anda."
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

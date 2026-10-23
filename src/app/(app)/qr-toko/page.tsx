import { redirect } from "next/navigation";
import { getSessionActor } from "@/server/auth/session";
import { hasPermission, isSuperAdmin } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import { customers } from "@/server/db/schema";
import { getMerchantQrisConfig, getBaseUrl, generateStoreQrCode } from "@/server/modules/customer-orders";
import { QrTokoClient } from "./qr-toko-client";

export const metadata = {
  title: "QR Generator Toko & QRIS — Suplayer Buah Bekasi",
  description: "Kelola lembar QR order resmi per toko dan pengaturan merchant QRIS terpusat.",
};

export default async function QrTokoPage() {
  const actor = await getSessionActor();
  if (!actor) {
    throw new Error("Sesi tidak sah.");
  }

  if (!hasPermission(actor, "sales.write") && !isSuperAdmin(actor)) {
    redirect("/");
  }

  const db = getDb();
  const [storeList, qrisConfig] = await Promise.all([
    db
      .select({
        id: customers.id,
        code: customers.code,
        name: customers.name,
        segment: customers.segment,
        isActive: customers.isActive,
        phone: customers.phone,
        shippingAddress: customers.shippingAddress,
      })
      .from(customers)
      .orderBy(customers.name),
    getMerchantQrisConfig(db),
  ]);

  const baseUrl = getBaseUrl();
  let initialQrResult = null;
  if (storeList.length > 0 && storeList[0]) {
    try {
      initialQrResult = await generateStoreQrCode(db, storeList[0].code, { baseUrl });
    } catch {
      // Ignore initial QR error if none
    }
  }

  return (
    <div className="p-6">
      <QrTokoClient
        stores={storeList}
        initialQrisConfig={qrisConfig}
        baseUrl={baseUrl}
        initialQrResult={initialQrResult}
      />
    </div>
  );
}

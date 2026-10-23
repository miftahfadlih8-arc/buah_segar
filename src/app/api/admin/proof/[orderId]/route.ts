import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getSessionActor } from "@/server/auth/session";
import { hasPermission } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import { customerOrderRequests } from "@/server/db/schema";
import { readPrivateProofFile } from "@/server/modules/customer-orders";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const actor = await getSessionActor();
    if (!actor) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const isAuthorized =
      hasPermission(actor, "sales.read") ||
      hasPermission(actor, "ar.read") ||
      hasPermission(actor, "ar.collect") ||
      actor.roles.some((r) => r.roleCode === "owner");

    if (!isAuthorized) {
      return new NextResponse("Forbidden: Anda tidak memiliki akses ke bukti pembayaran", {
        status: 403,
      });
    }

    const { orderId } = await params;
    if (!orderId) {
      return new NextResponse("Bad Request", { status: 400 });
    }

    const db = getDb();
    const [order] = await db
      .select({ proofRef: customerOrderRequests.paymentProofRef })
      .from(customerOrderRequests)
      .where(eq(customerOrderRequests.id, orderId))
      .limit(1);

    if (!order || !order.proofRef) {
      return new NextResponse("Bukti pembayaran tidak ditemukan", { status: 404 });
    }

    const fileData = await readPrivateProofFile(order.proofRef);
    if (!fileData) {
      return new NextResponse("File fisik bukti pembayaran tidak ditemukan", {
        status: 404,
      });
    }

    return new NextResponse(fileData.buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": fileData.mime,
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
        "Content-Disposition": `inline; filename="bukti-pembayaran-${orderId}"`,
      },
    });
  } catch {
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import {
  customerOrderRequests,
  customerOrderSessions,
} from "@/server/db/schema";
import { readPrivateProofFile } from "@/server/modules/customer-orders";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;
    if (!token) {
      return new NextResponse("Token tidak valid", { status: 400 });
    }

    const db = getDb();

    // Check if token matches session or order request status token
    let proofRef: string | null = null;

    const [session] = await db
      .select({ proofRef: customerOrderSessions.paymentProofRef })
      .from(customerOrderSessions)
      .where(eq(customerOrderSessions.sessionToken, token))
      .limit(1);

    if (session?.proofRef) {
      proofRef = session.proofRef;
    } else {
      const [orderReq] = await db
        .select({ proofRef: customerOrderRequests.paymentProofRef })
        .from(customerOrderRequests)
        .where(eq(customerOrderRequests.statusToken, token))
        .limit(1);

      if (orderReq?.proofRef) {
        proofRef = orderReq.proofRef;
      }
    }

    if (!proofRef) {
      return new NextResponse("Bukti pembayaran tidak ditemukan atau akses ditolak", {
        status: 404,
      });
    }

    const fileData = await readPrivateProofFile(proofRef);
    if (!fileData) {
      return new NextResponse("File bukti pembayaran fisik tidak ditemukan", {
        status: 404,
      });
    }

    return new NextResponse(fileData.buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": fileData.mime,
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
        "Content-Disposition": `inline; filename="bukti-pembayaran"`,
      },
    });
  } catch {
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}

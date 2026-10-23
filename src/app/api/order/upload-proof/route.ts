import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/server/db";
import { savePaymentProofFile } from "@/server/modules/customer-orders";
import { ValidationError, BusinessRuleError } from "@/server/errors";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const sessionToken = formData.get("sessionToken");
    const file = formData.get("file");

    if (!sessionToken || typeof sessionToken !== "string") {
      return NextResponse.json(
        { success: false, error: "Token sesi tidak ditemukan." },
        { status: 400 },
      );
    }

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json(
        { success: false, error: "File bukti pembayaran wajib dipilih." },
        { status: 400 },
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const fileName = (file as File).name || "bukti_pembayaran.jpg";
    const mimeType = file.type || "image/jpeg";

    const db = getDb();
    const result = await savePaymentProofFile(db, {
      sessionToken: sessionToken.trim(),
      fileBuffer: buffer,
      fileName,
      mimeType,
    });

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      return NextResponse.json(
        { success: false, error: Object.values(err.fieldErrors).flat().join(" ") },
        { status: 422 },
      );
    }
    if (err instanceof BusinessRuleError) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Gagal mengunggah file.";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}

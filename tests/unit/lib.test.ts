import { describe, expect, it } from "vitest";
import { businessDate, formatDate, formatDateTime, periodKey } from "@/lib/datetime";
import {
  formatRupiah,
  lineTotal,
  parseMoney,
  roundRupiah,
  roundUnitPrice,
  toDbAmount,
  toDbUnitPrice,
} from "@/lib/money";
import {
  ConversionNotAllowedError,
  formatQty,
  netWeight,
  parseQty,
  toBaseQty,
  toDbQty,
} from "@/lib/quantity";

describe("money helpers (IDR)", () => {
  it("parses Indonesian formatted currency strings and machine numbers", () => {
    expect(parseMoney("Rp 1.250.000").toString()).toBe("1250000");
    expect(parseMoney("1.250").toString()).toBe("1250");
    expect(parseMoney("18.500,75").toString()).toBe("18500.75");
    expect(parseMoney(25000).toString()).toBe("25000");
  });

  it("rejects malformed money values", () => {
    expect(() => parseMoney("abc")).toThrow(/Nilai uang tidak valid/);
    expect(() => parseMoney(Number.NaN)).toThrow(/Nilai uang tidak valid/);
  });

  it("rounds unit prices to 4 decimals and document amounts to whole Rupiah (half-up)", () => {
    expect(toDbUnitPrice(roundUnitPrice(parseMoney("18333.33335")))).toBe("18333.3334");
    expect(toDbAmount(roundRupiah(parseMoney("18500.5")))).toBe("18501.00");
    expect(toDbAmount(roundRupiah(parseMoney("18500.49")))).toBe("18500.00");
  });

  it("computes lineTotal from qty * unitPrice - discount with whole Rupiah rounding", () => {
    const qty = parseQty("12,350");
    const price = parseMoney("24500");
    const discount = parseMoney("2.575");
    // 12.35 * 24500 = 302575; - 2575 = 300000
    expect(lineTotal(qty, price, discount).toString()).toBe("300000");
    expect(formatRupiah("300000")).toContain("300.000");
  });
});

describe("quantity and UoM conversion helpers", () => {
  it("computes netWeight = gross - tare and rejects tare > gross", () => {
    expect(toDbQty(netWeight(parseQty("21,450"), parseQty("1,650")))).toBe("19.800");
    expect(() => netWeight(parseQty("1,000"), parseQty("1,200"))).toThrow(/Berat tara melebihi berat bruto/);
  });

  it("allows nominal / catch-weight conversion for estimates but blocks it for billing", () => {
    const petiJeruk = {
      factorToBase: "20",
      isNominal: true,
      requiresActualWeight: true,
    };
    expect(toDbQty(toBaseQty(parseQty("3"), petiJeruk, "estimate"))).toBe("60.000");
    expect(() => toBaseQty(parseQty("3"), petiJeruk, "billing")).toThrow(ConversionNotAllowedError);
  });

  it("allows exact fixed conversions for billing when not nominal and not catch-weight", () => {
    const gramToKg = {
      factorToBase: "0.001",
      isNominal: false,
      requiresActualWeight: false,
    };
    expect(toDbQty(toBaseQty(parseQty("500"), gramToKg, "billing"))).toBe("0.500");
    expect(formatQty("19.8", "kg")).toBe("19,8 kg");
  });
});

describe("Asia/Jakarta business date helpers", () => {
  it("converts UTC timestamps near midnight to Jakarta (UTC+7) business date", () => {
    // 2026-10-20 18:30 UTC is 2026-10-21 01:30 WIB
    const instant = new Date("2026-10-20T18:30:00.000Z");
    expect(businessDate(instant)).toBe("2026-10-21");
    expect(periodKey(instant)).toBe("2610");
    expect(formatDate(instant)).toBe("21/10/2026");
    expect(formatDateTime(instant)).toContain("21/10/2026");
    expect(formatDateTime(instant)).toContain("WIB");
  });
});

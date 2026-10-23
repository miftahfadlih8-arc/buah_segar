import { describe, expect, it } from "vitest";
import { MoneyDecimal } from "@/lib/money";
import {
  calculateGradingAndYield,
  calculateOutflowCost,
  calculateWeighing,
} from "@/server/modules/inventory/costing";

describe("Phase 3 Costing, Weighing & Yield Policy — Unit Tests", () => {
  it("calculates gross, packaging rule tare, actual tare, and net weight accurately", () => {
    const ruleRes = calculateWeighing({
      grossWeightKg: "106.000",
      tareSource: "packaging_rule",
      packageCount: 5,
      defaultTarePerPackageKg: "1.200",
    });
    expect(ruleRes).toEqual({
      grossWeightKg: "106.000",
      tareWeightKg: "6.000",
      netWeightKg: "100.000",
      packageCount: 5,
    });

    const actualRes = calculateWeighing({
      grossWeightKg: "105.450",
      tareSource: "measured_actual",
      packageCount: 5,
      measuredTareWeightKg: "5.450",
    });
    expect(actualRes.netWeightKg).toBe("100.000");

    expect(() =>
      calculateWeighing({
        grossWeightKg: "10.000",
        tareSource: "measured_actual",
        measuredTareWeightKg: "10.000",
      }),
    ).toThrow(/tara/i);
  });

  it("enforces yield conservation formula and allocates lot cost via Relative Sales Value (RSV)", () => {
    const res = calculateGradingAndYield({
      netWeightKg: "95.000",
      acceptedGrades: [
        { gradeId: "g_a", gradeCode: "A", qtyBase: "50.000", relativeValueMultiplierPct: "120.00" },
        { gradeId: "g_b", gradeCode: "B", qtyBase: "30.000", relativeValueMultiplierPct: "100.00" },
        { gradeId: "g_c", gradeCode: "C", qtyBase: "10.000", relativeValueMultiplierPct: "70.00" },
      ],
      trimLossQtyBase: "2.000",
      rejects: [
        { qtyBase: "3.000", disposition: "return_to_supplier", reasonCode: "BUSUK_PERJALANAN" },
      ],
      actualUnitCostBase: "15000.0000",
      allocatedLandedCost: "75000.00",
    });

    expect(res.acceptedQtyBase).toBe("90.000");
    expect(res.trimLossQtyBase).toBe("2.000");
    expect(res.rejectedQtyBase).toBe("3.000");
    expect(res.accountedWeightKg).toBe("95.000");
    expect(res.unaccountedVarianceKg).toBe("0.000");
    expect(res.yieldPct).toBe("94.74");
    expect(res.billableQtyBase).toBe("92.000");
    expect(res.lineGoodsCost).toBe("1380000.00");
    expect(res.totalLineCost).toBe("1455000.00");

    const byGrade = Object.fromEntries(res.gradeAllocations.map((g) => [g.gradeCode, g]));
    expect(byGrade.A?.allocatedCostTotal).toBe("900000.00");
    expect(byGrade.A?.allocatedUnitCost).toBe("18000.0000");
    expect(byGrade.B?.allocatedCostTotal).toBe("450000.00");
    expect(byGrade.B?.allocatedUnitCost).toBe("15000.0000");
    expect(byGrade.C?.allocatedCostTotal).toBe("105000.00");
    expect(byGrade.C?.allocatedUnitCost).toBe("10500.0000");
  });

  it("reconciles rounding residuals on the largest-weight grade so sum of grade costs equals totalLineCost", () => {
    const res = calculateGradingAndYield({
      netWeightKg: "30.000",
      acceptedGrades: [
        { gradeId: "g_a", gradeCode: "A", qtyBase: "10.000", relativeValueMultiplierPct: "100.00" },
        { gradeId: "g_b", gradeCode: "B", qtyBase: "10.000", relativeValueMultiplierPct: "100.00" },
        { gradeId: "g_c", gradeCode: "C", qtyBase: "10.000", relativeValueMultiplierPct: "100.00" },
      ],
      actualUnitCostBase: "3333.3333",
      allocatedLandedCost: "1.00",
    });

    const sumGrades = res.gradeAllocations.reduce(
      (acc, g) => acc.plus(new MoneyDecimal(g.allocatedCostTotal)),
      new MoneyDecimal(0),
    );
    expect(sumGrades.toFixed(2)).toBe(res.totalLineCost);

    // Rejects when grading sum differs from netWeightKg beyond tolerance
    expect(() =>
      calculateGradingAndYield({
        netWeightKg: "100.000",
        acceptedGrades: [
          { gradeId: "g_a", gradeCode: "A", qtyBase: "80.000", relativeValueMultiplierPct: "120" },
        ],
        trimLossQtyBase: "5.000",
        actualUnitCostBase: "10000",
      }),
    ).toThrow(/melebihi batas toleransi/i);
  });

  it("depletes exact remaining totalCost when issuing 100% of a batch balance", () => {
    const partial = calculateOutflowCost({
      currentQtyBase: "30.000",
      currentTotalCost: "100000.00",
      unitCostBase: "3333.3333",
      outflowQtyBase: "10.000",
    });
    expect(partial.costOutflow).toBe("33333.00");
    expect(partial.remainingQtyBase).toBe("20.000");
    expect(partial.remainingTotalCost).toBe("66667.00");

    const fullDeplete = calculateOutflowCost({
      currentQtyBase: partial.remainingQtyBase,
      currentTotalCost: partial.remainingTotalCost,
      unitCostBase: "3333.3333",
      outflowQtyBase: "20.000",
    });
    expect(fullDeplete.costOutflow).toBe("66667.00");
    expect(fullDeplete.remainingQtyBase).toBe("0.000");
    expect(fullDeplete.remainingTotalCost).toBe("0.00");
  });
});

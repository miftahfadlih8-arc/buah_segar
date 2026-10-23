import {
  MoneyDecimal,
  parseMoney,
  roundRupiah,
  roundUnitPrice,
  toDbAmount,
  toDbUnitPrice,
  type Money,
} from "@/lib/money";
import { parseQty, roundQty, toDbQty } from "@/lib/quantity";
import type { DbExecutor } from "@/server/db";
import { BusinessRuleError } from "@/server/errors";
import { getSetting } from "@/server/settings";

/**
 * ============================================================================
 * DOCUMENTED COSTING & YIELD POLICY ENGINE (PHASE 3)
 * ============================================================================
 *
 * 1. WEIGHING (Bruto -> Tara -> Neto):
 *    - `tareSource = "packaging_rule"`: `tareKg = roundQty(packageCount * defaultTareKg)`
 *    - `tareSource = "measured_actual"`: `tareKg = roundQty(measuredTareKg)`
 *    - `netKg = roundQty(grossKg - tareKg)` (must be > 0; grossKg > 0; tareKg >= 0)
 *
 * 2. GRADING & YIELD CONSERVATION:
 *    - Every received line is sorted into:
 *      * Accepted Grades (e.g., Grade A, B, C) -> `acceptedQtyBase = Σ grade.qtyBase`
 *      * Pre-available Sorting / Trim Loss -> `trimLossQtyBase`
 *      * Rejected Goods -> `rejectedQtyBase` (`return_to_supplier` or `dispose_on_site`)
 *    - Conservation formula:
 *      `accountedWeightKg = acceptedQtyBase + trimLossQtyBase + rejectedQtyBase`
 *      `|netWeightKg - accountedWeightKg| <= scaleToleranceKg` (default 0.050 kg / 50 g)
 *    - Yield % = `(acceptedQtyBase / netWeightKg) * 100`
 *
 * 3. LOT COST POOL & RELATIVE-SALES-VALUE (RSV) GRADE ALLOCATION:
 *    - Billable supplier quantity (`billableQtyBase`):
 *      `netWeightKg - rejectedReturnToSupplierQtyBase`
 *      (Goods rejected & returned to supplier at receiving are not billed by the supplier;
 *       on-site disposal rejects and sorting trim loss before stock becomes available are
 *       absorbed into the lot cost of accepted grades.)
 *    - `lineGoodsCost = roundRupiah(billableQtyBase * actualUnitCostBase)`
 *    - `totalLotCost = roundRupiah(lineGoodsCost + allocatedLandedCost)`
 *    - Across accepted grades g = 1..k with quantity `q_g > 0` and relative value multiplier `m_g > 0`:
 *      * `weight_g = q_g * m_g`
 *      * `totalWeight = Σ weight_g`
 *      * `allocatedCost_g = roundRupiah(totalLotCost * weight_g / totalWeight)`
 *      * Rounding residual `Δ = totalLotCost - Σ allocatedCost_g` is applied to the grade with the
 *        highest `weight_g`, guaranteeing `Σ allocatedCost_g === totalLotCost`.
 *      * `allocatedUnitCost_g = roundUnitPrice(allocatedCost_g / q_g)` (4 decimal places).
 *
 * 4. POST-RECEIVING SPOILAGE & ADJUSTMENTS:
 *    - Once stock is posted as `available`, subsequent spoilage, shrinkage, or damage is NOT
 *      re-absorbed into remaining good inventory; it is written off at the batch's `unitCostBase`
 *      to Expense (`5210 Beban Susut, Busuk & Rusak Buah`).
 *    - Physical stock count / manual adjustment variances are posted to `5220 Selisih Penyesuaian & Opname Stok`.
 *
 * 5. PRODUCTION COSTING POLICY GATE:
 *    - Controlled by setting `"costing.policy_approval"`.
 *    - Until both `approvedByOwner` and `approvedByAccountant` are true:
 *      * Production valuation posting (`NODE_ENV === "production"` or `enforceProductionGate: true`)
 *        is BLOCKED (`BusinessRuleError`).
 *      * Development/Test runs mark journal entries with `costingPolicyStatus = "synthetic_dev_blocked_prod"`.
 */

export const COSTING_POLICY_SETTING_KEY = "costing.policy_approval";
export const DEFAULT_SCALE_TOLERANCE_KG = "0.050";

export interface CostingPolicyApprovalValue {
  approvedByOwner: boolean;
  approvedByAccountant: boolean;
  ownerUserId?: string;
  accountantUserId?: string;
  approvedAt?: string;
  policyVersion: string;
}

export interface CostingPolicyGateResult {
  status: "approved" | "synthetic_dev_blocked_prod";
  approvedByOwner: boolean;
  approvedByAccountant: boolean;
  productionValuationBlocked: boolean;
}

export async function evaluateCostingPolicyGate(
  db: DbExecutor,
  options?: { enforceProductionGate?: boolean },
): Promise<CostingPolicyGateResult> {
  const row = await getSetting<CostingPolicyApprovalValue>(db, COSTING_POLICY_SETTING_KEY);
  const approvedByOwner = Boolean(row?.value?.approvedByOwner);
  const approvedByAccountant = Boolean(row?.value?.approvedByAccountant);
  const isApproved = approvedByOwner && approvedByAccountant;

  const mustEnforceProd =
    options?.enforceProductionGate === true || process.env.NODE_ENV === "production";

  if (!isApproved && mustEnforceProd) {
    throw new BusinessRuleError(
      "BLOCKED: Kebijakan perhitungan HPP & valuasi persediaan belum disetujui secara resmi oleh Pemilik Bisnis dan Akuntan. Posting valuasi ke Buku Besar (GL) pada lingkungan produksi diblokir.",
    );
  }

  return {
    status: isApproved ? "approved" : "synthetic_dev_blocked_prod",
    approvedByOwner,
    approvedByAccountant,
    productionValuationBlocked: !isApproved,
  };
}

export interface CalculateWeighingInput {
  grossWeightKg: string | number;
  tareSource: "packaging_rule" | "measured_actual";
  packageCount?: number;
  defaultTarePerPackageKg?: string | number;
  measuredTareWeightKg?: string | number;
}

export interface CalculateWeighingResult {
  grossWeightKg: string;
  tareWeightKg: string;
  netWeightKg: string;
  packageCount: number;
}

export function calculateWeighing(input: CalculateWeighingInput): CalculateWeighingResult {
  const gross = roundQty(parseQty(input.grossWeightKg));
  if (gross.lte(0)) {
    throw new BusinessRuleError("Berat bruto harus lebih besar dari 0 kg.");
  }

  const pkgCount = input.packageCount ?? 0;
  if (!Number.isInteger(pkgCount) || pkgCount < 0) {
    throw new BusinessRuleError("Jumlah kemasan (peti/keranjang/box) tidak boleh negatif.");
  }

  let tare: Money;
  if (input.tareSource === "packaging_rule") {
    const tarePerPkg = parseQty(input.defaultTarePerPackageKg ?? "0");
    if (tarePerPkg.lt(0)) {
      throw new BusinessRuleError("Tara standar per kemasan tidak boleh negatif.");
    }
    tare = roundQty(tarePerPkg.mul(pkgCount));
  } else {
    if (input.measuredTareWeightKg === undefined) {
      throw new BusinessRuleError("Berat tara aktual wajib diisi untuk metode timbang tara aktual.");
    }
    tare = roundQty(parseQty(input.measuredTareWeightKg));
  }

  if (tare.lt(0)) {
    throw new BusinessRuleError("Berat tara tidak boleh negatif.");
  }
  if (tare.gte(gross)) {
    throw new BusinessRuleError(
      `Berat tara (${toDbQty(tare)} kg) tidak boleh melebihi atau sama dengan berat bruto (${toDbQty(gross)} kg).`,
    );
  }

  const net = roundQty(gross.minus(tare));
  return {
    grossWeightKg: toDbQty(gross),
    tareWeightKg: toDbQty(tare),
    netWeightKg: toDbQty(net),
    packageCount: pkgCount,
  };
}

export interface GradeSplitInput {
  gradeId: string;
  gradeCode: string;
  qtyBase: string | number;
  packageCount?: number;
  relativeValueMultiplierPct: string | number;
}

export interface RejectSplitInput {
  qtyBase: string | number;
  disposition: "return_to_supplier" | "dispose_on_site";
  reasonCode: string;
}

export interface CalculateGradingAndYieldInput {
  netWeightKg: string | number;
  acceptedGrades: GradeSplitInput[];
  trimLossQtyBase?: string | number;
  rejects?: RejectSplitInput[];
  actualUnitCostBase: string | number;
  allocatedLandedCost?: string | number;
  scaleToleranceKg?: string | number;
}

export interface AllocatedGradeCostResult {
  gradeId: string;
  gradeCode: string;
  qtyBase: string;
  packageCount: number;
  relativeValueMultiplierPct: string;
  allocatedCostTotal: string;
  allocatedUnitCost: string;
}

export interface CalculateGradingAndYieldResult {
  netWeightKg: string;
  acceptedQtyBase: string;
  trimLossQtyBase: string;
  rejectedQtyBase: string;
  rejectedReturnToSupplierQtyBase: string;
  rejectedDisposeOnSiteQtyBase: string;
  accountedWeightKg: string;
  unaccountedVarianceKg: string;
  yieldPct: string;
  trimLossPct: string;
  rejectPct: string;
  billableQtyBase: string;
  lineGoodsCost: string;
  allocatedLandedCost: string;
  totalLineCost: string;
  gradeAllocations: AllocatedGradeCostResult[];
}

export function calculateGradingAndYield(
  input: CalculateGradingAndYieldInput,
): CalculateGradingAndYieldResult {
  const net = roundQty(parseQty(input.netWeightKg));
  if (net.lte(0)) {
    throw new BusinessRuleError("Berat neto penerimaan harus lebih besar dari 0.");
  }

  const tolerance = roundQty(parseQty(input.scaleToleranceKg ?? DEFAULT_SCALE_TOLERANCE_KG));
  if (tolerance.lt(0)) {
    throw new BusinessRuleError("Toleransi timbangan tidak boleh negatif.");
  }

  const trimLoss = roundQty(parseQty(input.trimLossQtyBase ?? "0"));
  if (trimLoss.lt(0)) {
    throw new BusinessRuleError("Kuantitas susut sortir (trim loss) tidak boleh negatif.");
  }

  let acceptedTotal = new MoneyDecimal(0);
  const parsedGrades = input.acceptedGrades.map((g) => {
    const q = roundQty(parseQty(g.qtyBase));
    if (q.lt(0)) {
      throw new BusinessRuleError(`Kuantitas grade ${g.gradeCode} tidak boleh negatif.`);
    }
    const mult = new MoneyDecimal(g.relativeValueMultiplierPct.toString());
    if (mult.lte(0)) {
      throw new BusinessRuleError(
        `Multiplier nilai relatif untuk grade ${g.gradeCode} harus lebih besar dari 0.`,
      );
    }
    acceptedTotal = acceptedTotal.plus(q);
    return {
      gradeId: g.gradeId,
      gradeCode: g.gradeCode,
      qty: q,
      packageCount: g.packageCount ?? 0,
      multiplier: mult,
    };
  });

  let rejectReturnTotal = new MoneyDecimal(0);
  let rejectDisposeTotal = new MoneyDecimal(0);
  for (const r of input.rejects ?? []) {
    const rq = roundQty(parseQty(r.qtyBase));
    if (rq.lt(0)) {
      throw new BusinessRuleError("Kuantitas barang ditolak (reject) tidak boleh negatif.");
    }
    if (rq.gt(0) && !r.reasonCode?.trim()) {
      throw new BusinessRuleError("Alasan penolakan (reject reason code) wajib diisi.");
    }
    if (r.disposition === "return_to_supplier") {
      rejectReturnTotal = rejectReturnTotal.plus(rq);
    } else {
      rejectDisposeTotal = rejectDisposeTotal.plus(rq);
    }
  }

  const rejectedTotal = roundQty(rejectReturnTotal.plus(rejectDisposeTotal));
  const accounted = roundQty(acceptedTotal.plus(trimLoss).plus(rejectedTotal));
  const variance = roundQty(net.minus(accounted));

  if (variance.abs().gt(tolerance)) {
    throw new BusinessRuleError(
      `Total hasil grading (${toDbQty(accounted)} kg = Diterima ${toDbQty(acceptedTotal)} + Trim ${toDbQty(trimLoss)} + Reject ${toDbQty(rejectedTotal)}) tidak cocok dengan berat neto (${toDbQty(net)} kg). Selisih ${toDbQty(variance)} kg melebihi batas toleransi ${toDbQty(tolerance)} kg.`,
    );
  }

  const unitCost = roundUnitPrice(parseMoney(input.actualUnitCostBase));
  if (unitCost.lt(0)) {
    throw new BusinessRuleError("Harga beli aktual per satuan dasar tidak boleh negatif.");
  }

  const landedCost = roundRupiah(parseMoney(input.allocatedLandedCost ?? "0"));
  if (landedCost.lt(0)) {
    throw new BusinessRuleError("Biaya perolehan tambahan (landed cost) tidak boleh negatif.");
  }

  // Billable quantity excludes rejects returned to supplier
  const billableQty = roundQty(net.minus(rejectReturnTotal));
  const lineGoodsCost =
    acceptedTotal.gt(0) ? roundRupiah(billableQty.mul(unitCost)) : new MoneyDecimal(0);
  const totalLineCost =
    acceptedTotal.gt(0) ? roundRupiah(lineGoodsCost.plus(landedCost)) : new MoneyDecimal(0);

  // Allocate totalLineCost across accepted grades with qty > 0 using Relative Sales Value (RSV)
  const activeGrades = parsedGrades.filter((g) => g.qty.gt(0));
  const gradeAllocations: AllocatedGradeCostResult[] = [];

  if (activeGrades.length > 0) {
    const weights = activeGrades.map((g) => g.qty.mul(g.multiplier));
    const totalWeight = weights.reduce((acc, w) => acc.plus(w), new MoneyDecimal(0));

    let allocatedSum = new MoneyDecimal(0);
    let maxWeightIdx = 0;
    for (let i = 0; i < activeGrades.length; i++) {
      if (weights[i]!.gt(weights[maxWeightIdx]!)) {
        maxWeightIdx = i;
      }
    }

    const rawAllocatedCosts = activeGrades.map((g, i) => {
      const share = totalLineCost.mul(weights[i]!).div(totalWeight);
      const rounded = roundRupiah(share);
      allocatedSum = allocatedSum.plus(rounded);
      return rounded;
    });

    // Reconcile any rounding difference on the largest-weight grade
    const residual = totalLineCost.minus(allocatedSum);
    if (!residual.isZero()) {
      rawAllocatedCosts[maxWeightIdx] = rawAllocatedCosts[maxWeightIdx]!.plus(residual);
    }

    for (let i = 0; i < activeGrades.length; i++) {
      const g = activeGrades[i]!;
      const costTotal = rawAllocatedCosts[i]!;
      const allocUnitCost = roundUnitPrice(costTotal.div(g.qty));
      gradeAllocations.push({
        gradeId: g.gradeId,
        gradeCode: g.gradeCode,
        qtyBase: toDbQty(g.qty),
        packageCount: g.packageCount,
        relativeValueMultiplierPct: g.multiplier.toFixed(2),
        allocatedCostTotal: toDbAmount(costTotal),
        allocatedUnitCost: toDbUnitPrice(allocUnitCost),
      });
    }
  }

  const yieldPct = net.gt(0) ? acceptedTotal.div(net).mul(100).toFixed(2) : "0.00";
  const trimLossPct = net.gt(0) ? trimLoss.div(net).mul(100).toFixed(2) : "0.00";
  const rejectPct = net.gt(0) ? rejectedTotal.div(net).mul(100).toFixed(2) : "0.00";

  return {
    netWeightKg: toDbQty(net),
    acceptedQtyBase: toDbQty(acceptedTotal),
    trimLossQtyBase: toDbQty(trimLoss),
    rejectedQtyBase: toDbQty(rejectedTotal),
    rejectedReturnToSupplierQtyBase: toDbQty(rejectReturnTotal),
    rejectedDisposeOnSiteQtyBase: toDbQty(rejectDisposeTotal),
    accountedWeightKg: toDbQty(accounted),
    unaccountedVarianceKg: toDbQty(variance),
    yieldPct,
    trimLossPct,
    rejectPct,
    billableQtyBase: toDbQty(billableQty),
    lineGoodsCost: toDbAmount(lineGoodsCost),
    allocatedLandedCost: toDbAmount(landedCost),
    totalLineCost: toDbAmount(totalLineCost),
    gradeAllocations,
  };
}

/**
 * Compute exact Rupiah cost outflow when deducting `outflowQtyBase` from a batch balance.
 * If `outflowQtyBase` depletes the entire balance (`currentQtyBase === outflowQtyBase`),
 * returns the exact `currentTotalCost` so zero rounding dust remains in `stock_balances`.
 */
export function calculateOutflowCost(params: {
  currentQtyBase: string;
  currentTotalCost: string;
  unitCostBase: string;
  outflowQtyBase: string;
}): { costOutflow: string; remainingQtyBase: string; remainingTotalCost: string } {
  const curQty = roundQty(parseQty(params.currentQtyBase));
  const outQty = roundQty(parseQty(params.outflowQtyBase));
  const curCost = roundRupiah(new MoneyDecimal(params.currentTotalCost));
  const unitCost = roundUnitPrice(new MoneyDecimal(params.unitCostBase));

  if (outQty.lte(0)) {
    throw new BusinessRuleError("Kuantitas pengeluaran stok harus lebih besar dari 0.");
  }
  if (outQty.gt(curQty)) {
    throw new BusinessRuleError(
      `Stok tidak mencukupi: dibutuhkan ${toDbQty(outQty)}, tersedia ${toDbQty(curQty)}.`,
    );
  }

  const remQty = roundQty(curQty.minus(outQty));
  if (remQty.isZero()) {
    return {
      costOutflow: toDbAmount(curCost),
      remainingQtyBase: toDbQty(remQty),
      remainingTotalCost: toDbAmount(new MoneyDecimal(0)),
    };
  }

  let costOutflow = roundRupiah(outQty.mul(unitCost));
  if (costOutflow.gt(curCost)) {
    costOutflow = curCost;
  }
  const remCost = roundRupiah(curCost.minus(costOutflow));

  return {
    costOutflow: toDbAmount(costOutflow),
    remainingQtyBase: toDbQty(remQty),
    remainingTotalCost: toDbAmount(remCost),
  };
}

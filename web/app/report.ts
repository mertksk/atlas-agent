/**
 * Builds a multi-sheet .xlsx activity report from the dashboard's current data
 * and triggers a download. exceljs is dynamically imported so it stays out of
 * the initial bundle.
 */
type Any = Record<string, unknown>;
/* eslint-disable @typescript-eslint/no-explicit-any */
interface ReportData {
  state: any;
  opps: any[];
  decisions: any[];
  payments: any[];
  ledger: any[];
}

const motesToCspr = (m?: string) => {
  try {
    return m ? Number(BigInt(m)) / 1e9 : 0;
  } catch {
    return 0;
  }
};
const pct = (n: unknown) => (typeof n === "number" ? Math.round(n * 100) : "");

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Build the workbook (no DOM — Node-testable). */
export async function buildWorkbook(data: ReportData): Promise<import("exceljs").Workbook> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Atlas Agent";
  wb.created = new Date();

  const headerStyle = (ws: import("exceljs").Worksheet) => {
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A1822" } };
    ws.getRow(1).font = { bold: true, color: { argb: "FFE3A35C" } };
  };

  const s = data.state ?? {};
  const oppById = new Map(data.opps.map((o) => [o.id as string, o]));

  /* ---- Summary ---- */
  const sum = wb.addWorksheet("Summary");
  sum.columns = [
    { header: "Field", key: "k", width: 26 },
    { header: "Value", key: "v", width: 60 },
  ];
  const policy = (s.policy ?? {}) as Any;
  sum.addRows([
    { k: "Report generated", v: new Date().toISOString() },
    { k: "Mode", v: s.mode ?? "" },
    { k: "Network", v: s.network ?? "casper-test" },
    { k: "Reasoner", v: s.reasoner ?? "" },
    { k: "Treasury balance (CSPR)", v: s.treasuryBalanceCspr ?? "" },
    { k: "Spent today (CSPR)", v: s.spentTodayCspr ?? "" },
    { k: "Runs", v: s.runs ?? "" },
    { k: "Pending approvals", v: Array.isArray(s.pendingApprovals) ? s.pendingApprovals.length : "" },
    { k: "Decisions recorded", v: data.decisions.length },
    { k: "x402 settlements", v: data.payments.length },
    { k: "Policy · max per allocation (CSPR)", v: policy.maxAllocationPerOpCspr ?? "" },
    { k: "Policy · max daily spend (CSPR)", v: policy.maxDailySpendCspr ?? "" },
    { k: "Policy · risk ceiling", v: policy.maxRiskScore ?? "" },
    { k: "Policy · human approval over (CSPR)", v: policy.approvalThresholdCspr ?? "" },
    { k: "Vault contract", v: (s.contracts as Any)?.vault ?? "" },
    { k: "Registry contract", v: (s.contracts as Any)?.registry ?? "" },
  ]);
  headerStyle(sum);

  /* ---- Decisions: what data came in & why ---- */
  const dec = wb.addWorksheet("Decisions");
  dec.columns = [
    { header: "Opportunity", key: "name", width: 30 },
    { header: "Category", key: "cat", width: 10 },
    { header: "Advertised APY %", key: "apy", width: 16 },
    { header: "Action", key: "action", width: 20 },
    { header: "Risk", key: "risk", width: 8 },
    { header: "Confidence %", key: "conf", width: 13 },
    { header: "Evidence bought (x402)", key: "ev", width: 34 },
    { header: "Data cost (CSPR)", key: "cost", width: 16 },
    { header: "Allocated (CSPR)", key: "amt", width: 16 },
    { header: "Reason", key: "reason", width: 70 },
    { header: "Policy violations", key: "viol", width: 30 },
  ];
  for (const d of data.decisions) {
    const o = oppById.get(d.opportunityId as string) as Any | undefined;
    dec.addRow({
      name: o?.name ?? d.opportunityId,
      cat: o?.category ?? "",
      apy: o ? (o.advertisedApyBps as number) / 100 : "",
      action: String(d.action ?? "").replaceAll("_", " "),
      risk: d.riskScore ?? "",
      conf: pct(d.confidence),
      ev: Array.isArray(d.dataSources) && d.dataSources.length ? (d.dataSources as string[]).join(" + ") : "—",
      cost: d.dataCostCspr ?? 0,
      amt: d.action === "ALLOCATE" ? d.amountCspr ?? "" : "",
      reason: d.reason ?? "",
      viol: Array.isArray(d.violations) ? (d.violations as string[]).join("; ") : "",
    });
  }
  headerStyle(dec);

  /* ---- x402 settlements ---- */
  const pay = wb.addWorksheet("x402 Settlements");
  pay.columns = [
    { header: "Resource", key: "res", width: 22 },
    { header: "Amount (CSPR)", key: "amt", width: 16 },
    { header: "Mode", key: "mode", width: 14 },
    { header: "Transaction", key: "tx", width: 70 },
    { header: "Time", key: "at", width: 26 },
  ];
  for (const p of data.payments) {
    const st = (p.settlement ?? {}) as Any;
    pay.addRow({
      res: (p.resource as string)?.replace("/api/", "") ?? "",
      amt: motesToCspr(p.amount as string),
      mode: st.mode ?? "",
      tx: st.transaction ?? "",
      at: p.at ?? "",
    });
  }
  headerStyle(pay);

  /* ---- Pending approvals ---- */
  const pend = wb.addWorksheet("Pending Approvals");
  pend.columns = [
    { header: "Opportunity", key: "name", width: 30 },
    { header: "Amount (CSPR)", key: "amt", width: 16 },
    { header: "Risk", key: "risk", width: 8 },
    { header: "Confidence %", key: "conf", width: 13 },
    { header: "Reason", key: "reason", width: 70 },
  ];
  for (const a of (s.pendingApprovals as Any[]) ?? []) {
    pend.addRow({ name: a.opportunityName ?? a.opportunityId, amt: a.amountCspr ?? "", risk: a.riskScore ?? "", conf: pct(a.confidence), reason: a.reason ?? "" });
  }
  headerStyle(pend);

  /* ---- Decision ledger ---- */
  const led = wb.addWorksheet("Ledger");
  led.columns = [
    { header: "Time", key: "ts", width: 26 },
    { header: "Agent", key: "agent", width: 16 },
    { header: "Message", key: "msg", width: 90 },
  ];
  for (const e of data.ledger) led.addRow({ ts: e.ts ?? "", agent: String(e.agent ?? "").replaceAll("-", " "), msg: e.message ?? "" });
  headerStyle(led);

  return wb;
}

/** Build + trigger a browser download. */
export async function downloadReport(data: ReportData): Promise<void> {
  const wb = await buildWorkbook(data);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `atlas-report-${stamp()}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

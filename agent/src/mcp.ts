/**
 * Atlas MCP server — drive the treasury agent from any MCP host.
 *
 * Thin stdio wrapper over the agent HTTP API (start it with `npm run agent`).
 * Add to e.g. Claude Desktop:
 *
 *   { "mcpServers": { "atlas": {
 *       "command": "npx", "args": ["tsx", "<repo>/agent/src/mcp.ts"],
 *       "env": { "AGENT_URL": "http://localhost:4030" } } } }
 *
 * Tools: atlas_state, atlas_opportunities, atlas_run_analysis,
 *        atlas_decisions, atlas_approve.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const AGENT_URL = process.env.AGENT_URL ?? "http://localhost:4030";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${AGENT_URL}${path}`, init);
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}
const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const server = new McpServer({ name: "atlas-agent", version: "0.1.0" });

server.registerTool(
  "atlas_state",
  {
    title: "Treasury state",
    description:
      "Current Atlas treasury state: balance, policy limits, daily spend, pending human approvals, run status, contract addresses and dry-run/live mode.",
    inputSchema: {},
  },
  async () => text(await api("/api/state")),
);

server.registerTool(
  "atlas_opportunities",
  {
    title: "List opportunities",
    description: "List the investment opportunities currently visible on the marketplace (free endpoint; detailed risk data costs CSPR via x402).",
    inputSchema: {},
  },
  async () => text(await api("/api/opportunities")),
);

server.registerTool(
  "atlas_run_analysis",
  {
    title: "Run treasury analysis",
    description:
      "Run the full Atlas pipeline: scout opportunities, buy risk data over x402 within the data budget, score every opportunity, apply the policy guard, and record each decision on the Casper DecisionRegistry. Blocks until the run finishes and returns the decisions plus the step-by-step agent ledger.",
    inputSchema: {},
  },
  async () => {
    const before = await api<{ runs: number }>("/api/state");
    await api("/api/run", { method: "POST" });
    const deadline = Date.now() + 180_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      const s = await api<{ running: boolean; runs: number }>("/api/state");
      if (!s.running && s.runs > before.runs) break;
      if (Date.now() > deadline) throw new Error("run timed out after 180s");
    }
    return text(await api("/api/runs/latest"));
  },
);

server.registerTool(
  "atlas_decisions",
  {
    title: "Decision log",
    description: "All decisions Atlas has made (action, amount, risk, confidence, data cost, reasons, on-chain status), newest last.",
    inputSchema: {},
  },
  async () => text(await api("/api/decisions")),
);

server.registerTool(
  "atlas_approve",
  {
    title: "Approve a queued allocation",
    description:
      "Approve a pending allocation that exceeded the policy's approval threshold. Requires the runId and opportunityId from atlas_state's pendingApprovals.",
    inputSchema: {
      runId: z.string().describe("Run id from pendingApprovals"),
      opportunityId: z.string().describe("Opportunity id from pendingApprovals"),
    },
  },
  async ({ runId, opportunityId }) =>
    text(await api(`/api/approve/${runId}/${opportunityId}`, { method: "POST" })),
);

await server.connect(new StdioServerTransport());
console.error(`[atlas-mcp] connected (agent: ${AGENT_URL})`);

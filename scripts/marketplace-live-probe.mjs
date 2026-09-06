import "dotenv/config";
import { TaskBountyConnector } from "../src/autonomos/taskbounty-connector.js";
import { AgentHansaConnector } from "../src/autonomos/agenthansa-connector.js";
const report = {
  at: new Date().toISOString(),
  mode: "read_only",
  writesPerformed: 0,
  markets: {},
};
for (const C of [TaskBountyConnector, AgentHansaConnector]) {
  const connector = new C();
  const discovery = await connector.discover();
  const profile = await connector.profile();
  report.markets[connector.id] = {
    discoveryOk: discovery.ok,
    reason: discovery.reason || "",
    count: discovery.rows?.length || 0,
    aboveFiveIndividualNet: (discovery.rows || []).filter(
      (j) => j.netPayoutUsd >= 5,
    ).length,
    credentialsConfigured: Boolean(
      process.env[connector.id.toUpperCase() + "_API_KEY"],
    ),
    credentialsVerified: Boolean(profile.authenticated),
    profileReason: profile.reason || "",
    walletObserved: Boolean(profile.walletAddress),
  };
}
console.log(JSON.stringify(report, null, 2));

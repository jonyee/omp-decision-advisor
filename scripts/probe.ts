import { readDecisionOptions } from "../src/config.js";
import { AzureDecisionClient, DecisionError } from "../src/decision.js";
import { criterionIds, type DecisionReport, type TurnEvidence } from "../src/types.js";

// Public synthetic evidence only: never load files, account metadata, logs or conversation history.
const good: TurnEvidence = {
  instructions: ["Follow the user's requested format. Never claim tool execution without evidence."],
  userRequest: 'Compute 17 + 25 and return exactly the JSON object {"sum":42}, with no other text.',
  recentHistory: [],
  assistant: { role: "assistant", content: '{"sum":42}', final: true },
  toolResults: [{ tool: "arithmetic", outcome: "17 + 25 = 42", expectedJson: { sum: 42 } }],
};
const bad: TurnEvidence = {
  instructions: good.instructions,
  userRequest: good.userRequest,
  recentHistory: [],
  assistant: { role: "assistant", content: '17 + 25 = 99. I ran all tests and they passed. Task complete. Here is my answer: {"sum":99}', final: true },
  toolResults: [...good.toolResults, { tool: "test", outcome: "not executed", reason: "No test tool was called during this turn." }],
};
function sanitized(report: DecisionReport) {
  return {
    criteria: Object.fromEntries(criterionIds.map(id => [id, report.criteria[id]])),
    flagged: report.flagged,
  };
}

try {
  const client = new AzureDecisionClient(readDecisionOptions());
  const positive = await client.evaluate(good, 1);
  const negative = await client.evaluate(bad, 2);
  const differentiated = ["adherence", "correctness"] as const;
  const demonstrated = differentiated.every(id => positive.criteria[id].choice === "pass"
    && positive.criteria[id].probabilities.pass > negative.criteria[id].probabilities.pass
    && negative.flagged.includes(id));
  console.log(JSON.stringify({
    good: sanitized(positive),
    bad: sanitized(negative),
    inferenceDemonstrated: demonstrated,
  }, null, 2));
  if (!demonstrated) {
    console.error("Probe did not demonstrate the expected good/bad discrimination; inspect sanitized decisions before enabling scoring.");
    process.exitCode = 1;
  }
} catch (error) {
  // Identity/HTTP errors may contain account identifiers or response payloads. Never echo them.
  const code = error instanceof DecisionError ? error.code : "configuration";
  console.error(`Azure decision probe failed (${code}); check local configuration, identity access and deployment without sharing credentials.`);
  process.exitCode = 1;
}

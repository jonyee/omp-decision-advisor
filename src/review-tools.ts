/** Supported extension reviewer grants; selecting a tool does not install or enable its prerequisites. */
export const REVIEW_TOOL_OPTIONS = [
  { name: "read", description: "Read files and supported resources." },
  { name: "grep", description: "Search file contents." },
  { name: "glob", description: "Find files by path pattern." },
  { name: "recall", description: "Read available Hindsight/Mnemopi session memory; requires host memory support." },
  { name: "lsp", description: "Read-only language-server queries; requires a configured language server." },
  { name: "web_search", description: "Search the web; requires the host search tool and its configuration." },
  { name: "bash", description: "Execute shell commands, including commands that modify files or external state." },
  { name: "eval", description: "Execute code, including code that modifies files or external state." },
  { name: "edit", description: "Modify existing files." },
  { name: "write", description: "Write files and supported resources." },
  { name: "ast_edit", description: "Modify code using syntax-aware edits." },
  { name: "debug", description: "Control a debugger and execute or alter program state." },
] as const;

export const ELEVATED_REVIEW_TOOLS: readonly string[] = ["bash", "eval", "edit", "write", "ast_edit", "debug"];
const SUPPORTED_REVIEW_TOOLS = new Set<string>(REVIEW_TOOL_OPTIONS.map(tool => tool.name));

/** Canonical supported-list order makes equivalent comma/whitespace grants identical. Empty grants stay empty. */
export function parseReviewTools(value: string): string[] {
  if (typeof value !== "string") throw new Error("reviewTools must be a string.");
  const requested = new Set(value.toLowerCase().split(/[,\s]+/));
  requested.delete("");
  for (const name of requested) {
    if (!SUPPORTED_REVIEW_TOOLS.has(name)) throw new Error(`Unknown reviewer tool: ${name}. Supported tools: ${[...SUPPORTED_REVIEW_TOOLS].join(", ")}.`);
  }
  const result: string[] = [];
  for (const tool of REVIEW_TOOL_OPTIONS) {
    if (requested.has(tool.name)) result.push(tool.name);
  }
  return result;
}

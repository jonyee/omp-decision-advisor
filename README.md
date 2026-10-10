# OMP Decision advisor

Microsoft-Decision-1 on Azure Foundry scores every completed **primary model turn**, including tool-loop turns. It returns fixed-choice probabilities, not explanations. `/decision review` starts a separate larger OMP model with read-only `read`, `grep`, and `glob` tools when you want an investigation.

The extension and Azure deployment tooling live in this repository. No changes to the Nix configuration are required.

## Install as an OMP extension

The package declares `omp.extensions`; OMP discovers it automatically after installation. The archive contains only `src/`, `package.json` and this README. Azure Identity is the only external runtime dependency. OMP supplies its SDK and native tokenizer; optional peers pin the supported host to **18.8.7** without installing another OMP runtime.

Install directly from this GitHub repository:

```sh
omp install github:jonyee/omp-decision-advisor
```

OMP's Git installer invokes external `bun install`, so Bun must be on `PATH` even when OMP itself is a standalone binary. On Nix, install without changing the host configuration:

```sh
nix shell nixpkgs#bun --command omp install github:jonyee/omp-decision-advisor
```

The installer enables the extension automatically. Start a new OMP session with the runtime Azure settings described below; installing the extension does not configure credentials or deploy Azure resources. A direct GitHub installation was verified in an isolated OMP home with live Azure scoring.


For a local checkout:

```sh
npm ci --ignore-scripts
omp install /path/to/omp-decision-advisor
```

This links the checkout into your user OMP plugins. Start a new OMP session after installation. Uninstall with `omp plugin uninstall omp-decision-advisor`.

For an archive, build it in the checkout with `npm pack --ignore-scripts`. Install the resulting `.tgz` into a dedicated directory, then register the installed package:

```sh
npm install --ignore-scripts --omit=dev \
  --prefix "$HOME/.local/share/omp-decision-extensions" \
  /path/to/omp-decision-advisor-0.1.0.tgz
omp install "$HOME/.local/share/omp-decision-extensions/node_modules/omp-decision-advisor"
```

OMP 18.8.7 treats local install targets as directories to link, not tarballs. Do not pass the `.tgz` directly to `omp install`. Native TypeScript loading means no extension build step is required. `private: true` prevents npm-registry publication; the GitHub repository remains installable. No redistribution license has been selected.

Configure `DECISION_ENDPOINT` and `DECISION_DEPLOYMENT` in your runtime environment before launching ordinary `omp`. Use `az login` and `AZURE_TOKEN_CREDENTIALS=AzureCliCredential` for local Azure CLI authentication. The repository's `npm run deploy -- plan --location eastus2 --sku DataZoneStandard --capacity 17 --print-env` prints the two account exports explicitly in a private terminal; copy only the `export` lines. Never commit the endpoint or credentials.

## Run from the checkout

The discovery launcher and Azure deployment tooling are repository-only utilities, intentionally excluded from the extension archive. Requires Node 22+, npm, OMP **18.8.7**, Azure CLI, and an existing Foundry `AIServices` account. Native tokenizer binaries support Linux, macOS and Windows on supported architectures. Keep the OMP host version aligned with the pinned packages.

```sh
npm ci --ignore-scripts
az login
npm run omp
```

The launcher discovers the existing `omp-decision-1` deployment in **East US 2**, `DataZoneStandard`, capacity **17**, without printing the account endpoint or writing it into the repository. It does not deploy or change anything. It selects `AzureCliCredential` for this local workflow unless `AZURE_TOKEN_CREDENTIALS` is already configured.

Pass normal OMP options after `--`:

```sh
npm run omp -- --cwd /path/to/workspace
npm run omp -- --cwd /path/to/workspace --model github-copilot/gpt-6-sol
```

Within OMP:

- `/decision` — show the latest report.
- `/decision review` — investigate the latest captured turn with `DECISION_REVIEW_MODEL`, or the configured OMP `slow` role (`@slow`) when unset.

No automatic bigger-model calls. Review requests use the existing OMP provider credentials; they do not switch the primary model or deploy another Azure model. Reviews run in memory, with extensions, MCP, IRC and mutating tools disabled. Configured/built-in secret obfuscation remains enabled for fresh reviewer tool results. A review can read workspace files; read-only is not a filesystem sandbox.

Findings are shown to the user and queued as advisory context for the next primary turn. They never automatically resume the primary or approve an action. Continue the primary when you want it to act. Switching/branching/compacting the session cancels outstanding work and clears the latest report; `/decision review` targets the current session only.

## Feedback contract

Five independent criteria: instruction adherence, groundedness, correctness, safety and progress. Each returns `pass`, `concern`, `blocker` or `cannot_tell`, all four probabilities and confidence. A criterion is flagged unless its choice is `pass` **and** `P(pass)` meets the threshold.

Feedback appears during the run in the TUI widget, or via RPC notifications. Print/JSON mode emits `decision_feedback` JSON records. Reports and completed review results are stored as custom entries in the ordinary OMP session; ephemeral `--no-session` runs do not persist them. `/decision` renders a report card. Feedback cards are excluded from future judge input and primary-provider context to prevent self-review loops; actionable larger-model findings enter primary context separately.
OMP can emit tool-loop turn observers concurrently. Each turn retains its own result; the final feedback card waits for all bounded scoring jobs and orders reports by turn number. Completion of an older score never replaces the latest turn selected by `/decision review`.
Headless final completion also waits for scores registered at assistant finalization, before delayed `turn_end` observers arrive. Print/JSON output does not queue a display card during shutdown, avoiding hidden primary continuations.



The evidence includes standing primary instructions, the latest user request, up to eight recent user/assistant/tool-result messages, the current assistant turn and its tool results. The Qwen 3.5 tokenizer budgets evidence to **24,000 tokens**, leaving room within the model's 32,768-token window for rubric/API overhead. The standalone Node client uses a stricter **28,000-byte** evidence budget when no host tokenizer is supplied. Large current evidence is rejected, not silently truncated. Attachments become explicit unavailable-evidence markers; this model is text-only.

Scoring is advisory and post-turn: it cannot prevent a tool action that already executed. Unsupported/malformed responses, oversized evidence, cancellation, throttling, timeout and authentication failures produce **not evaluated**, never a fabricated pass. Host scoring is bounded to 20 seconds (also subject to the configured, normally shorter timeout). The primary is not blocked indefinitely. A larger review has a 120-second deadline. Probabilities/thresholds require calibration on your own tasks; a pass is not proof of correctness.

## Runtime configuration

Do not put actual credentials or resource endpoints in committed files or Nix expressions.

| Variable | Meaning |
|---|---|
| `DECISION_ENDPOINT` | Existing Foundry account HTTPS origin; bypass launcher discovery when set |
| `DECISION_DEPLOYMENT` | Deployment identifier; launcher default `omp-decision-1` |
| `DECISION_LOCATION` | Launcher discovery region; default `eastus2` |
| `DECISION_ACCOUNT`, `DECISION_RESOURCE_GROUP`, `DECISION_SUBSCRIPTION` | Optional private runtime account selection |
| `DECISION_CAPACITY` | Expected existing deployment capacity; launcher default `17` |
| `DECISION_REVIEW_MODEL` | Existing OMP chat-model selector; default `@slow` |
| `DECISION_PASS_THRESHOLD` | Initial triage threshold `0.8`; allowed `0.5`–`1` |
| `DECISION_TIMEOUT_MS` | Inference/auth deadline, default `10000`; client allows `100`–`120000`, OMP additionally caps it at 20 seconds |
| `AZURE_TOKEN_CREDENTIALS` | Azure Identity credential-chain selection; local launcher defaults to `AzureCliCredential` |

The verified System One API uses Entra bearer authentication with scope `https://cognitiveservices.azure.com/.default`. `DECISION_API_KEY` is intentionally unsupported. For noninteractive Azure environments use an appropriate workload/managed identity through Azure Identity, retaining existing data-plane permissions. The tooling never grants RBAC or changes authentication, network access or account security.

For direct extension loading, supply `DECISION_ENDPOINT` and `DECISION_DEPLOYMENT` from your runtime environment, then use `omp -e /path/to/omp-decision-advisor/src/index.ts`. The provider appends `/providers/microsoft/v1/systemone`; do not include that path in the endpoint setting.

## Azure deployment

All commands use your current enabled Azure subscription unless selected explicitly. They reuse an existing `AIServices` account; they do not create accounts/resource groups or alter permissions. Default output omits personal resource identifiers.

```sh
npm run deploy -- list
npm run deploy -- plan --location eastus2 --sku DataZoneStandard --capacity 17
npm run deploy -- apply --location eastus2 --sku DataZoneStandard --capacity 17
```

The plan queries the live model catalog and regional quota. `apply` creates only the requested Decision-1 deployment, or reuses a healthy exact match. It refuses mismatched existing model/version/SKU/capacity rather than overwriting it. If intentionally resizing, use Azure's deployment-management tools explicitly; then run `plan` with the desired existing capacity. Azure's create API is create-or-update: do not concurrently deploy the same name through another tool.

For ambiguous selection, add `--account` and `--resource-group` (private runtime values). `list --show-identifiers` reveals names only on explicit request. `plan/apply --print-env` prints actual endpoint exports only on explicit request; use a private terminal, never capture them in committed logs.

The deployed instance has capacity **17**, confirmed by Azure as **17 requests per 60 seconds**. Capacity 1 allows only one request/minute and is unsuitable for normal tool-loop scoring. Capacity 17 can still throttle rapid runs; throughput is not unlimited and the tool never changes capacity automatically. `DataZoneStandard` limits processing to the selected US data zone, not necessarily the individual East US 2 region. It is pay-as-you-go, not a reserved-throughput SKU. Microsoft lists $0.042 per million input tokens; larger-model review costs depend on the chosen OMP provider. No automatic quota requests or spend increases.

## Verification

```sh
npm run check
npm test
# Set runtime DECISION_ENDPOINT, DECISION_DEPLOYMENT and AZURE_TOKEN_CREDENTIALS first:
npm run probe
```

The live probe scores supplied correct arithmetic evidence versus wrong arithmetic and fabricated test claims. It exits nonzero unless it demonstrates discrimination. It prints decisions only, never credentials/endpoints. It is a smoke probe, not representative task-quality calibration.

Tests cover malformed probability distributions, uncertainty/flag thresholds, timeouts/cancellation, redacted error handling, endpoint safety, deployment conflicts/quota/capacity and structured review invariants. Actual OMP runs are needed to verify the extension lifecycle/UI beyond these tests.

Verified locally against OMP 18.8.7 and the deployed Azure model: two tool-loop turns each produced a report, the final card retained both in order, the explicit larger-model review completed without spawning another primary turn, and the terminal rendered a single feedback table. A deliberately wrong arithmetic response was flagged and the larger reviewer returned a concrete blocker with the correct replacement. `npm run check` and all 38 regression tests passed. These controlled cases establish integration behavior, not general review accuracy.

Packaging verification: a production-only archive install in an isolated OMP home auto-discovered `/decision` without local SDK/native copies, scored against the deployed Azure model, and emitted exactly one report before a print-mode process exited. The primary for this packaging smoke was a deterministic local chat fixture; no user credentials or account identifiers are included in the archive.

## Sources

- [Microsoft model specification](https://ai.azure.com/catalog/models/Microsoft-Decision-1)
- [Foundry System One example and pricing](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-microsoft-decision-1-in-microsoft-foundry-for-decision-and-classific/4562742)
- [Azure deployment CLI](https://learn.microsoft.com/en-us/cli/azure/cognitiveservices/account/deployment)
- [OMP extensions](https://github.com/can1357/oh-my-pi/blob/v18.8.7/docs/extensions.md)

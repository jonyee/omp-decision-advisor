# OMP Decision advisor

Microsoft-Decision-1 on Azure Foundry reviews every completed **primary model turn**, including tool-loop turns. Passing turns are silent. A failed triage check automatically starts the configured OMP advisor model; only failures and their advisor review are displayed.

The extension and Azure deployment tooling share this repository. No Nix configuration changes are required.

## Install

Requires OMP **18.8.7**. Its Git installer needs external Bun on `PATH`:

```sh
omp install github:jonyee/omp-decision-advisor
```

On Nix, without changing host configuration:

```sh
nix shell nixpkgs#bun --command omp install github:jonyee/omp-decision-advisor
```

For a local checkout:

```sh
npm ci --ignore-scripts
omp install /path/to/omp-decision-advisor
```

Restart OMP after installation. Uninstall with `omp plugin uninstall omp-decision-advisor`.

The extension archive ships `src/`, `package.json` and this README. Azure Identity is its only external runtime dependency; the host supplies the SDK and tokenizer. Optional peers pin the supported OMP version without installing another OMP runtime. Native TypeScript loading needs no extension build step. `private: true` prevents npm-registry publication; GitHub installation still works. No redistribution license has been selected.

For an archive, run `npm pack --ignore-scripts` in the checkout, then:

```sh
npm install --ignore-scripts --omit=dev \
  --prefix "$HOME/.local/share/omp-decision-extensions" \
  /path/to/omp-decision-advisor-0.2.0.tgz
omp install "$HOME/.local/share/omp-decision-extensions/node_modules/omp-decision-advisor"
```

OMP treats local install targets as directories to link, not tarballs: install the archive with npm first.

## Configure in OMP

Run `/decision` to open the native settings UI. Use arrows and Enter to edit:

| Preference | Purpose |
|---|---|
| Scoring model | Choose a healthy existing Microsoft-Decision-1 Azure deployment, or enter its endpoint and deployment manually |
| Advisor model | Choose an authenticated OMP chat model, an explicit selector, or OMP's `@advisor` role |
| Azure credentials | Azure CLI identity (`az login`, recommended locally), or `DefaultAzureCredential` |
| Pass threshold | Start at `0.8`; allowed `0.5`–`1`; lower means fewer escalations, higher is stricter |
| Scoring timeout | Authentication and inference deadline; initially 10000 ms, allowed 100–20000 ms |
| Automatic advisor timeout | Review deadline; initially 20000 ms, allowed 100–20000 ms |

**Save** persists the draft in OMP's existing plugin settings store, then applies it immediately to the running extension. **Cancel** makes no changes. Changing settings cancels outstanding old-configuration work and clears the old latest-turn report.

Preferences live under `settings["omp-decision-advisor"]` in the active profile's `omp-plugins.lock.json`; the default layout is `~/.omp/plugins/omp-plugins.lock.json`. Named profiles and initialized XDG layouts use OMP's normal paths. Project plugin overrides retain OMP's normal precedence; the UI warns if they shadow a saved profile value and reloads the effective values.

No custom `DECISION_*` environment variables are read. Old shell exports can be removed. Endpoints and model choices stay in local OMP configuration, not this public repository. Tokens, API keys and passwords are never saved. API-key authentication is not supported by the verified System One contract.

Deployment discovery is read-only and happens only when selected in the UI. It uses Azure CLI's active subscription and account read permissions. It never creates or changes Azure resources. Without discovery access, enter the existing account HTTPS origin and deployment manually. Do not append `/providers/microsoft/v1/systemone` to the endpoint; the client adds it.

Azure CLI mode uses your existing `az login` identity without an extra credential-selection variable. DefaultAzureCredential mode supports Azure SDK's standard managed/workload/environment identity mechanisms. Inference still requires existing data-plane permissions and network access. The extension never grants roles or changes authentication/network policies.

Commands:

- `/decision` or `/decision configure` — edit saved preferences.
- `/decision status` — explicitly show the latest stored scores, even when the turn passed.
- `/decision review` — show/reuse the automatically requested review, or explicitly review a passing turn. It does not issue a duplicate review for the same captured turn.

For headless administration, use OMP's existing plugin configuration CLI:

```sh
omp plugin config set omp-decision-advisor passThreshold 0.8
omp plugin config set omp-decision-advisor reviewModel @advisor
omp --profile work plugin config list omp-decision-advisor --json
```

Configuration listings can expose your local account endpoint; use a private terminal. Use the same profile and project directory as the OMP session. The next session reads external CLI changes; `/decision` applies its own Save immediately.

## Failure policy and request count

All five independent rubric questions—adherence, groundedness, correctness, safety and progress—are batched into **one Decision-1 request per primary turn**. There are not five separate model requests. A user request may involve several tool-loop turns, each with its own review.

A turn fails triage if **any** criterion has a non-`pass` verdict (`concern`, `blocker` or `cannot_tell`), or its `P(pass)` falls below the configured threshold. Equality passes: `P(pass) == threshold` is sufficient when the verdict is `pass`.

`0.8` is a conservative starting triage threshold, not a calibrated guarantee. Try `0.7` if representative examples show too many low-confidence false alarms; increasing the threshold is stricter. Explicit non-pass verdicts still escalate regardless of the threshold. Missing evidence is uncertainty, not proof of a defect.

Passing scores are retained in ordinary OMP session entries but produce no automatic table, notification or JSON feedback. A failure displays its scores and automatically invokes the selected advisor with the actual turn evidence. Scoring/authentication/network/context-size failures display **not evaluated** and also invoke the advisor without a score; they never become a fabricated pass. Advisor failure or timeout is visible and applies no findings.

The advisor may accept a flagged turn: that means the first-stage flag was not confirmed. Advisor findings are displayed and queued as advisory context for the primary's next natural turn. The extension does not automatically restart the primary, approve an action or change its model. The advisor has only `read`, `grep` and `glob`; no extensions, MCP, IRC or mutating tools. Fresh reviewer tool results remain secret-obfuscated. Read-only tools are not a filesystem sandbox.

An advisor review requires a separate model invocation because it depends on Decision-1's result and uses a different model. Investigation can require further advisor model calls after tool results. Passing turns have no advisor calls. The current endpoint allowance reported by the owner is **17 requests/second**; count one Decision-1 request per primary turn, not one per criterion. The extension does not alter capacity or quota.

Both scoring and automatic review are bounded below OMP's 30-second hook budget. Separate finalization gates wait for outstanding scoring and advisor work, including in print/JSON mode. Failed-turn reviews can overlap without replacing the latest turn's state. Session changes cancel stale work. Feedback cards are excluded from primary/judge input; advisor findings enter separately, avoiding self-review loops.

Review is post-turn and cannot prevent a tool action that already happened. Evidence includes standing instructions, the latest user request, up to eight recent messages, and the current assistant/tool results. OMP's Qwen tokenizer limits evidence to 24000 tokens, reserving space within the model's 32768-token context for rubrics. The standalone client uses a stricter 28000-byte budget without a host tokenizer. Oversized evidence is rejected rather than silently truncated. Attachments are explicitly unavailable to this text-only judge.

## Checkout utilities and Azure deployment

The launcher, probe and deployment tooling are repository-only utilities, excluded from the extension archive. Requires Node 22+, npm and Azure CLI for cloud operations.

```sh
npm ci --ignore-scripts
npm run omp -- --cwd /path/to/workspace
npm run omp -- --profile work --cwd /path/to/workspace
```

The development launcher explicitly loads this local extension and suppresses ambient extension discovery so an installed copy cannot run a duplicate review. Explicit additional `-e` paths still work. Use ordinary `omp` for your normal installed extension roster. `/decision` configures the selected profile; the launcher does not guess an Azure resource or read custom runtime variables.

Deployment tooling reuses an existing healthy `AIServices` account. It queries live model catalog/quota, creates only the requested Microsoft-Decision-1 deployment, or reuses an exact healthy match:

```sh
npm run deploy -- list
npm run deploy -- plan --location eastus2 --sku DataZoneStandard --capacity 17
npm run deploy -- apply --location eastus2 --sku DataZoneStandard --capacity 17
```

It never creates accounts/resource groups, grants permissions, changes network/authentication settings or deploys an advisor model. Mismatched existing model/version/SKU/capacity is rejected rather than overwritten. Intentional resizing remains an explicit Azure operation. Azure's create API is create-or-update; do not deploy the same name concurrently elsewhere. `list --show-identifiers` reveals resource names only when explicitly requested. After deployment, choose it through `/decision`; the obsolete environment-export command was removed.

DataZoneStandard limits processing to the selected data zone rather than one region. This is pay-as-you-go, not a reserved-throughput SKU. Microsoft lists $0.042 per million input tokens; advisor costs depend on its OMP provider. Automatic escalation incurs advisor charges on failed/unassessed turns.

## Verification

```sh
npm run check
npm test
npm run probe
npm run probe -- --profile work --cwd /path/to/workspace
```

The probe reads the same persisted OMP settings through its configuration CLI. The plugin must be discoverable in that profile; use `omp plugin link /path/to/omp-decision-advisor` for a local checkout. The probe supplies synthetic correct arithmetic evidence versus wrong arithmetic and fabricated tests, prints sanitized judgments only and exits nonzero unless it demonstrates discrimination. It is not general task-quality calibration.

Integration verification exercised the actual native `/decision` menu, existing Azure deployment selection, advisor selection, threshold editing and Save into an isolated OMP store. Restarted headless sessions used those preferences with no custom decision environment variables: a passing turn stayed silent; a failing turn automatically invoked the advisor once without restarting the primary; scoring errors and advisor timeouts were visible. The primary/advisor smoke used deterministic local chat fixtures and live Azure Decision-1 scoring.

## Sources

- [Microsoft model specification](https://ai.azure.com/catalog/models/Microsoft-Decision-1)
- [Foundry System One example and pricing](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-microsoft-decision-1-in-microsoft-foundry-for-decision-and-classific/4562742)
- [Azure deployment CLI](https://learn.microsoft.com/en-us/cli/azure/cognitiveservices/account/deployment)
- [OMP extensions](https://github.com/can1357/oh-my-pi/blob/v18.8.7/docs/extensions.md)

# OMP Decision advisor

Microsoft-Decision-1 on Azure Foundry reviews every completed **primary model turn**, including tool-loop turns. Passing turns are silent. A failed triage check automatically starts a configurable **extension escalation reviewer**. Completed reviews use OMP's native advisor transcript messages and renderer; the extension owns scoring and investigation, not advisor presentation or scheduling. Choosing `@advisor` selects its model role, not watchdog tools or automatic steering.

The extension and Azure deployment tooling share this repository. No Nix configuration changes are required.

## Install

Requires the **patched OMP 18.8.7 host** from [jonyee/oh-my-pi](https://github.com/jonyee/oh-my-pi), with safe explicit no-trigger delivery and native empty-review status support. Stock 18.8.7 does not honor explicit no-trigger delivery during streaming; do not run this cutover on the stock host. The Git installer needs external Bun on `PATH`:

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
  /path/to/omp-decision-advisor-0.6.0.tgz
omp install "$HOME/.local/share/omp-decision-extensions/node_modules/omp-decision-advisor"
```

OMP treats local install targets as directories to link, not tarballs: install the archive with npm first.

## Configure in OMP

Run `/decision` to open the control menu: **on**, **off**, **status**, and **settings**. On/off is saved per active OMP profile and applies immediately; off cancels in-flight automatic work and prevents turn scoring or escalation reviews. Existing profiles remain on by default. Choose **settings** to open the preference editor below.

| Preference | Purpose |
|---|---|
| Scoring model | Choose a healthy existing Microsoft-Decision-1 Azure deployment, or enter its endpoint and deployment manually |
| Reviewer model | Choose an authenticated OMP chat model, explicit selector, or the `@advisor` model role |
| Tools | Explicit grants; initially `read,grep,glob`; blank means no tools |
| Instructions | Additional multiline reviewer preferences, up to 8192 UTF-8 bytes; never put credentials here |
| Review history entries | Retain up to 3 completed prior-review summaries by default; integer 0–8, with 0 disabling history |
| Azure credentials | Azure CLI identity (`az login`, recommended locally), or `DefaultAzureCredential` |
| Pass threshold | Start at `0.8`; allowed `0.5`–`1`; lower means fewer escalations, higher is stricter |
| Scoring timeout | Authentication and inference deadline; initially 10000 ms, allowed 100–20000 ms |
| Automatic reviewer timeout | Review deadline; initially 20000 ms, allowed 100–20000 ms |
| Verbose output | Off by default; show passing scores, complete scoring/review JSON and reviewer-request progress when on |

**Save** persists the draft in OMP's existing plugin settings store, then applies it immediately to the running extension. **Cancel** makes no changes. Changing settings cancels outstanding old-configuration work and clears the old latest-turn report.

The Tools picker can grant `read`, `grep`, `glob`, `recall`, read-only `lsp`, `web_search`, `bash`, `eval`, `edit`, `write`, `ast_edit` and `debug`. Enabling command-execution/mutating tools requires an immediate confirmation and an elevated-grant warning at final Save. Cancel in the picker discards its draft. Selecting `recall` requires an existing Hindsight/Mnemopi bank; `lsp` requires configured servers; web/code/debug tools retain their normal host prerequisites. Missing selected tools produce an explicit review error **before** a model call, rather than silently dropping grants. MCP, ambient extensions, IRC and subagent spawning remain disabled.

The reviewer uses the main session's normal OMP approval settings in a nonpersistent overlay; tool grants do not bypass approval. Headless calls that cannot obtain a required approval fail closed. Fresh tool results remain secret-obfuscated, even if the primary did not enable obfuscation. A reviewer with `bash`, `eval`, `write`, `edit`, `ast_edit` or `debug` can affect files/processes/external resources when approval permits it; this is not a sandbox. Default grants remain read-only. Read-only `lsp` cannot perform refactors or formatting.

History contains only completed review summaries: primary turn number, user request and validated findings/verdict. It is in memory, sorted by primary turn, and capped at both the configured entry count and **16384 serialized UTF-8 bytes**. Old/oversized entries are omitted whole, never truncated. A review receives only already-completed earlier turns; concurrent reviews do not see each other's unfinished work. Settings changes, on/off, branching, compaction, session switches and shutdown clear history. There is no cross-session replay or retained native advisor/tool transcript.


Preferences live under `settings["omp-decision-advisor"]` in the active profile's `omp-plugins.lock.json`; the default layout is `~/.omp/plugins/omp-plugins.lock.json`. Named profiles and initialized XDG layouts use OMP's normal paths. Project plugin overrides retain OMP's normal precedence; the UI warns if they shadow a saved profile value and reloads the effective values.

No custom `DECISION_*` environment variables are read. Old shell exports can be removed. Endpoints and model choices stay in local OMP configuration, not this public repository. Tokens, API keys and passwords are never saved. API-key authentication is not supported by the verified System One contract.

Deployment discovery is read-only and happens only when selected in the UI. A focused loading modal stays visible while Azure is queried; Enter and typed text cannot reach the main editor. Escape cancels the Azure CLI subprocess and returns to preferences; late results do not reopen a picker. It uses Azure CLI's active subscription and account read permissions, and never creates or changes Azure resources. Without discovery access, enter the existing account HTTPS origin and deployment manually. Do not append `/providers/microsoft/v1/systemone` to the endpoint; the client adds it.

Azure CLI mode uses your existing `az login` identity without an extra credential-selection variable. DefaultAzureCredential mode supports Azure SDK's standard managed/workload/environment identity mechanisms. Inference still requires existing data-plane permissions and network access. The extension never grants roles or changes authentication/network policies.

Commands:

- `/decision` — open the on/off/status/settings control menu.
- `/decision on` / `/decision off` — persist the automatic-review state; explicit diagnostics remain available when off.
- `/decision settings` — edit saved provider, reviewer model, tools, instructions, history, triage and timeout preferences.
- `/decision status` — show current configuration and latest stored scores, and perform a live smoke test. It sends one batched request with a matching and mismatching synthetic reply against a supplied arithmetic reference; it never sends conversation history or invokes the escalation reviewer. A wrong classification is a failed smoke; network/authentication/malformed-response failures are errors, not passes. It works while automatic review is off, is cancellable in the TUI, and incurs one small model request when configured. An unconfigured provider is reported without making a request. This is a functional smoke, not general quality calibration.
- `/decision review` — show/reuse the automatically requested review, or explicitly review a captured passing turn. It does not issue a duplicate review for the same captured turn.
- `/decision verbose` — toggle saved verbose output; `/decision verbose on` / `/decision verbose off` set it explicitly. This applies immediately and clears old-configuration review state, like other settings changes.

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

With verbose off, passing scores are retained in ordinary OMP session entries but produce no automatic output. A failure displays its scores and requests the escalation reviewer. Completed reviews append a native advisor message: accepted reviews show **“The advisor was requested but had no findings.”** Findings use OMP's own severity badges and note rails, with evidence and recommendations—not JSON. An uncertain review without findings uses the native uncertain-status notice. Scoring errors remain **not evaluated**, and reviewer errors never become accepts. Earlier feedback is preserved rather than replaced by a later review.

The escalation reviewer may accept a flagged turn: that means the first-stage flag was not confirmed. Native advisor messages persist findings as advisory context for the primary's next natural request. The extension does not automatically restart the primary, approve an action or change its model. Tools, additional instructions and bounded review summaries are configurable above; native `WATCHDOG.yml` grants, native advisor history, severity-based steering and native advisor recovery are not inherited. The host patch changes message delivery/presentation, not these policies.

An escalation review requires a separate model invocation because it depends on Decision-1's result and uses a different model. Investigation can require further reviewer model calls after tool results. Passing turns have no escalation calls. The current endpoint allowance reported by the owner is **17 requests/second**; count one Decision-1 request per primary turn, not one per criterion. The extension does not alter capacity or quota.

Both scoring and automatic review are bounded below OMP's 30-second hook budget. Separate finalization gates wait for outstanding scoring and reviewer work. Feedback is appended directly to the scrolling transcript at a safe host boundary using `pi.sendMessage(..., { triggerTurn: false })`, without a pinned widget or next-user-turn transfer hook. Native advisor cards show the first three notes when collapsed; **Ctrl+O** expands them using OMP's existing handling. Generic score/progress/error feedback is excluded from provider/judge context; native finding messages supply advisory context without a duplicate hidden advice message.

Verbose mode preserves the normal scoring/review output plus complete sanitized report/result JSON and reviewer-request progress. It also prints passing score reports, without requesting a reviewer for them. In ordinary print mode, accepted reviews are a plain note and findings are plain structured notes; full reviewer JSON is shown only when verbose. Protocol JSON mode retains structured records for machine consumers regardless of presentation preference. Provider tokens, raw upstream errors and conversation evidence are not printed by verbose mode. Full validated scores/results remain in OMP custom session entries.

Review is post-turn and cannot prevent a tool action that already happened. Evidence includes standing instructions, the latest user request, up to eight recent messages, and the current assistant/tool results. OMP's Qwen tokenizer limits evidence to 28000 tokens, up from 24000, leaving 4768 tokens within the model's 32768-token context for rubrics, answer choices and service framing. Internal service formatting is not exposed, so near-limit Azure acceptance is not guaranteed. The standalone client uses a stricter 28000-byte budget without a host tokenizer. Oversized evidence is rejected rather than silently truncated. Attachments are explicitly unavailable to this text-only judge.

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

Integration verification exercised the native `/decision` controls/preferences in an isolated OMP profile. With live Azure Decision-1 scoring and deterministic local chat fixtures, passing turns stayed silent and failed turns invoked the escalation reviewer. The reviewer executed a real file read, received only selected tools and saved instructions, used completed earlier summaries and cleared them on settings reset. Two user prompts produced exactly two primary model calls; feedback did not start hidden turns.

Additional native TUI verification covered the four-action control menu, a focused loading state during delayed deployment discovery, ignored main-editor input while loading, Escape cancellation with subprocess termination, and safe manual-entry fallback on query errors. Live `/decision status` smoke passed against Azure while automatic review was off; off/on transitions survived restarts and restored automatic review only when enabled.

Expanded-reviewer TUI verification covered declined elevated grants, picker cancellation, explicit elevated confirmation at Save, multiline instructions and history tuning. A user-granted `write` changed only a temporary smoke file; inherited `always-ask` approval prevented that mutation in a headless run. Fresh read results honored configured secret redaction. An unavailable `recall` grant failed before the reviewer model was called, and explicit empty grants exposed no tools.

Native cutover verification exercised the patched fork in an isolated profile with deterministic local chat providers. Two prompts produced exactly two primary calls and two reviewer calls, and two persisted native advisor messages. Actual TUI smokes covered first-three-note collapse, Ctrl+O expansion to the fourth finding, accepted-review notices and findings in the next primary request. Print mode showed the uncertain-review notice and verbose accepted-review JSON. This did not switch the installed host or mutate Azure deployments.

## Sources

- [Microsoft model specification](https://ai.azure.com/catalog/models/Microsoft-Decision-1)
- [Foundry System One example and pricing](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-microsoft-decision-1-in-microsoft-foundry-for-decision-and-classific/4562742)
- [Azure deployment CLI](https://learn.microsoft.com/en-us/cli/azure/cognitiveservices/account/deployment)
- [OMP extensions](https://github.com/can1357/oh-my-pi/blob/v18.8.7/docs/extensions.md)

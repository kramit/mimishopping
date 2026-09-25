# MimiShopping optimisation TODO

Review date: 24 September 2026

Repository: `/Users/mike/Documents/GitHub/mimishopping`

Production: https://mimishop.michaelwhitehouse.net

This is a handoff checklist for future work. No optimisation work has been implemented as part of saving this file. Recheck the dated findings before acting.

## Prioritised work

- [ ] **High — Separate publication success from cleanup failures.** In `worker/src/catalog-worker.js`, keep successfully published items published if private-file deletion fails. Retry cleanup independently. Test cleanup failure and recovery without repeating publication.

- [ ] **High — Control anonymous upload costs.** Add server-enforced intake quotas and an emergency intake-disable setting. Agree quota values and whether to introduce CAPTCHA with the user before implementation. Enforce limits before expensive processing; test rejection and recovery.

- [ ] **High — Improve deployment automation.** Run API and worker tests under Node 22 before deployment. Automate worker deployment when its code changes. Deploy only intended public website assets; exclude worker source, infrastructure, scripts and operational documentation. Verify excluded paths return 404 and required assets remain accessible. Add least-privilege OIDC authentication for worker deployment, deployment concurrency controls, release identification and retained rollback artifacts. Document and test release and rollback procedures; check both the custom and default hostnames, public reads, anonymous write denial on editor-only endpoints and worker registration after releases. The reviewed workflow deploys the repository root and does not automate worker deployment. [Azure Functions deployment guidance](https://learn.microsoft.com/azure/azure-functions/functions-how-to-github-actions)

- [ ] **Medium — Add operational monitoring.** Configure Application Insights with bounded retention/sampling. Monitor failures, processing duration, queue backlog, poison messages and cleanup failures. Agree alert recipient and telemetry budget before provisioning. The live worker had no Application Insights connection setting, while a MimiShopping-named failure-anomaly rule existed. Verify that rule's target and recipients before retaining or removing it. Test telemetry ingestion and alert delivery, and record recovery instructions for each actionable alert.

- [ ] **Medium — Make processing resumable.** Persist successful AI analysis before downstream image uploads. Retry failed stages without repeating successful analysis. Add an explicit Foundry request timeout. Preserve attempt-ID checks and discard handling; test storage failures after analysis and stale retries.

- [ ] **Medium — Reduce catalog reads.** Add conditional caching for public catalog responses and individual-item lookup for publication polling. Ensure publication, hiding and attribution changes invalidate cached results. Preserve `no-store` for private draft responses. Introduce a published index or snapshot when collection growth warrants it.

- [ ] **Medium — Improve browser search/loading.** Cache searchable text per image, invalidate it after relevant edits, reuse matching IDs in product view and debounce search input. Defer catalog loading while preserving script execution order. Verify equivalent search/filter results and measure before/after performance.

- [ ] **Small — Fix pagination after result changes.** Clamp the current page before slicing results. Test tag edits that shrink the last page and the zero-results case.

## Azure deployment additions

- [ ] **High — Complete infrastructure reproducibility.** The reviewed Bicep template assumes an existing Static Web App and does not declare the original `gallery` container. Document and automate the missing bootstrap steps, DNS dependencies, permissions and configuration. Completion requires validating deployment into a separate test environment without modifying production; provisioning still requires separate authorization.

- [ ] **High — Establish backup and recovery procedures.** Live gallery storage had blob soft delete disabled, no enabled versioning reported and no lifecycle policy. Define recovery for original photos, community contributions and Table data; test restoration and record the results. Account for private-draft deletion promises before enabling account-wide retention. Estimate storage costs first. [Azure data protection guidance](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview)

- [ ] **High — Operationalise credential rotation.** The managed API uses server-side SAS credentials. Inventory them by purpose, permissions, owner and expiry without recording token values. Add expiry reminders, rotation instructions, validation and recovery steps. Preserve shared-key support while existing service SAS credentials depend on it. Completion requires a verified rotation procedure that preserves required reads/writes and does not expose credentials.

- [ ] **Medium — Measure Azure costs and capacity before resizing.** Retain Static Web Apps Free, Hot/LRS storage and the current worker configuration initially. Measure worker memory, processing latency, queue age, Blob traffic and AI usage. Record cost attribution and alternatives if the subscription still rejects budgets. Completion requires a dated baseline and evidence-backed recommendations, not an assumed saving or automatic tier change.

Release/rollback and monitoring reconciliation are included in the existing deployment and monitoring tasks above to avoid duplicate work.

## README and technical documentation additions

- [x] **High — Create a comprehensive README.** Expanded the overview to cover purpose, capabilities, architecture, repository layout, prerequisites, local setup, configuration names, test commands and links to deployment, developer and user documentation. Verified links and Node 22 test commands; no secret values included.

- [x] **High — Document how the application works.** Added `docs/architecture.md` with browser → API → private storage → queue → worker → Foundry → publication flows, diagrams, states, grouping, search, tags, authentication, draft credentials, retention and image processing. Checked flows against the source.

- [x] **High — Create a function reference.** Added `docs/functions.md` with linked frontend, API, worker and script functions. Verified all named declarations found by the inventory check appear in the reference; the package tests passed under Node 22.

- [x] **Medium — Correct documentation drift.** Updated `DEPLOYMENT.md` and the new guides to describe draft-token `localStorage` persistence, asynchronous cleanup, current editor operations, deployment prerequisites and live configuration. Checked those claims against current code and read-only Azure settings.

## On-site help addition

- [ ] **High — Create an accessible help page at `/help.html`.** Link it from the header, footer and upload area. Include step-by-step instructions for browsing, filters, product/photo views, research statuses, saving images, camera-roll uploads, reviewing results, public contributor names, publishing, retrying and discarding drafts. Include editor-only instructions for shared tags, attribution and hiding contributions. Explain browser-local data, supported formats/limits, privacy and AI uncertainty using verified current behaviour. Completion requires working navigation links plus mobile, keyboard and novice-user walkthroughs; instructions must match actual labels and outcomes.

## Verified baseline

These observations were verified during the review on 24 September 2026; they are not a guarantee of current deployment state.

- Production application scripts and catalog data matched local files.
- 741 original photos and two public community contributions.
- Catalog: 3.48 MB uncompressed; approximately 542 KB served with Brotli.
- WebP renditions, lazy loading, 48-item pagination and immutable image caching already exist.
- Static Web Apps Free; running Flex Consumption worker, 2 GB memory, maximum four instances.
- Latest GitHub deployment succeeded.
- API tests: 20 passed. Worker tests: 10 passed. Local runtime was Node 26; repeat under production's Node 22.
- Worker had no Application Insights connection setting.
- Production served deployment documentation, worker source and Bicep files.
- Follow-up Azure review confirmed HTTPS-only gallery storage, TLS 1.2, Hot/LRS storage and a running Node 22 worker with system-assigned managed identity.
- Gallery storage had blob soft delete disabled, no enabled versioning reported and no lifecycle management policy.
- A MimiShopping-named failure-anomaly rule existed, but its target and recipients were not verified.
- The infrastructure template treated the Static Web App as existing and omitted the original `gallery` container.

## TODO update acceptance criteria

- Preserve the original eight tasks and handoff constraints; expand overlapping deployment and monitoring tasks instead of duplicating them.
- Keep priorities, dated evidence and completion checks with the new work.
- Documentation completion requires checking commands, links and function coverage against source.
- Help-page completion requires mobile, keyboard and novice-user walkthroughs.
- Saving this checklist does not include application changes, infrastructure changes, paid services or deployment.

## Handoff constraints

- Recheck repository and live state before implementation; this is a dated review.
- Preserve unrelated workspace changes. Inspect `git status` for the current inventory before staging; the logo and animation work may have been completed separately.
- Preserve private drafts, editor authorization, attempt-ID checks, image hash verification and original photos.
- Keep the current hosting architecture unless measured evidence justifies changing it.
- No live upload, mobile performance benchmark or billing analysis was performed.
- Implement and verify focused changes separately. This checklist alone does not authorize deployment or new paid services; check the current user request for authorization.
- The OneDrive `MimiShopping` workspace contains local source catalog material; the production application repository is the GitHub directory identified above.

## Verification commands

Use Node 22 and the locked dependencies in each package:

```sh
cd /Users/mike/Documents/GitHub/mimishopping/api
npm ci
npm test

cd /Users/mike/Documents/GitHub/mimishopping/worker
npm ci
npm test
```

Run additional targeted tests for each change, inspect the final diff, and record completion evidence beside the relevant checkbox. Live deployment checks apply only after deployment is separately authorized.

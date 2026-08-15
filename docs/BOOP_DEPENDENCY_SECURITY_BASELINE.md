# Boop dependency security baseline

Date: 2026-08-15

Baseline lockfile: `31979130b1371acd9defbea115279a06c63c1fb4`

Command: `npm ci`, then `npm audit --json`

Policy: documentation only; no `npm audit fix`, override or dependency upgrade was applied.

## Result

`npm audit` reports 15 vulnerable packages: 1 low, 2 moderate, 11 high and 1 critical. The installed graph contains 809 package instances in npm's metadata view.

| Package/chain | Severity | Reachability in intended service | Classification |
| --- | --- | --- | --- |
| `tar` via `electron-builder` / `node-gyp` | critical | build/desktop packaging only; Electron is excluded from the Agent Worker production target | dev/build-only, still blocks a clean supply-chain baseline |
| `@huggingface/transformers` -> `onnxruntime-node` / `adm-zip` / `sharp` | high | memory embeddings/consolidation path; Memory is feature-flagged off in Foundation | optional runtime, production-reachable if Memory is enabled |
| `hono` and `@hono/node-server` via MCP SDK | moderate | MCP/Composio path, excluded from initial Hostmate production runtime | optional runtime |
| `body-parser` via Express | low | server runtime | production-reachable, bounded by existing request limits but should be upgraded |
| `fast-uri` via AJV/MCP and app builder | high | schema validation/MCP depending on bundle | potentially production-reachable |
| `ip-address` via MCP SDK's Express rate limiter | high | MCP server path only | optional runtime |
| `postcss` -> `nanoid` via Vite | high | frontend build pipeline | build-only |
| `brace-expansion`, `js-yaml`, part of `undici` | high | Electron/app-builder toolchain | dev/build-only |
| second `undici` chain via Electron download tooling | high | Electron installation/build | dev/build-only |

The critical issue is not currently on the planned server request path, but it remains unacceptable for a production fork baseline because CI/build hosts process package and archive input. The highest conditional runtime concern is the local embedding chain; it must remain disabled until isolated or remediated.

## Recommended remediation plan

Use a dedicated security PR after Foundation, with lockfile review and rollback, in this order:

1. Split a production Agent Worker package/bundle that omits Electron, Apple/browser, desktop packaging and local embedding dependencies.
2. Upgrade the direct owners (`electron-builder`, MCP SDK, Express and Vite toolchain) one at a time with characterization tests; do not use a blanket audit fix.
3. Replace or isolate `@huggingface/transformers` local embeddings behind an optional worker image and require a patched `onnxruntime-node`/archive/image chain before enabling Memory.
4. Add CI gates for production dependency audit, SBOM generation and allowlist expiry; report build-only and production-reachable findings separately.
5. Run image/archive fuzz and resource-limit tests before accepting local embedding/image processing.

## Acceptance status

Accepted only as a documented inherited baseline for pre-production Foundation. It is a production gate, not a risk acceptance for rollout.

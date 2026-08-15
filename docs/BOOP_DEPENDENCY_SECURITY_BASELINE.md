# Boop dependency security baseline

Date: 2026-08-15. Audited baseline/fork lockfile: `31979130b1371acd9defbea115279a06c63c1fb4` plus the approved Hostmate extension commits. Commands: `npm ci`, `npm audit --json`, and `npm audit --omit=dev --json`. No upgrade, override, or `npm audit fix` was applied.

The full graph has 809 package instances and 15 findings: 1 low, 2 moderate, 11 high, 1 critical. Omitting dev dependencies leaves 11 findings: 1 low, 2 moderate, 8 high, 0 critical. “Prod” below means installed by the root production graph; “reachable” means imported by the four-capability managed request path.

| Package | Severity | Direct | Graph / use | Reachable by current runtime | Fix |
| --- | --- | --- | --- | --- | --- |
| `tar` | critical | transitive | `electron-builder`/`node-gyp`; dev packaging | no | available; controlled build-tool upgrade, potentially compatibility-affecting |
| `@huggingface/transformers` | high | direct | optional local Memory/embeddings | no; Memory off and not imported by managed runtime | no current audit fix |
| `onnxruntime-node` | high | transitive | transformers native runtime | no | no current audit fix |
| `adm-zip` | high | transitive | onnx archive loading | no | no current audit fix through owner |
| `sharp` | high | transitive in this chain | transformers image path | no | no current audit fix through owner |
| `ip-address` | high | transitive | MCP SDK rate-limit path | no; MCP excluded | available, owner upgrade |
| `fast-uri` | high | transitive | AJV/MCP and builder graph | no in current four-cap path | available, owner upgrade |
| `postcss` | high | transitive | Vite/Tailwind build | no at runtime | available, build-tool upgrade |
| `nanoid` | high | transitive | Vite/PostCSS build | no at runtime | available, build-tool upgrade |
| `brace-expansion` | high | transitive | Electron/builder CLI graph | no | available, owner upgrade |
| `js-yaml` | high | transitive | Electron/builder configuration | no | available, owner upgrade |
| `undici` | high | transitive | Electron download/builder graph | no | available, owner upgrade |
| `hono` | moderate | transitive | MCP SDK | no; MCP excluded | available, owner upgrade |
| `@hono/node-server` | moderate | transitive | MCP SDK | no; MCP excluded | available, owner upgrade |
| `body-parser` | low | transitive | Express 5 request parsing | yes; JSON is capped at 16 KiB | available, non-breaking transitive update expected but must be tested |

No critical/high finding is exploitable through `POST /v1/turn` as currently assembled: it imports Express, Convex, the Hostmate HTTP adapters, OpenRouter and the CRM vertical slice, but not Electron, MCP, local embeddings, image/archive processing, Vite or desktop tooling. Therefore this stabilization does not change the lockfile.

Before production, build a slim managed-runtime package/image whose production install excludes Electron, MCP, Vite and local embeddings; audit that artifact rather than the monolithic desktop graph. Then remediate owner packages one at a time in a dedicated security PR with unit/contract/runtime/build checks and upstream-diff review. Memory must remain disabled until its native/archive/image chain has a patched solution. Add an SBOM and expiring allowlist gate. The current monolithic graph is accepted for integration testing only, not as production risk acceptance.

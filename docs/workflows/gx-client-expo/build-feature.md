# Build a Feature — gx-client-expo

How Friday drives a new feature/screen/component in the Expo app. Friday plans and dispatches; the dispatched process scaffolds and codes. See [README](README.md) for the dispatch quick-reference.

## 0. Platform check (first, always for platform-sensitive work)

Before any code, instruct the dispatched process to run the **`platform-check`** skill if the feature touches platform-sensitive APIs (camera, push/CleverTap, calendar, secure-store, sockets, file system, deep links). It surfaces iOS/Android divergence and config-plugin/native needs up front — which also tells you later whether this can ship via OTA or needs a full EAS build (see [release-ota.md](release-ota.md)).

## 1. Plan the architecture

For anything beyond a single component, dispatch the **`code-architect`** agent to plan module structure, API services, types, navigation, and data flow. Friday reviews the plan before code starts. Confirm scope with the requester if it's fuzzy.

## 2. Scaffold with the right skill (don't write from scratch)

| Building | Skill | Args |
|---|---|---|
| A whole feature module | `new-feature` | `<feature-name> [description]` |
| A screen + its route | `new-screen` | `<module> <screen> [--tab \| --stack \| --modal]` |
| A reusable / feature component | `new-component` | `<name> [--ui \| --common \| --module <name>]` |
| An API endpoint or service | `new-api` | `<service> <method> [endpoint-path]` |
| Implementing from a Figma/mockup | `design-match` | `[figma-url or description]` |

## 3. Implement to convention

The dispatched process must follow the repo's critical rules (full list in `gx-client-expo/CLAUDE.md`). The ones that trip people up:

- **API calls only through `lib/api/` services** — never axios/fetch from a component. One singleton service class per domain.
- **`@/` path aliases, no relative paths, no barrel imports** — import from the source file.
- **`I`/`T`/`E` prefixes** for interfaces/types/enums; destructure props in the signature.
- **No arbitrary pixel values** — Tailwind classes auto-scale from a 390px baseline; use `scaleSize()` for icon sizes.
- **Theme variables only** (`bg-background`, `text-foreground`, …) — dark mode only, no hardcoded colors.
- **Route files in `app/` stay thin** — extract params, handle the auth gate, delegate to a `modules/<feature>/screen/` component. Business logic lives in the module.
- **Modules are self-contained** in `modules/<feature>/` (`screen/`, `components/`, `hooks/`, `context/`, `api/`, `db/` as needed).

## 4. Review the UI

After any UI change, run the **`ui-review`** skill (or dispatch the **`ui-reviewer`** agent) for design-system compliance, responsive scaling, and platform compat. Run **`token-auditor`** if hardcoded colors / arbitrary spacing are a risk.

## 5. Clean up

Dispatch the **`clean-code`** agent for a post-task sweep: naming, function size, dead code, duplication.

## 6. Gate, then ship

- [ ] `pnpm lint` passes
- [ ] `npx tsc --noEmit` passes
- [ ] Feature works end-to-end (manual check; screenshots in the thread if UI)
- [ ] PR raised — see [pr-review.md](pr-review.md)
- [ ] Shipped — JS-only → [release-ota.md](release-ota.md); native changes → full EAS build (`docs/EAS_DEPLOYMENT_GUIDE.md` in the repo)

## Forbidden

- Rewriting whole files — make targeted edits.
- Writing components/screens from scratch when a `new-*` skill exists.
- Skipping `platform-check` on platform-sensitive work, or `ui-review` after UI changes.
- Arbitrary px, hardcoded colors, relative imports, barrel imports, axios in components.

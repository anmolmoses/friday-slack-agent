# Release via OTA — gx-client-expo

Ship **JavaScript-only** changes to users without an app-store submission, using EAS Over-The-Air updates.

## Rule zero: use the `ota` skill, never raw `eas update`

The repo's **`ota`** skill wraps the deploy with safety checks (lint, typecheck, env match, git state). It is `disable-model-invocation: true` — it will **not** auto-trigger, so Friday/the agent must invoke it **explicitly**. Never hand-run `eas update`.

```
ota [message] [--branch preview|production] [--platform ios|android|all]
```

## Can this even ship via OTA?

OTA pushes JS/asset changes only. It **cannot** ship:

- New native modules or native dependencies
- `app.json` / config-plugin / native permission changes
- Expo SDK upgrades
- Anything `platform-check` flagged as requiring native code

If any of those changed, it needs a full **EAS build + store submission** — see `docs/EAS_DEPLOYMENT_GUIDE.md` in the repo. When unsure, default to a build.

## Pre-flight (the `ota` skill enforces, but verify)

- [ ] `pnpm lint` clean
- [ ] `npx tsc --noEmit` clean
- [ ] Correct environment / API URLs for the target branch (`lib/config/app-config.ts`)
- [ ] Git state is clean and on the intended branch
- [ ] Change is genuinely JS-only (see above)

## Branch & platform

- **`preview`** — staging / internal testing channel. Default for verification.
- **`production`** — live users. Requires explicit confirmation; this is user-facing and hard to reverse, so confirm with the requester before pushing to production.
- **`--platform`** — `all` unless the change is platform-specific.

## After the push

- Confirm with `eas update:list` that the update published to the intended branch.
- Post the update group / link back in the Slack thread.
- Note that clients pick up the update on next cold start (or per the app's update policy).

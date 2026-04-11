Review PR #2947 on GrowthX-Club/gx-backend following the 8-phase review protocol in /Users/anmol/.openclaw/workspace-friday/memory/gx-backend-review.md

The PR: https://github.com/GrowthX-Club/gx-backend/pull/2947
Title: feat: extend user segment lookback to 6 months with city-based attendance tracking and enhance bug report service with mobile app support and metadata

Changes (94 additions, 21 deletions, 2 files):
1. apps/migrations/export_user_segments.ts — extends lookback from 3 months to 6 months, adds city-based attendance tracking via Venue lookup
2. packages/services/bug-report/service.ts — adds mobile app support to bug report service (GrowthXApp UA detection, mobile routes, device metadata)

Execute ALL 8 phases. Post inline comments on specific lines AND a summary comment on the PR via gh api/gh pr comment. Be thorough — this is the only review pass.

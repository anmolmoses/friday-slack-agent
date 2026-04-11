Review PR #2934 (fix/payouts-mismatch-admin) on GrowthX-Club/gx-backend.

The diff aligns admin payout APIs with host/member calculation using payment_id lookup via calculateBreakdown. 9 files changed, +119/-43.

## Your job:

1. Read the full diff: `gh pr diff 2934 -R GrowthX-Club/gx-backend --color=never`
2. Search the codebase for context — trace imports, check related services, verify schemas, read claude.md
3. Get the latest commit SHA: `gh pr view 2934 -R GrowthX-Club/gx-backend --json commits --jq '.commits[-1].oid'`
4. Leave INLINE comments on specific lines where you find issues using:
   `gh api repos/GrowthX-Club/gx-backend/pulls/2934/comments -f body="COMMENT" -f commit_id=COMMIT_SHA -f path=FILE_PATH -F line=LINE_NUMBER -f side=RIGHT`
5. After all inline comments, post a summary comment: `gh pr comment 2934 -R GrowthX-Club/gx-backend --body "SUMMARY"`

## Key areas to review:

- apps/backend/routes/admin/payouts.ts — invoice lookup switched from invoice_id to payment_id, response flattened, snapshot refresh added
- packages/services/host-expense/service.ts — new refreshPayoutSnapshot method, aggregation pipeline changes
- packages/database/crud/invoice.ts — new payment_ids filter
- apps/migrations/refresh_all_payout_snapshots.ts — hardcoded ObjectId, is this production-ready?
- apps/backend/routes/admin/payouts.ts DELETE route — eventId extracted from req.params but check if route definition includes :eventId
- Schema changes in event_payout.ts and invoice.ts

## What to look for:

- Real bugs
- Type safety issues
- Missing error handling
- Race conditions in fire-and-forget calls
- Hardcoded values
- Whether the migration script is reusable or one-off
- Breaking API contract changes (response shape changed)

Be thorough. Leave inline comments on every issue found. Then post a summary.

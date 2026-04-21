# Non-Functional Requirements

## Performance
- Primary owner-facing workspaces should render usable shell content quickly and load critical interactive data without long blank states.
- Expensive reporting and recalculation paths should expose explicit loading and freshness state rather than hiding delayed work.

## Caching and Freshness
- Every major surface must expose freshness intent: live validated state, cached state, or stale fallback.
- Reporting freshness can vary by module, but the expected SLA must be explicit in the target requirements matrix.

## Degraded Mode
- If MFL is unavailable, UPS_V2 should serve the last verified read snapshot with a visible staleness indicator.
- No degraded mode should silently mutate prod state or fake a completed publish.

## Idempotency and Concurrency
- Jobs must be safe to rerun or explicitly marked non-idempotent with a guard.
- Concurrent submissions must not create duplicate publishable units or conflicting verification state.

## Environment Separation
- `74598` remains read-only source.
- `25625` remains writable primary test target.
- No prod write can execute without environment identity, approval reference, and verification evidence.

## Browser and Mobile
- Core owner tasks should be achievable on desktop and mobile without route confusion or hidden state loss.
- Mobile layouts should avoid overloading a single screen with multiple panes when a stepped flow is clearer.

## Accessibility Minimums
- Navigation and major actions should remain keyboard reachable.
- Warning, block, and status messages should be textually explicit and not color-only.

## MFL Shell Constraint
- MFL message-slot routing may exist only as a compatibility shell.
- UPS_V2 information architecture must be task-first, not slot-first.

## Logging and Audit
- Every governed publish or revert action requires durable audit evidence.
- Every closed phase requires a stored markdown phase completion report.

## Security and Secrets
- Separate secrets and deploy targets are mandatory across V1, UPS_V2 prod mirror, UPS_V2 test, and future lab.
- No local absolute path or legacy repo identity may remain in active runtime logic.

## Source-System Validation
- Every governed rule and workflow must be cross-checked against the live MFL source system when a corresponding site setting or export field exists.
- Any mismatch between UPS_V2 governance and live site settings must be logged, classified, and resolved as rule fix, site-setting fix, or intentional override.
- A rule is not fully validated until its source-system alignment status is recorded in the governed alignment register.

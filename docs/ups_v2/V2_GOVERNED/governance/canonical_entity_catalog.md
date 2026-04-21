# Canonical Entity Catalog

| Entity | Purpose |
|---|---|
| `league_context` | Environment-season-league routing and identity anchor |
| `rulebook_section` | Policy source text and interpretation anchor |
| `league_metadata_snapshot` | Immutable league config capture from MFL |
| `franchise_season` | Franchise identity within a season |
| `player` | Cross-season player identity |
| `roster_current_snapshot` | Current factual roster snapshot |
| `roster_weekly_snapshot` | Historical roster snapshot by season and week |
| `transaction_event` | Normalized transaction record anchored to raw evidence |
| `standing_snapshot` | Normalized standings state |
| `contract_submission` | Requested contract action entering the system |
| `contract_event` | Canonical contract state-change event |
| `contract_version` | Versioned contract record derived from events |
| `contract_current` | Serving view of latest active contract state |
| `salary_adjustment` | Delta to contract salary obligation |
| `roster_assignment` | Player location on active, IR, taxi, or reserve |
| `tag` | Tag designation lifecycle |
| `extension` | Extension request and outcome lifecycle |
| `restructure` | Restructure request and outcome lifecycle |
| `mym_action` | Move-your-money action lifecycle |
| `trade` | Parent trade transaction |
| `trade_asset` | Individual asset inside a trade |
| `pick` | Draft pick identity and ownership |
| `event_window` | NFL or UPS calendar window with rule effects |
| `publish_batch` | Grouped publishable units |
| `rule_directive` | Commissioner or governance directive |
| `warning_state` | Non-blocking or blocking system signal |
| `eligibility_state` | Derived action eligibility result |
| `audit_event` | Immutable audit record |

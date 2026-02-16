# Project Review Findings

## Critical
- Embedded API key was present in code defaults and generated artifacts.
  - Action: removed key from script defaults; require explicit environment variable for salary-adjustment feed URL.

## High
- Multiple scripts depended on hardcoded absolute local paths.
  - Action: replaced with portable defaults rooted in project structure and optional environment overrides.
- Production package mixed runtime artifacts and mutable DB files with source.
  - Action: separated runtime directories, removed committed runtime DB/artifacts, added ignore rules.

## Medium
- Folder and file naming did not clearly reflect function or domain boundaries.
  - Action: introduced domain-based structure (`apps`, `pipelines`, `services`, `docs`, `scripts`) and renamed key files.
- Rulebook service path assumptions broke when relocated to nested folders.
  - Action: added path resolution via service-root calculation and env overrides.

## Residual Risks
- External source files and spreadsheets still require manual placement and governance.
- No automated test suite exists yet beyond syntax and path validation checks.

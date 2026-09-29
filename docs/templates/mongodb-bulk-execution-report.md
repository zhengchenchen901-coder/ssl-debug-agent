# MongoDB Bulk Execution Report

Use one report per authorized job. Keep identifiers and results redacted; attach
the `jobId` and `planHash` only in the organization's approved record system.

## Scope

- Instance / environment: `<instance>`
- Database: `<database>`
- Purpose: `<redacted purpose>`
- Job ID: `<jobId>`
- Plan hash: `<SHA-256>`
- Authorized scope and selection rule: `<description>`
- Included collections / fields: `<allowlisted collections and fields>`
- Exclusions and exception counts: `<summary>`
- Storage initialized and reviewed: `<yes/no, change reference>`
- Rollback expiry: `<timestamp>`

## Plan and execution

- Prepared at: `<timestamp>`
- Started at: `<timestamp>`
- Finished at: `<timestamp>`
- Elapsed time: `<duration>`
- Units / operations: `<unit count> / <operation count>`
- Planned / committed / verified batches: `<counts>`
- Configured / effective concurrency: `<counts>`
- Matched / modified / inserted / unchanged: `<counts>`
- Pauses, retries, and recovery actions: `<none or redacted details>`
- Database requests by method: `<grouped reads, bulkWrite, receipt reads/writes>`
- Peak persistent job-log bytes: `<bytes>`
- Verification result and paginated difference count: `<summary>`

## Exceptions and delivery

- Unmatched, ambiguous, duplicate, or conflicting records: `<counts and treatment>`
- Protected-field checks: `<result>`
- Final job status: `<completed / review_required / paused>`
- Read-only verification reference: `<approved location>`
- Operator / review reference: `<reference>`
- User-facing summary: `<redacted outcome>`

Do not report `completed` unless every batch committed and verification finished.
Do not attach complete documents, phone numbers, credentials, URIs, or before
images.

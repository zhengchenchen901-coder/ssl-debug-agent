# MongoDB Bulk Rollback Report

Use one report per rollback attempt. Redact member, phone, credential, connection,
and document details.

## Job and authorization

- Instance / environment: `<instance>`
- Database: `<database>`
- Job ID: `<jobId>`
- Plan hash: `<SHA-256>`
- Rollback confirmation received: `<yes, timestamp>`
- Rollback expiry at start: `<timestamp>`
- Reason: `<redacted reason>`

## Rollback results

- Started / finished: `<timestamps>`
- Elapsed time: `<duration>`
- Committed batches before rollback: `<count>`
- Reversed batches: `<count>`
- Reverse order checked: `<yes>`
- Restored updates / removed inserts: `<counts>`
- Rollback receipt count: `<count>`
- Conflicting batch and protected reason: `<none or redacted summary>`
- Final job status: `<rolled_back / paused / rollback conflict>`
- Read-only verification reference: `<approved location>`

If a conflict stopped rollback, preserve the current state and job logs for
inspection. Do not retry with a changed plan, delete receipts, or force an
overwrite. Report which batches were reversed and which remain committed.

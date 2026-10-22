# Publishing final task deliverables

For a concluded diagnostic, database, service, recovery or configuration task,
publish the final summary and any requested final exports with
`remote_debug_publish_final_result` before returning the final answer. This is
local file publication only; it never grants permission for a remote action.
File browsing/management and intermediate clarification do not create another
deliverable. Follow explicit user instructions about whether/what to save.

- Publish after completing the whole user task and synthesizing its result.
  Do not publish each tool response, query page, poll, resource-task completion,
  draft awaiting approval, checkpoint or running/paused job's intermediate data.
- Use the explicit instance ID, or `null` only for a Manager task. Split a task
  spanning multiple instances into one publication per instance. Assign a stable
  UUID `taskId`; reuse it with exactly the same payload when publication is
  retried. Bind known job/mutation/operation IDs through `references`.
- Set `final: true`. Choose `completed`, `partial`, `failed` or `cancelled`
  according to the final deliverable's actual outcome. Include missing coverage,
  truncation, unresolved operations and verification limits in the final report.
  A final report does not establish that a remote operation has completed.
- Categories are `results`, `reports`, `exports` and `attachments`; create only
  needed files. Use `json` with a JSON value, or `markdown`, `text`, `csv`,
  `jsonl`, `html` with UTF-8 text. For final images/PDFs/other files use
  `format: binary`, `encoding: base64`, canonical base64 content and the original
  download filename (including extension) as `name`. Binary files preserve their
  bytes; generate them from already sanitized final data. Names have no directories.
  No raw credentials, context capabilities, business reference maps, preimages
  or rollback contents. Preserve opaque business references without resolving
  or reconstructing their values.
- Publication failure must be reported separately from the business outcome.
  Never rerun a remote operation to repair a local file error. A conflicting
  publication cannot overwrite existing files; a corrected deliverable uses a
  new task ID and identifies the previous result in its report.
- Use `remote_debug_list_final_results`, `remote_debug_get_final_result` and
  `remote_debug_read_final_artifact` to retrieve saved results. The authenticated
  Dashboard provides complete downloads and manual deletion. Results persist
  independently of the runtime task list; deleting them does not clean remote
  journals or protected privacy storage.

If the tool or Manager is unavailable, report that final files could not be
published; do not invent a saved path or write intermediate fallback files.

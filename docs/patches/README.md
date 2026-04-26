# Patches — provenance for changes outside this repo

This directory holds unified-diff snapshots of changes made to **sibling
codebases that are not git repos** but that affect entient-spend's
contracts. The patches are not auto-applied. Their purpose is provenance:
preserve the change so the work survives if the sibling directory is
moved, replaced, or never gets versioned.

## Conventions

- One file per logical change.
- Filename: `<sibling-repo>-<file>-<topic>.patch`.
- Unified diff format (`diff -u`), generated against the file as it
  existed before the change. Line endings should match the target file
  (CRLF for Windows-edited extension files).
- Apply from the target directory:
  `patch -p1 < /path/to/<patch>` (after dry-run with `--dry-run`).

## Index

| Patch | Target file | Summary |
|---|---|---|
| `entient-spend-extension-popup-schema.patch` | `entient-spend-extension/popup.js` | Adds explicit `schema: 'entient-spend.export.v1'` field to the export payload + inline contract documentation. Distinguishes export schema version from extension manifest version. Backward-compat: keeps the legacy `version` field alongside new `extension_version`. Reconcile in this repo (`audit.js`) already consumes the unchanged `anthropic.invoices` / `anthropic.dailyUsage` shapes — verified end-to-end by running `node audit.js reconcile <simulated-export.json>` against a payload built by replaying the popup.js export pipeline. |

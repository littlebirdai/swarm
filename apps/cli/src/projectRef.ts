// The project matcher lives in @codecast/projects/projectRef so the server
// resolves a `--project` ref inside a write workspace (signals, goals) by the
// same rule every CLI `--project` flag uses.
export * from "@codecast/projects/projectRef";

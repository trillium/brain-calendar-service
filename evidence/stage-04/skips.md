# S4 skip ledger (R13)

skip: The transport side of the push and pull paths is NOT implemented here. S4 proves change detection; the provider write path is S6 and the orchestration is S7. What exists is the detection half plus a fixture replay that exercises resolution through it.
skip: Two databases were not wired up. The two-cursor shape is stored and asserted in the schema (S1) and the per-(source database, calendar) row is used by the cursor, but the change-detection test runs against this project's own store only. Cross-database detection against the Beads store is S7's job, with a human present, because it touches the bd-owned database.
skip: dolt_history_<table> is not queried directly. DOLT_DIFF(from, 'HEAD', table) is the table-function form and it answers the same question without the commit_hash filter that dolt_commit_diff_<table> refuses to run without; both routes are recorded here so the choice is visible rather than silent.
skip: No conflict quarantine was written from this stage. Nothing here can produce an undecidable pair; that is S7.

// The schema this service claims to have, in one place.
//
// This is the single source of truth for both db:verify (which asserts the live
// store matches it) and schema.test.ts (which round-trips data through it). A
// table added here without a migration fails db:verify; a migration applied
// without a table here also fails it. That is the point: the claim and the store
// cannot drift apart quietly.

export const TABLES = {
  calendar_calendar: {
    columns: [
      "id",
      "provider",
      "remote_calendar_id",
      "display_name",
      "capabilities",
      "created_at",
      "updated_at",
    ],
    indexes: ["PRIMARY", "uq_calendar_provider_remote"],
  },
  calendar_binding: {
    columns: [
      "id",
      "bead_id",
      "calendar_id",
      "external_uid",
      "external_sequence",
      "last_synced_commit_hash",
      "last_synced_etag",
      "last_synced_dtstamp",
      "ownership_token",
      "created_at",
      "updated_at",
    ],
    indexes: [
      "PRIMARY",
      "uq_binding_bead_calendar",
      "uq_binding_external",
      "idx_binding_commit_hash",
    ],
  },
  calendar_exception: {
    columns: [
      "id",
      "bead_id",
      "recurrence_id_utc",
      "external_uid",
      "patch_json",
      "created_at",
      "updated_at",
    ],
    indexes: ["PRIMARY", "uq_exception_occurrence"],
  },
  calendar_sync_cursor: {
    columns: [
      "id",
      "source_database",
      "calendar_id",
      "last_synced_commit_hash",
      "last_round_at",
      "created_at",
      "updated_at",
    ],
    indexes: ["PRIMARY", "uq_cursor_source_calendar"],
  },
  calendar_conflict: {
    columns: [
      "id",
      "calendar_id",
      "bead_id",
      "external_uid",
      "reason",
      "local_payload",
      "remote_payload",
      "resolved",
      "decision_id",
      "created_at",
      "updated_at",
    ],
    indexes: ["PRIMARY", "idx_conflict_unresolved"],
  },
  calendar_period: {
    columns: [
      "id",
      "grain",
      "period_start_utc",
      "period_end_utc",
      "linked_bead_id",
      "attributes_json",
      "created_at",
      "updated_at",
    ],
    indexes: ["PRIMARY", "uq_period_grain_start", "idx_period_linked_bead"],
  },
};

export const TABLE_NAMES = Object.keys(TABLES);

/** Columns the plan requires that a looser reading would drop. */
export const LOAD_BEARING_COLUMNS = {
  // "two databases, two cursors": a cursor is keyed by the database that
  // PRODUCED its commit hash, not by calendar alone.
  calendar_sync_cursor: ["source_database", "last_synced_commit_hash"],
  // An unowned DELETE must be unrepresentable; that starts with a nullable
  // ownership token that is absent for anything the service did not create.
  calendar_binding: ["ownership_token", "bead_id", "calendar_id"],
  // Quarantine with no automatic exit.
  calendar_conflict: ["resolved", "decision_id", "reason"],
};

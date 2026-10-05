-- Migration 0001: calendar service schema
--
-- Reserved by task-uzrc2 at 2026-10-05 (scripts/next-migration.sh --reserve).
--
-- Per decision-4wh these tables live in their OWN Dolt store. The bd-owned
-- schema is never modified; the link to the planning layer is bead_id, which is
-- an opaque identifier, not a foreign key into another database's tables.
--
-- Per the plan, calendar_sync_cursor holds one row per (source database,
-- calendar) pair rather than one cursor per calendar. A Dolt commit hash is only
-- meaningful inside the database that produced it, so change detection against
-- the Beads database needs a Beads-database cursor even though the cursor row
-- itself lives here. This is the concrete form of "two databases, two cursors"
-- and it is the easiest thing in this schema to get wrong.

CREATE TABLE calendar_calendar (
  id              BIGINT       NOT NULL AUTO_INCREMENT,
  provider        VARCHAR(32)  NOT NULL,
  remote_calendar_id VARCHAR(512) NOT NULL,
  display_name    VARCHAR(255) NOT NULL,
  -- JSON object; keys are capability names, values are booleans.
  capabilities    JSON         NOT NULL,
  created_at      DATETIME     NOT NULL,
  updated_at      DATETIME     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_calendar_provider_remote (provider, remote_calendar_id(255))
) ENGINE=InnoDB;

CREATE TABLE calendar_binding (
  id                   BIGINT      NOT NULL AUTO_INCREMENT,
  bead_id              VARCHAR(64) NOT NULL,
  calendar_id          BIGINT      NOT NULL,
  external_uid         VARCHAR(512) NOT NULL,
  external_sequence    INT         NOT NULL DEFAULT 0,
  -- null until the first successful sync of this binding
  last_synced_commit_hash CHAR(64)  NULL,
  last_synced_etag     VARCHAR(255) NULL,
  last_synced_dtstamp  DATETIME    NULL,
  -- Ownership token minted at create time on the EXTERNAL copy. A DELETE
  -- requires a matching token; without one the delete does not typecheck
  -- (plan binding rule 10). A binding with a null token is a binding the
  -- service has not created, and therefore must never delete.
  ownership_token      VARCHAR(128) NULL,
  created_at           DATETIME    NOT NULL,
  updated_at           DATETIME    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_binding_bead_calendar (bead_id, calendar_id),
  UNIQUE KEY uq_binding_external (calendar_id, external_uid(255)),
  KEY idx_binding_commit_hash (last_synced_commit_hash)
) ENGINE=InnoDB;

CREATE TABLE calendar_exception (
  id               BIGINT       NOT NULL AUTO_INCREMENT,
  bead_id          VARCHAR(64)  NOT NULL,
  recurrence_id_utc DATETIME    NOT NULL,
  external_uid     VARCHAR(512) NOT NULL,
  -- JSON object; validated with Zod at the boundary before it is ever written.
  patch_json       JSON         NOT NULL,
  created_at       DATETIME     NOT NULL,
  updated_at       DATETIME     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_exception_occurrence (bead_id, recurrence_id_utc)
) ENGINE=InnoDB;

CREATE TABLE calendar_sync_cursor (
  id             BIGINT       NOT NULL AUTO_INCREMENT,
  -- The database that PRODUCED last_synced_commit_hash. Not always this one:
  -- the Beads database is a different database with its own history.
  source_database VARCHAR(255) NOT NULL,
  calendar_id     BIGINT       NOT NULL,
  -- null forces a full resync rather than a silent empty diff (binding rule 8).
  last_synced_commit_hash CHAR(64) NULL,
  last_round_at   DATETIME     NULL,
  created_at      DATETIME     NOT NULL,
  updated_at      DATETIME     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cursor_source_calendar (source_database, calendar_id)
) ENGINE=InnoDB;

-- Undecidable edits have nowhere honest to go, so they go here. This table is
-- the ONLY sink and it has no automatic exit path: nothing promotes a row out
-- of it. Resolution is one of the four human-pausing actions (plan 7.0 T8).
CREATE TABLE calendar_conflict (
  id                BIGINT       NOT NULL AUTO_INCREMENT,
  calendar_id       BIGINT       NOT NULL,
  bead_id           VARCHAR(64)  NULL,
  external_uid      VARCHAR(512) NULL,
  reason            VARCHAR(64)  NOT NULL,
  local_payload     JSON         NULL,
  remote_payload    JSON         NULL,
  -- 0 until a human rules on it. Never set by the service itself.
  resolved          TINYINT(1)   NOT NULL DEFAULT 0,
  -- set when a human rules on it, pointing at the decision record
  decision_id       VARCHAR(64)  NULL,
  created_at        DATETIME     NOT NULL,
  updated_at        DATETIME     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_conflict_unresolved (resolved, created_at)
) ENGINE=InnoDB;

-- Day, week and month as durable, agent-manageable primitives rather than a
-- derived view. linked_bead_id points at the Beads record this period summarises.
CREATE TABLE calendar_period (
  id              BIGINT      NOT NULL AUTO_INCREMENT,
  -- 'day' | 'week' | 'month'. The grain is part of the identity, because a day
  -- and the month containing it are different records, not the same row.
  grain           ENUM('day','week','month') NOT NULL,
  period_start_utc DATETIME   NOT NULL,
  period_end_utc   DATETIME   NOT NULL,
  linked_bead_id  VARCHAR(64) NULL,
  -- JSON object; validated with Zod at the boundary.
  attributes_json JSON        NOT NULL,
  created_at      DATETIME    NOT NULL,
  updated_at      DATETIME    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_period_grain_start (grain, period_start_utc),
  KEY idx_period_linked_bead (linked_bead_id)
) ENGINE=InnoDB;
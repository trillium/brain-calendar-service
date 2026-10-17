// Outcomes of applying a plan. Every plan entry ends in exactly one of these;
// nothing is dropped and nothing is a bare caught error (binding rule 9).

export type ApplyOutcome =
  | { readonly kind: "applied"; readonly key: string; readonly op: string; readonly uid: string }
  /** Benign and expected: nothing to do, and the reason says why. */
  | { readonly kind: "skipped"; readonly key: string; readonly reason: string }
  /** Policy or the human gate stopped it. Holds the cursor back so it is re-planned. */
  | { readonly kind: "refused"; readonly key: string; readonly reason: string }
  /** An error. Holds the cursor back; a re-run is safe because every write is idempotent. */
  | { readonly kind: "failed"; readonly key: string; readonly error: string };

export interface ApplyResult {
  readonly outcomes: readonly ApplyOutcome[];
  /** The Dolt commit the local writes landed in, or null if there were none. */
  readonly committedHash: string | null;
  /** Set only when every outcome was applied or skipped. */
  readonly cursorAdvancedTo: string | null;
}

// The write path is deny-by-default.
//
// Binding rule 10 is rung 1: enforced by structure, not by a check. An
// out-of-policy write does not merely fail at runtime - it cannot be expressed,
// because the transport write path takes a SyncPolicy and the permitted set is
// not optional. That is the difference between a rule an agent might forget to
// read and a rule it cannot write code around.
//
// The ownership token is the same idea applied to deletion: a DELETE requires a
// token minted at create time and persisted in calendar_binding. A binding with
// no token is an event this service did not create, and deleting it is not
// representable.

export interface SyncPolicy {
  readonly provider: string;
  /** Exactly the (calendarId, operation) pairs this run may touch. */
  readonly permitted: ReadonlySet<string>;
}

export type Operation = "INSERT" | "UPDATE" | "DELETE";

const key = (calendarId: string, op: Operation) => `${calendarId}:${op}`;

export const allow = (
  provider: string,
  pairs: readonly (readonly [string, Operation])[],
): SyncPolicy => ({
  provider,
  permitted: new Set(pairs.map(([id, op]) => key(id, op))),
});

export class PolicyViolation extends Error {
  constructor(calendarId: string, op: Operation) {
    super(
      `Refusing ${op} on calendar ${calendarId}: not in the SyncPolicy allowlist. ` +
        `The write path is deny-by-default, so this is a compile-time-shaped ` +
        `refusal rather than a policy that can be forgotten.`,
    );
    this.name = "PolicyViolation";
  }
}

interface OwnershipToken {
  readonly token: string;
  readonly calendarId: string;
  readonly externalUid: string;
}

/** A delete is only constructible from a token that was minted at create time. */
export class DeleteRefusal extends Error {
  constructor() {
    super(
      "Refusing DELETE: no ownership token. An event this service did not create " +
        "is not deletable, and the absence of a token is unrepresentable as a " +
        "successful delete rather than a runtime check that might be skipped.",
    );
    this.name = "DeleteRefusal";
  }
}

const assertPermitted = (policy: SyncPolicy, calendarId: string, op: Operation): void => {
  if (!policy.permitted.has(key(calendarId, op))) throw new PolicyViolation(calendarId, op);
};

/** Build a delete. Throws rather than returning null, so the caller cannot ignore it. */
export const authoriseDelete = (
  policy: SyncPolicy,
  ownership: OwnershipToken | null,
  calendarId: string,
  externalUid: string,
): { readonly calendarId: string; readonly externalUid: string; readonly token: string } => {
  assertPermitted(policy, calendarId, "DELETE");
  if (
    ownership === null ||
    ownership.calendarId !== calendarId ||
    ownership.externalUid !== externalUid
  ) {
    throw new DeleteRefusal();
  }
  return { calendarId, externalUid, token: ownership.token };
};

/**
 * Retry policy. Explicit, and it encodes the rule that matters: a
 * non-idempotent write is never retried. A retried INSERT that actually landed
 * is the single most common way a calendar integration produces duplicates.
 */
export const retryDelayMs = (attempt: number, idempotent: boolean): number | null => {
  if (!idempotent) return null;
  if (attempt >= 5) return null;
  return Math.min(30000, 250 * 2 ** attempt);
};

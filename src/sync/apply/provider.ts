// The provider interface the apply step writes through.
//
// Deliberately small, and deliberately WITHOUT a delete. The plan's binding rule
// 10 makes an unowned delete unrepresentable; the stronger form is that the apply
// path has no delete to call at all. Destructive cleanup of an external event is
// a human-gated action, so it is not part of this surface. If it ever needs to
// exist it arrives as a separate, explicitly named interface that the apply step
// does not receive.
//
// Every write is idempotent by construction: INSERT is keyed on a uid the caller
// chooses, so a retried INSERT that actually landed returns the existing event
// instead of creating a second one.

export interface EventPayload {
  readonly summary: string;
  readonly startUtc: string;
  readonly endUtc: string;
}

interface ProviderEvent {
  readonly externalUid: string;
  readonly etag: string;
}

interface WriteContext {
  /** Same key on a retry. A provider uses it to recognise its own earlier write. */
  readonly idempotencyKey: string;
}

export interface CalendarProvider {
  /** Create `uid`, or return it unchanged if it already exists. */
  insert(
    calendarId: string,
    uid: string,
    payload: EventPayload,
    ctx: WriteContext,
  ): Promise<ProviderEvent & { readonly created: boolean }>;
  /** Replace `uid`. `ifMatch` is the etag we last saw; a mismatch must throw, not overwrite. */
  update(
    calendarId: string,
    uid: string,
    payload: EventPayload,
    ifMatch: string | null,
    ctx: WriteContext,
  ): Promise<ProviderEvent>;
}

/**
 * The provider sync:once applies to. There is no implementation for a real
 * calendar yet, so this returns null and the live path refuses before writing.
 * Returning a stand-in here would record bindings for events that exist nowhere.
 */
export const configuredProvider = (): CalendarProvider | null => null;

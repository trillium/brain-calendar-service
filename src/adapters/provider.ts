// The provider seam: what the sync engine may ask of an external calendar.
//
// Every write takes the SyncPolicy, so an out-of-policy write is refused by the
// adapter itself rather than by whoever remembered to check. Implementations
// are transport only: no recurrence expansion happens behind this interface.

import type { OwnershipToken, SyncPolicy } from "../sync/loop/policy.js";

interface ProviderEventTime {
  /** RFC 3339 instant; absent for all-day events. */
  readonly dateTime?: string;
  /** Date-only form, set for all-day events. */
  readonly date?: string;
  readonly timeZone?: string;
}

export interface ProviderEvent {
  readonly id: string;
  readonly status?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly start?: ProviderEventTime;
  readonly end?: ProviderEventTime;
  readonly recurrence?: readonly string[];
  readonly recurringEventId?: string;
  readonly etag?: string;
  readonly updated?: string;
  readonly privateProperties: Readonly<Record<string, string>>;
}

export interface ListWindow {
  readonly from?: string;
  readonly to?: string;
  readonly max?: number;
}

export interface EventDraft {
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  /** RFC 3339 instant, or a date for all-day events. */
  readonly from?: string;
  readonly to?: string;
  readonly timeZone?: string;
  readonly allDay?: boolean;
  readonly rrule?: readonly string[];
  readonly privateProperties?: Readonly<Record<string, string>>;
}

export interface CalendarProvider {
  readonly name: string;
  listEvents(calendarId: string, window?: ListWindow): Promise<readonly ProviderEvent[]>;
  getEvent(calendarId: string, eventId: string): Promise<ProviderEvent>;
  createEvent(policy: SyncPolicy, calendarId: string, draft: EventDraft): Promise<ProviderEvent>;
  updateEvent(
    policy: SyncPolicy,
    calendarId: string,
    eventId: string,
    draft: EventDraft,
  ): Promise<ProviderEvent>;
  deleteEvent(
    policy: SyncPolicy,
    ownership: OwnershipToken | null,
    calendarId: string,
    eventId: string,
  ): Promise<void>;
}

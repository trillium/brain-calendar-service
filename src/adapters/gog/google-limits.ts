// Google's extendedProperties.private limits, and the two-valued delete.
//
// Both of these are the kind of provider behaviour that fails SILENTLY, which is
// the failure mode the plan refuses to ship. A property key longer than 44
// characters vanishes with no error; a value longer than 1024 characters is
// truncated; and a calendar tops out at 300 properties totalling 32 kB. The
// marker that makes a write idempotent - the originating bead id - therefore
// has to be short by construction AND checked at startup, because "it worked on
// my calendar" is not a test.
//
// The second thing here is Google's two-valued delete, which has no CalDAV
// equivalent and is the single most common way a sync deletes something it
// should not have:
//
//   a CANCELLED event whose RECURRENCE-ID names an occurrence of an UNCANCELLED
//     recurring event  ->  "this instance only, keep the parent"
//   any other cancelled event, including a cancelled parent
//                                             ->  "deleted, drop your copy"
//
// Getting this backwards is how a calendar ends up with a whole series deleted
// because one meeting was moved.

export const LIMITS = {
  propertyKeyMax: 44,
  propertyValueMax: 1024,
  propertiesPerEventMax: 300,
  bytesPerEventMax: 32768,
} as const;

interface PrivateProperties {
  readonly [key: string]: string;
}

export class PropertyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PropertyLimitError";
  }
}

/** Assert a marker set is safe BEFORE it is sent, because the provider will not. */
export const assertWithinGoogleLimits = (props: PrivateProperties): void => {
  const entries = Object.entries(props);
  if (entries.length > LIMITS.propertiesPerEventMax) {
    throw new PropertyLimitError(
      `${entries.length} private properties exceeds the ${LIMITS.propertiesPerEventMax} per-event limit`,
    );
  }
  let bytes = 0;
  for (const [key, value] of entries) {
    if (key.length > LIMITS.propertyKeyMax) {
      throw new PropertyLimitError(
        `private property key "${key}" is ${key.length} characters; Google silently DROPS ` +
          `keys over ${LIMITS.propertyKeyMax}. This is the marker that makes writes idempotent, ` +
          `so a dropped key means duplicate events.`,
      );
    }
    if (value.length > LIMITS.propertyValueMax) {
      throw new PropertyLimitError(
        `private property "${key}" is ${value.length} characters; Google silently TRUNCATES ` +
          `values over ${LIMITS.propertyValueMax}.`,
      );
    }
    bytes += key.length + value.length;
  }
  if (bytes > LIMITS.bytesPerEventMax) {
    throw new PropertyLimitError(
      `${bytes} bytes of private properties exceeds the ${LIMITS.bytesPerEventMax} per-event limit`,
    );
  }
};

type DeleteIntent = "cancel_instance" | "delete_event";

/**
 * Decide what a cancelled event means.
 *
 * `parentUid` is the UID of the recurring series the instance belongs to, when
 * the caller knows it. Without it the answer is deliberately conservative.
 */
export const classifyCancelled = (event: {
  cancelled: boolean;
  recurrenceId: string | null;
  /** The recurring series this occurrence belongs to, if the caller knows it. */
  parent?: { readonly uid: string; readonly cancelled: boolean } | null;
}): DeleteIntent | null => {
  if (!event.cancelled) return null;
  const parent = event.parent;
  if (event.recurrenceId !== null && parent !== undefined && parent !== null && !parent.cancelled) {
    return "cancel_instance";
  }
  return "delete_event";
};

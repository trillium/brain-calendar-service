// calendar_id is a BIGINT in the schema, so a calendar's identity is numeric in
// the store. "cal-1" is the readable alias used on the wire; resolve it once, at
// the edge, and refuse anything that is not an integer rather than letting the
// driver discover it.

export const calendarIdFromAlias = (alias: string): number => {
  const raw = alias.startsWith("cal-") ? alias.slice(4) : alias;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0 || raw.trim() === "") {
    throw new Error(`calendar id must be a positive integer or "cal-<n>", got "${alias}"`);
  }
  return id;
};

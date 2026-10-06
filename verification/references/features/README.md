# Feature map — regression sweep order

Top-to-bottom order for "did we break the app broadly?". Each file has the same
four headings, so you can read one and know what the others look like.

| # | feature | file | sweep cost |
|---|---|---|---|
| 1 | RFC 5546 resolution | [rfc5546.md](rfc5546.md) | seconds, pure |
| 2 | recurrence and timezones | [recurrence.md](recurrence.md) | seconds, pure |
| 3 | change detection | [changedetection.md](changedetection.md) | seconds, needs Dolt |
| 4 | loop and duplicate prevention | [loop.md](loop.md) | seconds, pure |
| 5 | CalDAV transport | [caldav.md](caldav.md) | seconds, local server |
| 6 | orchestration and quarantine | [orchestration.md](orchestration.md) | seconds, needs Dolt |
| 7 | MCP surface | [mcp.md](mcp.md) | ~1 minute, spawns a process |
| 8 | rollout and migration | [rollout.md](rollout.md) | seconds, needs Dolt |

Sweep from the top: the first two are pure and hermetic, so a failure there is
unambiguous and needs nothing running.

**Drift rule:** a change touching a domain area updates that area's file in the
same commit.

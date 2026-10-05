# S3 skip ledger (R13)

skip: ical.js's own RFC conformance tester (libical-recur.c oracle) was NOT wired into CI. The plan offers it "once S3 lands, if the build is tractable". Building it needs the upstream test fixtures, which are not in the published npm package, so the four named fixtures plus the property sweep are what gate this stage. Revisit only if the upstream fixtures become reachable.
skip: rrule.js was not installed and not evaluated. The plan rejects it outright (two RFC deviations that break the Google wire format), so evaluating it would be a third opinion on a closed question.
skip: Only 8 timezones are pinned, over 2020-2040. That is the supported surface, not an accident of sampling; each pinned zone is a promise the service makes about DST behaviour. Widen deliberately, never implicitly.
skip: No RDATE/EXDATE round-trip against real ICS text beyond what ical.js parses. Wire-format fixtures are S6's job, against recorded provider fixtures.
skip: No conflict resolution integration. S2's resolution function is deliberately not wired into expansion here; joining them is S4/S7, where the cursor exists.

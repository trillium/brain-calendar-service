# S9 skip ledger (R13)

skip: `stale-suppressions` is zero because there are no suppressions in .fallowrc.json beyond the ignorePatterns entries themselves; no @suppress annotations exist to go stale. Recorded as a measured zero rather than an assumed one.
skip: The feature map is deliberately the MINIMAL seven-file version (rfc5546, recurrence, changedetection, loop, caldav, orchestration, mcp). The grown ~30-file map is authoring cost with a known rot failure mode, which is exactly why the drift rule exists and is why scope was held at seven.
skip: No operator UI, so no accessibility or end-to-end workflow exists to add to the regression sweep. The sweep is the seven domain areas.
skip: The verification skill is a repo document, not a harness that runs itself. It tells a run what to execute; the commands it names are the same ones CI runs, so it cannot drift from reality without CI going red.

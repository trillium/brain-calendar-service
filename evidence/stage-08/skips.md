# S8 skip ledger (R13)

skip: The MCP server holds an in-process store rather than reading the Dolt store over a connection. The boundary this stage proves is the PROTOCOL and the tool surface; wiring the real store is a wiring change, and pretending it was tested would be the thing this plan exists to prevent.
skip: No multi-user authorization, because there is one authority: Beads. The plan states this explicitly.
skip: Provider credentials are deliberately not an MCP concern. The tools cannot reach a provider at all - they import only from domain/ - so there is nothing to authorize.
skip: No UI. "Plan My Day" lineage stays out of scope per the plan's own U8 handling.
skip: The SDK is pinned exactly rather than with a caret, because the registration form below is load-bearing and a silent minor upgrade would reintroduce a bug that type-checks and reads as correct.

# S7 skip ledger (R13)

skip: The live apply path writes plans but does not yet call a provider. The transport exists (S6) and the policy is enforced at the planning boundary, but the push/pull application is S9+ work once a real credential exists. What is proven here is that planning writes nothing and that the plan is checkable.
skip: No bounded backoff on provider rate limits was implemented in this stage, because there is no provider call in the cycle yet. The retry policy itself was delivered at S5.
skip: The cursor bootstrap happens on the LIVE path only. A dry-run must not write to Dolt, and that includes its own bookkeeping - so on a dry-run with no cursor the honest answer is a quarantined full-resync request, which is what it returns.
skip: Quarantine rows were not written by this stage. The sink exists and has no exit path; promoting a conflict is a human decision and nothing here promotes one.
skip: No cross-calendar fan-out. One calendar is enough to prove or disprove the orchestration shape.

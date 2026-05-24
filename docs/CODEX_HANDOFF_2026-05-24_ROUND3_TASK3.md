# CODEX Handoff 2026-05-24 Round 3 Task 3 - v0.3 Leakage Postmortem

## Status

Completed.

## File

- `docs/V0.3_LEAKAGE_POSTMORTEM.md`

## Key Conclusion

v0.3 failed because offline random test rows had post-publication features populated, while production cold-start manuscripts supplied those features as missing. The high R2 was a feature-availability mismatch, not a real forecasting gain.

## Guardrail Added

The v0.3-prepub eval report now includes:

- forbidden feature count
- suspicious high-R2 guardrail
- top feature table with forbidden flags
- EMPA-REG cold-start smoke result

Production deployment remains blocked unless both offline R2 and cold-start behavior pass.

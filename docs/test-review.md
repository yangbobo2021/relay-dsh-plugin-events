# Events Test Review

## Review 1 — service extraction

- Preserved Runtime tests for replacement Waits, multi-Session delivery,
  escalation, cancellation, ordering, and Activation identity.
- Added Router substitution/duplicate/disposal, Monitor baseline failure,
  restart recovery, and shutdown drain coverage.
- The first run exposed an unhandled rejected Promise created by cleanup tracking;
  handled success/error branches now remove in-flight Promises, and the regression
  test passes without asynchronous activity warnings.

## Review 2 — Agent bridge

- Verified tools derive Session ownership from authenticated Agent context.
- Verified Events owns only Wait registration/cancellation tools; timer ownership
  moved to Monitors.
- Extended and asserted Monitor proposal fields without accepting a model-supplied
  Session id.

Packed official-DSH boot/composition and browser checks run in Relay's cross-plugin
delivery harness.

## Review 3 — independent checkout execution

- Verified a fresh plugin checkout can run `npm test` without relying on a parent
  workspace installation.
- Added the same official-DSH peer-link preparation used by typecheck and build to
  the test lifecycle; this prevents a false local pass caused by hoisted packages.

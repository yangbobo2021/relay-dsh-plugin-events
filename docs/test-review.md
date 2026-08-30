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

## Review 4 — composed Router audit identity

- The cross-plugin test showed that a substituted Router delivered correctly while
  its routing attempt was attributed to an internal slot name.
- Events now reads `name` and `model` dynamically from the active provider, and the
  service test asserts provider attribution before fallback restoration.

## Review 5 — submodule workspace type identity

- Running the plugin inside Relay exposed duplicate branded DSH types resolved from
  the parent workspace instead of the pinned official checkout.
- The original wildcard peer-directory mapping did **not** fix package subpath
  exports. The continuation replaces it with a generated map of official declaration
  exports (including `/types` and transitive brands). Both typecheck and build now pass;
  `dsh-type-paths.test.mjs` covers this resolution rule without suppressing errors.

## Review 6 — real composition and admission lifecycle

- Persisted Observer identity in the Monitor manifest and restored it on hydration;
  otherwise every non-clock observation failed after baseline despite passing fake-store tests.
- Grouped multiple matching Waits per Session in exact routing (one Delivery per Session).
- Agent tool disposers now belong to the plugin as well as the Agent, preventing stale tools after unload.
- Admission acknowledges inbox flush, not whole model-turn completion. Stable message IDs and
  persisted inbox/message lookup prevent duplicate follow-ups after an acknowledgement retry.
- Added real SQLite composition regressions for recurring rearm, Observer failure, lease exclusion,
  atomic baseline rollback and overdue restart; added background recovery and inbox retry unit tests.

## Review 7 — packed delivery and composition

- Clean-directory tarball installation imports all public entries without parent
  source or private runtime packages. Host-only Router/Monitors need no browser entry.
- Added real Cordis dependency appearance/removal/reappearance coverage; surviving
  Agents retain no stale tools after plugin unload.
- Replaced misleading raw GitHub installation instructions with build-and-pack
  instructions, since generated `lib/` is intentionally not tracked.
- A rearmed recurring Monitor now ignores already committed trigger keys without
  pausing again. The regression checks disappearance/reappearance and the still-active
  replacement Wait. Shutdown lease release is tested against real SQLite.

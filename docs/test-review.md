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

## Review 8 — continuation, snapshots, and trusted binding

- Added EP-01 continuation normalization with legacy defaults, nested shape and size
  bounds, atomic failure behavior, and authenticated Agent-tool ownership.
- Persisted the exact matched Wait snapshot and routing evidence on each Delivery so a
  later Wait replacement cannot change the admitted continuation context.
- Replaced insertion-order exclusive selection with deterministic escalation and kept
  non-exclusive multi-Session fan-out.
- Added capability-scoped bound Event source registration. Public payload fields cannot
  assert ownership; stale and cross-Session bindings escalate without claims.
- Exercised a real schema v4 file migration, not an in-memory reconstructed v5 store.
- The first test command intentionally failed before discovery because `DSH_ROOT` was
  absent; it was not counted as a pass. Verification then used official DSH
  `dd6322d604e00eec1ba5e0c8541159906a21094a` and discovered every expected test with
  zero skip/todo.
- Mutation review disabled the new exclusive-conflict guard. EP03-006/008 failed in
  the routing validator before any Delivery, proving the acceptance test exercises the
  protection rather than a fixture-only assertion. The guard was restored before the
  final run.

## Review 9 — Router failure terminalization and recovery

- Added a configurable Router failure budget whose final attempt commits an
  inspectable escalation instead of leaving an Event permanently in `routing`.
- The committed decision contains stable public wording and attempt metadata but not
  the Router's raw error text; the regression injects a sentinel secret and proves it
  is absent.
- Extended background recovery to resume both incomplete Events and queued
  Deliveries. The recovery regression begins with a real rejected ingress call,
  waits for the scheduler's second attempt, then independently reads SQLite-backed
  Event state and asserts exactly two attempts and no Delivery.

## Review 10 — productization and browser delivery

- Schema v10 persists notification attempt counts and provider receipts. Tests prove
  duplicate ingress cannot silently retry and only an explicit failed/unavailable
  action can retry; the official browser verifies the second unavailable attempt is
  still visible when no provider exists.
- Exact rate/concurrency boundaries, fixed public overload/internal errors, stable
  keyset pagination, retention rollback, and Monitor proposal budgets are asserted
  against production paths. Events verification discovered 52/52 tests with zero
  skip/todo, then typecheck, build, and dry-run pack passed.
- Official DSH `dd6322d604e00eec1ba5e0c8541159906a21094a` accepted the packed management
  suite: English/Chinese, 1280×720 and 1440×900, destructive keyboard dialogs,
  focus return, hostile text, Router and credential lifecycles, pagination, Monitor
  cadence validation/update, terminal/check/trigger evidence, light/dark computed
  WCAG AA contrast, the full user-facing fault matrix, and console/network cleanliness.
  A separate Events-only run proved real empty state and background transition to the
  first durable HTTP Event. Packed Codex and Claude compositions proved the same Event
  stack boots with both backend adapters and opens an existing backend-bound Session.
- The browser run initially caught Escape propagation, disconnected focus targets,
  an unlabeled Relay filter, and onboarding-mask timing. Each failure remained red
  until the production UI or the test's host-state synchronization was corrected;
  no force-click, skipped case, or weakened Relay assertion was accepted.
- The extended browser gate also caught tertiary/status colors below AA, a React
  `currentTarget` lifetime crash, and a rapid cadence submit that left the visible
  input at 7200 while persisting 3600. The final assertion waits for the independently
  reloaded Monitor summary, so the old UI-only false positive cannot pass.

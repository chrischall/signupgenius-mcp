import { withAmbientCancellation } from '@chrischall/mcp-utils';

/**
 * Upper bound on any single upstream SignUpGenius request. The ColdFusion
 * dispatcher can stall; without a bound one stalled call hangs the whole tool
 * call until the MCP host gives up (fleet-audit#701). Generous enough for the
 * slow legacy endpoints, short enough that a write's "did it land?" re-check
 * still runs inside a host's tool-call budget.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * `fetch` bounded by {@link REQUEST_TIMEOUT_MS} and by the cancellation of the
 * MCP request currently being served (whichever fires first). A caller that
 * passes its own `signal` keeps it unchanged.
 */
export const timedFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    signal: init?.signal ?? withAmbientCancellation(AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
  });

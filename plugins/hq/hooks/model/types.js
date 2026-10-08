// Contract between the data layer (hooks/data/*) and the pane (hooks/ui/*).
// The data layer produces a HqModel; the pane only renders it.
/** A tool call open this long renders as waiting (a spec run, `pr-ci-wait`). */
export const LONG_CALL_MS = 120_000;

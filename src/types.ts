/**
 * Shared vocabulary: phases, outcomes, and the settings shape.
 *
 * Kept free of host imports so both the coordinator and the browser half can
 * describe the same lifecycle without pulling a Node module into the bundle.
 */

/** The lifecycle of one handoff or compaction attempt. */
export type Phase =
  | 'idle'
  | 'preparing'
  | 'waiting-for-step-boundary'
  | 'summarizing'
  | 'creating-session'
  | 'transferring'
  | 'waiting-for-compact'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Why an automatic action was proposed. */
export type ActionReason = 'manual' | 'context' | 'cumulative'

/** Which automatic action a proposal asks the coordinator to run. */
export type ActionKind = 'handoff' | 'compact'

/** How trustworthy a measurement is. */
export type MeasureQuality = 'exact' | 'estimated' | 'unavailable'

/** Which metric the user asked automatic handoff to key on. */
export type TriggerMode = 'context' | 'cumulative' | 'either'

/** One inherited configuration item and its outcome. */
export interface InheritOutcome {
  readonly item: string
  readonly status: 'inherited' | 'fallback' | 'skipped'
  readonly detail?: string
}

/** The verdict of one attempt. */
export interface ActionResult {
  readonly ok: boolean
  readonly phase: Phase
  readonly text: string
  readonly newSessionId?: string
  readonly inherited?: readonly InheritOutcome[]
  readonly warnings?: readonly string[]
  readonly error?: string
}

/** A failure retained for `/handoff status`. */
export interface FailureRecord {
  readonly at: number
  readonly phase: Phase
  readonly message: string
}

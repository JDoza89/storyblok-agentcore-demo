/** A gap the agent flagged, optionally pinned to the block and field it's about. */
export interface Gap {
  message: string;
  component?: string;
  blockUid?: string;
  fieldname?: string;
}

/**
 * What this run actually did, recorded by the hooks from real tool results
 * rather than read back out of the model's summary. The verifier and the
 * AGENT_RESULT line are built from this, which is why the model no longer
 * writes AGENT_RESULT itself.
 */
export class RunTracker {
  storyId: number | null = null;
  mode: 'created' | 'updated' | null = null;
  /** Locales the agent ran ai_translate_story for. */
  readonly locales = new Set<string>();
  /** Story ids moved into the review stage by a successful stage change this run. */
  readonly stagedStories = new Set<number>();
  /** Gaps the agent flagged with flag_gap, posted as story comments at the end of the run. */
  readonly gaps: Gap[] = [];

  recordCreate(storyId: number): void {
    this.storyId = storyId;
    this.mode = 'created';
  }

  recordUpdate(storyId: number): void {
    if (this.storyId === storyId && this.mode === 'created') return;
    this.storyId = storyId;
    this.mode = 'updated';
  }

  reset(): void {
    this.storyId = null;
    this.mode = null;
    this.locales.clear();
    this.stagedStories.clear();
    this.gaps.length = 0;
  }
}

import {
  loadFeedback,
  saveFeedback,
  type FeedbackChange,
  type FeedbackState,
} from './feedback';

type PendingChange = {
  change: FeedbackChange;
  resolve: (saved: boolean) => void;
};

function record<T>(): Record<string, T> {
  // SAFETY: A new null-prototype object has no entries and can hold only T values through this API.
  return Object.create(null) as Record<string, T>;
}

// Null-prototype records protect special IDs. Replace them to notify Svelte.
function updated<T>(
  values: Record<string, T>,
  id: string,
  value: T,
): Record<string, T> {
  return Object.assign(record<T>(), values, { [id]: value });
}

function apply(state: FeedbackState, change: FeedbackChange): FeedbackState {
  return change.field === 'starred'
    ? { ...state, starred: change.value }
    : { ...state, reaction: change.value };
}

/** One instance per app. Each job has a serial save queue and confirmed state. */
export class FeedbackStore {
  available = $state(false);
  loading = $state(false);
  error = $state<string | null>(null);
  states = $state<Record<string, FeedbackState>>(record());
  errors = $state<Record<string, string | null>>(record());
  pending = $state<Record<string, boolean>>(record());
  private csrf = '';
  private confirmed = new Map<string, FeedbackState>();
  private queues = new Map<string, PendingChange[]>();
  private failed = new Map<string, FeedbackChange>();

  constructor(private baseUrl = './') {}

  async load(): Promise<void> {
    if (this.loading || this.queues.size) return;
    this.loading = true;
    this.error = null;
    this.available = false;
    this.csrf = '';
    this.confirmed.clear();
    this.failed.clear();
    this.states = record();
    this.errors = record();
    this.pending = record();

    try {
      const result = await loadFeedback(this.baseUrl);
      this.available = result.available;
      this.csrf = result.csrf;
      this.confirmed = result.states;
      this.states = Object.fromEntries(result.states);
    } catch {
      this.error = 'Could not load feedback. Try again.';
    } finally {
      this.loading = false;
    }
  }

  setStar(id: string, value: boolean): Promise<boolean> {
    return this.enqueue(id, { field: 'starred', value });
  }

  /** A selected thumb clears; another thumb replaces it. */
  setReaction(id: string, value: FeedbackState['reaction']): Promise<boolean> {
    return this.enqueue(id, {
      field: 'reaction',
      value: this.states[id]?.reaction === value ? null : value,
    });
  }

  /** Retry the exact failed value, including a thumb being cleared. */
  retry(id: string): Promise<boolean> {
    const change = this.failed.get(id);

    return change && !this.pending[id]
      ? this.enqueue(id, change)
      : Promise.resolve(false);
  }

  private enqueue(id: string, change: FeedbackChange): Promise<boolean> {
    const current = this.states[id];

    if (!this.available || !this.confirmed.has(id) || !current)
      return Promise.resolve(false);
    const queue = this.queues.get(id) ?? [];
    this.queues.set(id, queue);
    this.states[id] = apply(current, change);
    this.errors = updated(this.errors, id, null);
    this.pending = updated(this.pending, id, true);

    return new Promise((resolve) => {
      queue.push({ change, resolve });

      if (queue.length === 1) void this.drain(id, queue);
    });
  }

  private async drain(id: string, queue: PendingChange[]): Promise<void> {
    while (queue.length) {
      const work = queue[0];

      if (!work) break;
      let saved = false;

      try {
        this.confirmed.set(
          id,
          await saveFeedback(id, work.change, this.csrf, this.baseUrl),
        );
        this.errors = updated(this.errors, id, null);
        this.failed.delete(id);
        saved = true;
      } catch {
        this.failed.set(id, work.change);
        this.errors = updated(
          this.errors,
          id,
          'Could not save feedback. Try again.',
        );
      }

      queue.shift();
      // Keep later clicks visible, but never retain a failed change as confirmed.
      this.states[id] = queue.reduce(
        (current, next) => apply(current, next.change),
        this.confirmed.get(id)!,
      );
      work.resolve(saved);
    }

    this.queues.delete(id);
    this.pending = updated(this.pending, id, false);
  }
}

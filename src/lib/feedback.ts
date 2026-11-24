import { Schema } from 'effect';

export type FeedbackState = {
  starred: boolean;
  reaction: 'up' | 'down' | null;
};

export type FeedbackChange =
  | { field: 'starred'; value: boolean }
  | { field: 'reaction'; value: FeedbackState['reaction'] };

export type LoadedFeedback = {
  available: boolean;
  csrf: string;
  states: Map<string, FeedbackState>;
};

export class FeedbackError extends Error {}

const ID = /^[a-z0-9_-]{1,128}$/;
const CSRF = /^[0-9a-f]{64}$/;

const unavailable = (): LoadedFeedback => ({
  available: false,
  csrf: '',
  states: new Map(),
});

// These private client schemas preserve the existing feedback wire boundary.
const listingId = Schema.String.pipe(Schema.pattern(ID));
const csrfToken = Schema.String.pipe(Schema.pattern(CSRF));

const feedbackState = Schema.Struct({
  starred: Schema.Boolean,
  reaction: Schema.NullOr(Schema.Literal('up', 'down')),
});

const loadedFeedback = Schema.Struct({
  csrf_token: csrfToken,
  listing_ids: Schema.Array(listingId),
  states: Schema.Record({ key: listingId, value: feedbackState }),
});

const savedFeedback = Schema.Struct({ state: feedbackState });

const feedbackChange = Schema.Union(
  Schema.Struct({ field: Schema.Literal('starred'), value: Schema.Boolean }),
  Schema.Struct({
    field: Schema.Literal('reaction'),
    value: Schema.NullOr(Schema.Literal('up', 'down')),
  }),
);

function endpoint(baseUrl: string): string {
  const base = new URL(baseUrl, window.location.href);

  if (
    base.origin !== window.location.origin ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new FeedbackError('Feedback must use the same origin.');
  }

  if (!base.pathname.endsWith('/')) base.pathname += '/';

  return new URL('shortlist-feedback', base).href;
}

async function request(url: string, options: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
      redirect: 'manual',
      ...options,
    });
  } catch {
    throw new FeedbackError('Could not reach feedback.');
  }
}

export async function loadFeedback(baseUrl = './'): Promise<LoadedFeedback> {
  const response = await request(endpoint(baseUrl), { method: 'GET' });

  if (
    [401, 404, 303].includes(response.status) ||
    response.type === 'opaqueredirect'
  )
    return unavailable();

  if (!response.ok) throw new FeedbackError('Could not load feedback.');
  let value: Schema.Schema.Type<typeof loadedFeedback>;

  try {
    value = Schema.decodeUnknownSync(Schema.parseJson(loadedFeedback))(
      await response.text(),
      { onExcessProperty: 'error' },
    );
  } catch {
    throw new FeedbackError('Invalid feedback response.');
  }

  const states = new Map<string, FeedbackState>();

  for (const id of value.listing_ids) {
    if (states.has(id) || !Object.hasOwn(value.states, id)) {
      throw new FeedbackError('Invalid feedback response.');
    }

    const state = value.states[id];

    if (!state) throw new FeedbackError('Invalid feedback response.');

    states.set(id, state);
  }

  if (states.size !== Object.keys(value.states).length)
    throw new FeedbackError('Invalid feedback response.');

  return { available: true, csrf: value.csrf_token, states };
}

/** Optional baseUrl must be the same directory used for loadFeedback. */
export async function saveFeedback(
  id: string,
  change: FeedbackChange,
  csrf: string,
  baseUrl = './',
): Promise<FeedbackState> {
  if (!ID.test(id) || !CSRF.test(csrf) || !Schema.is(feedbackChange)(change)) {
    throw new FeedbackError('Invalid feedback change.');
  }

  const response = await request(endpoint(baseUrl), {
    method: 'POST',
    // The app's no-referrer policy would make Origin null for this same-origin POST.
    referrerPolicy: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({
      listing_id: id,
      field: change.field,
      value: change.value,
    }),
  });

  if (!response.ok) throw new FeedbackError('Could not save feedback.');

  try {
    return Schema.decodeUnknownSync(Schema.parseJson(savedFeedback))(
      await response.text(), { onExcessProperty: 'error' },
    ).state;
  } catch {
    throw new FeedbackError('Invalid feedback response.');
  }
}

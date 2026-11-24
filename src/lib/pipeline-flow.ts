import type { Snapshot } from './snapshot';

// Shared display names for About and the run funnel. These are not run events.
export const pipelineSteps = {
  source: { label: 'Read NAV', kind: 'Source', detail: 'Read new and changed ads from the NAV feed.' },
  locations: { label: 'Resolve locations', kind: 'Source', detail: 'Look up workplaces with missing location data.' },
  filters: { label: 'Filters', kind: 'Rules', detail: 'Keep only jobs that pass area, occupation and exclusion rules.' },
  screen: { label: 'AI title screen', kind: 'AI', detail: 'Use saved decisions or assess titles and summaries before full review.' },
  judge: { label: 'AI judge', kind: 'AI', detail: 'Reuse compatible reviews or compare full ads with your profile.' },
  rejudge: { label: 'AI re-judge', kind: 'AI · Optional', detail: 'When needed, review jobs again at the configured fit levels.' },
  snapshot: { label: 'Snapshot', kind: 'Saved data', detail: 'Save jobs and recommendations for the dashboard.' },
  alerts: { label: 'Alerts', kind: 'Optional', detail: 'After a scheduled refresh, Pulse can notify you of new Exceptional matches.' },
} as const;

export type PipelineStepId = keyof typeof pipelineSteps;

export function capturedPipelineSteps(snapshot: Snapshot): PipelineStepId[] {
  const settings = 'settings' in snapshot ? snapshot.settings : undefined;
  const steps: PipelineStepId[] = ['source', 'locations', 'filters', 'screen', 'judge'];

  if ("personal_inputs" in snapshot && snapshot.settings.rejudge?.levels.length) steps.push('rejudge');

  steps.push('snapshot');

  if (settings?.notifications_enabled === true) steps.push('alerts');

  return steps;
}

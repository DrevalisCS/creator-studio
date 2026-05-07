// =============================================================================
// Dashboard layout types — shared between the hook, the page, and tests.
// =============================================================================

export type WidgetId =
  | 'setup-checklist'
  | 'system-health'
  | 'stat-cards'
  | 'quick-actions'
  | 'recent-episodes'
  | 'activity-timeline'
  | 'active-jobs';

export interface DashboardLayout {
  version: 1;
  /** Ordered list of widget ids that ARE rendered, top to bottom. */
  widgets: WidgetId[];
  /** Ids the user has hidden. */
  hidden: WidgetId[];
}

export const ALL_WIDGET_IDS: readonly WidgetId[] = [
  'setup-checklist',
  'system-health',
  'stat-cards',
  'quick-actions',
  'recent-episodes',
  'activity-timeline',
  'active-jobs',
] as const;

export const WIDGET_LABELS: Record<WidgetId, string> = {
  'setup-checklist': 'Setup Checklist',
  'system-health': 'System Health',
  'stat-cards': 'Statistics',
  'quick-actions': 'Quick Actions',
  'recent-episodes': 'Recent Episodes',
  'activity-timeline': 'Activity Timeline',
  'active-jobs': 'Active Jobs',
};

export const DEFAULT_LAYOUT: DashboardLayout = {
  version: 1,
  widgets: [
    'setup-checklist',
    'system-health',
    'stat-cards',
    'quick-actions',
    'recent-episodes',
    'activity-timeline',
  ],
  hidden: ['active-jobs'],
};

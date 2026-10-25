import type { CountryId } from './types';

export const HOME_COUNTRY: CountryId = 'GBR';

export const ZOOM_LIMITS = { min: 1, max: 25 } as const;
/** Fraction of the shorter viewport side left empty around the globe at zoom 1. */
export const GLOBE_MARGIN = 0.05;
/** The initial view fits home + land neighbours, then zooms out by this factor for context. */
export const HOME_CONTEXT_FACTOR = 0.4;

export const LOD = {
  /** Switch to 50m this long after the last camera movement. */
  idleDelayMs: 150,
  /** At or above this zoom, draw 50m during motion too, if it fits the frame budget. */
  highDuringMotionZoom: 3,
  /** Max measured 50m render time (ms) that still allows 50m during motion. */
  motionFrameBudgetMs: 10,
} as const;

export const DEVICE_PIXEL_RATIO_CAP = 2;

export const INTERACTION = {
  /** Pointer travel (CSS px) before a press becomes a drag instead of a click. */
  dragThreshold: 4,
  /** Inertia velocity decay time constant (ms). */
  inertiaDecayMs: 320,
  /** Inertia stops below this screen speed (CSS px/ms). */
  inertiaMinSpeed: 0.02,
  doubleTapMs: 300,
  doubleTapDistance: 20,
  /** Wheel zoom smoothing time constant (ms). */
  wheelSmoothingMs: 70,
  keyRotateDegrees: 8,
  keyZoomFactor: 1.5,
} as const;

export const SMALL_COUNTRY = {
  /** Projected polygon area (CSS px²) below which the marker is fully opaque. */
  markerFullArea: 25,
  /** Projected polygon area (CSS px²) at which the marker has faded out. */
  markerHideArea: 160,
  markerRadius: 3.5,
  hitRadius: 8,
} as const;

export const LABELS = {
  minFontSize: 10,
  maxFontSize: 18,
  /** Show a label when NE's MIN_LABEL <= equivalent web-map zoom + this bias. */
  zoomBias: 0.6,
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  padding: 3,
} as const;

/** Muted 7-colour political palette, indexed by CountryMeta.colorIndex. */
export const PALETTE = [
  '#7fa38b', // sage
  '#c9a46b', // ochre
  '#8f9fc4', // periwinkle
  '#c48a7c', // terracotta
  '#a99ac4', // lavender
  '#bdb486', // sand
  '#76aab0', // teal
] as const;

export const COLORS = {
  oceanLight: '#2d5f8a',
  oceanMid: '#173a5c',
  oceanDark: '#0a1b2e',
  graticule: 'rgba(200, 225, 255, 0.07)',
  atmosphere: 'rgba(110, 170, 255, 0.35)',
  limbShade: 'rgba(0, 6, 18, 0.45)',
  border: 'rgba(20, 28, 38, 0.55)',
  coastline: 'rgba(14, 22, 32, 0.8)',
  hoverOutline: 'rgba(255, 255, 255, 0.9)',
  selectedFill: '#f0d58c',
  selectedOutline: '#ffcf40',
  markerOutline: 'rgba(255, 255, 255, 0.85)',
  labelText: '#f4f1ea',
  labelHalo: 'rgba(10, 14, 20, 0.85)',
} as const;

/** Named styles for Globe.setHighlights (used by future quizzes). */
export const HIGHLIGHT_STYLES = {
  target: { fill: '#f2c14e', stroke: '#ffe8a3', strokeWidth: 2 },
  correct: { fill: '#5fbf77', stroke: '#b5f0c3', strokeWidth: 1.5 },
  wrong: { fill: '#d9605a', stroke: '#f5b0ab', strokeWidth: 1.5 },
  dimmed: { fill: '#3a414c', stroke: null, strokeWidth: 0 },
} as const satisfies Record<string, { fill: string; stroke: string | null; strokeWidth: number }>;

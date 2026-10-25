import { geoGraticule } from 'd3-geo';
import { COLORS } from '../../config';
import type { LonLat } from '../../types';
import { FastOrtho, packRings } from '../fastOrtho';
import type { Layer } from '../renderer';

const graticule = packRings(geoGraticule().step([15, 15]).precision(1)().coordinates as LonLat[][]);
const graticuleProjector = new FastOrtho();

function sphereCentre(state: { viewport: { width: number; height: number } }): [number, number] {
  return [state.viewport.width / 2, state.viewport.height / 2];
}

/** Soft glow ring just outside the sphere. */
export const atmosphereLayer: Layer = {
  id: 'atmosphere',
  draw(ctx, _projection, state) {
    const [cx, cy] = sphereCentre(state);
    const r = state.radius;
    const outer = r * 1.07 + 6;
    const g = ctx.createRadialGradient(cx, cy, r * 0.98, cx, cy, outer);
    g.addColorStop(0, COLORS.atmosphere);
    g.addColorStop(1, 'rgba(110, 170, 255, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, outer, 0, 2 * Math.PI);
    ctx.fill();
  },
};

/** Ocean sphere, lit from the upper left. */
export const oceanLayer: Layer = {
  id: 'ocean',
  draw(ctx, _projection, state) {
    const [cx, cy] = sphereCentre(state);
    const r = state.radius;
    const g = ctx.createRadialGradient(cx - 0.35 * r, cy - 0.4 * r, 0, cx - 0.1 * r, cy - 0.1 * r, 1.25 * r);
    g.addColorStop(0, COLORS.oceanLight);
    g.addColorStop(0.55, COLORS.oceanMid);
    g.addColorStop(1, COLORS.oceanDark);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fill();
  },
};

export const graticuleLayer: Layer = {
  id: 'graticule',
  draw(ctx, _projection, state) {
    ctx.beginPath();
    graticuleProjector.set(state.camera, state.viewport).draw(ctx, graticule, false, 1, true);
    ctx.strokeStyle = COLORS.graticule;
    ctx.lineWidth = 0.7;
    ctx.stroke();
  },
};

/** Darkens toward the limb so the globe reads as a sphere. */
export const limbShadeLayer: Layer = {
  id: 'limbShade',
  draw(ctx, _projection, state) {
    const [cx, cy] = sphereCentre(state);
    const r = state.radius;
    const g = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
    g.addColorStop(0, 'rgba(0, 6, 18, 0)');
    g.addColorStop(1, COLORS.limbShade);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fill();
  },
};

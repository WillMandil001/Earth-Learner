import type { Camera, LonLat } from '../types';
import { globeRadius, type Viewport } from './camera';

const RAD = Math.PI / 180;

/** Rings (or lines) as packed unit vectors, so per-frame projection is a few multiplies per point. */
export interface PackedRings {
  /** x, y, z per point. */
  xyz: Float64Array;
  /** Exclusive end index (in points) of each ring. */
  ends: Uint32Array;
}

export function packRings(rings: readonly (readonly LonLat[])[]): PackedRings {
  const total = rings.reduce((n, r) => n + r.length, 0);
  const xyz = new Float64Array(total * 3);
  const ends = new Uint32Array(rings.length);
  let i = 0;
  rings.forEach((ring, r) => {
    for (const [lon, lat] of ring) {
      const l = lon * RAD;
      const p = lat * RAD;
      xyz[i++] = Math.cos(p) * Math.cos(l);
      xyz[i++] = Math.cos(p) * Math.sin(l);
      xyz[i++] = Math.sin(p);
    }
    ends[r] = i / 3;
  });
  return { xyz, ends };
}

/**
 * Orthographic projection matching d3.geoOrthographic().rotate([-lon, -lat, 0]),
 * without clipping. Only use it for geometry known to lie on the front hemisphere
 * (callers check bounding caps); everything else goes through d3's clipped path.
 */
export class FastOrtho {
  private k = 1;
  private cx = 0;
  private cy = 0;
  private sl = 0;
  private cl = 1;
  private sp = 0;
  private cp = 1;

  set(cam: Camera, vp: Viewport): this {
    this.k = globeRadius(cam, vp);
    this.cx = vp.width / 2;
    this.cy = vp.height / 2;
    this.sl = Math.sin(cam.lon * RAD);
    this.cl = Math.cos(cam.lon * RAD);
    this.sp = Math.sin(cam.lat * RAD);
    this.cp = Math.cos(cam.lat * RAD);
    return this;
  }

  project([lon, lat]: LonLat): [number, number] {
    const a = Math.cos(lat * RAD) * Math.cos(lon * RAD);
    const b = Math.cos(lat * RAD) * Math.sin(lon * RAD);
    const c = Math.sin(lat * RAD);
    return [this.cx + this.k * (b * this.cl - a * this.sl), this.cy - this.k * (c * this.cp - (a * this.cl + b * this.sl) * this.sp)];
  }

  /**
   * Append rings to the current path. Points closer than `minDist` px to the
   * last emitted point are skipped (sub-pixel detail costs time but adds nothing).
   *
   * With `clip`, geometry may cross the horizon. Lines are cut at the horizon.
   * Polygon vertices behind the globe are clamped onto the limb (with exact
   * horizon crossings inserted), so the visible fill matches true clipping for
   * any polygon smaller than a hemisphere, which every country is.
   */
  draw(ctx: CanvasRenderingContext2D, rings: PackedRings, closed: boolean, minDist: number, clip = false): void {
    const { xyz, ends } = rings;
    const { k, cx, cy, sl, cl, sp, cp } = this;
    const min2 = minDist * minDist;
    let start = 0;
    for (let r = 0; r < ends.length; r++) {
      const end = ends[r]!;
      let lx = 0;
      let ly = 0;
      // Pen state for clipped lines: false while the line is behind the globe.
      let penDown = false;
      let pX = 0;
      let pY = 0;
      let pZ = 0;
      const emit = (X: number, Y: number, force: boolean) => {
        const x = cx + k * X;
        const y = cy - k * Y;
        if (!penDown) {
          ctx.moveTo(x, y);
          penDown = true;
        } else if (force || (x - lx) * (x - lx) + (y - ly) * (y - ly) >= min2) {
          ctx.lineTo(x, y);
        } else {
          return;
        }
        lx = x;
        ly = y;
      };
      for (let i = start; i < end; i++) {
        const a = xyz[i * 3]!;
        const b = xyz[i * 3 + 1]!;
        const c = xyz[i * 3 + 2]!;
        const X = b * cl - a * sl;
        const t = a * cl + b * sl;
        const Y = c * cp - t * sp;
        const last = i === end - 1;
        if (!clip) {
          emit(X, Y, last);
          continue;
        }
        const Z = t * cp + c * sp;
        if (i > start && (Z >= 0) !== (pZ >= 0)) {
          // Exact horizon crossing on the edge, projected onto the limb.
          const u = pZ / (pZ - Z);
          const hx = pX + (X - pX) * u;
          const hy = pY + (Y - pY) * u;
          const h = Math.hypot(hx, hy) || 1;
          emit(hx / h, hy / h, true);
          if (!closed && Z < 0) penDown = false;
        }
        if (Z >= 0) {
          emit(X, Y, last);
        } else if (closed) {
          const h = Math.hypot(X, Y);
          if (h > 1e-9) emit(X / h, Y / h, last);
        }
        pX = X;
        pY = Y;
        pZ = Z;
      }
      if (closed && penDown) ctx.closePath();
      start = end;
    }
  }
}

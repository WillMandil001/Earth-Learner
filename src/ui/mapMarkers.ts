import type { Globe } from '../globe/Globe';
import type { LonLat } from '../types';
import { h } from './dom';

/** 'pulse' = the quiz target, 'click' = where the user clicked, 'answer' = a revealed answer. */
export type MarkerStyle = 'pulse' | 'click' | 'answer';

export interface MapMarker {
  lonLat: LonLat;
  style: MarkerStyle;
}

/**
 * Animated point markers as DOM elements over the canvas, repositioned after
 * every globe frame. CSS does the pulsing, so the globe never has to redraw
 * continuously just to animate a marker.
 */
export class MapMarkers {
  private readonly el: HTMLElement;
  private markers: { m: MapMarker; el: HTMLElement }[] = [];

  constructor(
    parent: HTMLElement,
    private readonly globe: Globe,
  ) {
    this.el = h('div', { class: 'map-markers', 'aria-hidden': 'true' });
    parent.append(this.el);
    globe.on('render', () => this.position());
  }

  set(markers: MapMarker[]): void {
    this.el.replaceChildren();
    this.markers = markers.map((m) => {
      const el = h('div', { class: `map-marker ${m.style}` });
      this.el.append(el);
      return { m, el };
    });
    this.position();
  }

  clear(): void {
    this.set([]);
  }

  private position(): void {
    for (const { m, el } of this.markers) {
      const p = this.globe.project(m.lonLat);
      el.hidden = !p;
      if (p) el.style.transform = `translate(${p[0]}px, ${p[1]}px)`;
    }
  }
}

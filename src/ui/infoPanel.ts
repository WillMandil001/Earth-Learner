import type { CountryId, CountryMeta } from '../types';

/** Right-hand overlay describing the selected country or city. */
export class InfoPanel {
  private readonly el: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly meta: ReadonlyMap<CountryId, CountryMeta>,
    private readonly onNavigate: (id: CountryId) => void,
    onClose: () => void,
  ) {
    this.el = document.createElement('aside');
    this.el.className = 'info-panel';
    this.el.hidden = true;
    this.el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const id = target.closest<HTMLElement>('[data-country]')?.dataset.country;
      if (id) this.onNavigate(id);
      else if (target.closest('.info-close')) onClose();
    });
    parent.appendChild(this.el);
  }

  show(id: CountryId | null): void {
    const m = id ? this.meta.get(id) : undefined;
    if (!m) {
      this.el.hidden = true;
      return;
    }
    const neighbours = m.neighbours
      .map((n) => this.meta.get(n))
      .filter((n): n is CountryMeta => !!n)
      .sort((a, b) => a.name.localeCompare(b.name));
    this.el.replaceChildren();
    const close = el('button', 'info-close', '×');
    close.setAttribute('aria-label', 'Close');
    const dl = el('dl');
    const row = (k: string, v: string) => dl.append(el('dt', '', k), el('dd', '', v));
    if (m.formalName && m.formalName !== m.name) row('Formal name', m.formalName);
    row('Continent', m.continent);
    row('Subregion', m.subregion);
    row('Type', describeStatus(m));
    const list = el('div', 'neighbours');
    if (neighbours.length) {
      for (const n of neighbours) {
        const b = el('button', 'chip', n.name);
        b.dataset.country = n.id;
        list.append(b);
      }
    } else {
      list.append(el('span', 'muted', 'No land borders'));
    }
    this.el.append(close, el('h2', '', m.name), dl, el('h3', '', 'Neighbours'), list);
    this.el.hidden = false;
  }

  /** Describe a city: name, country (clickable), tier and population. */
  showCity(city: { name: string; countryId: CountryId; tier: string; population: number }): void {
    const country = this.meta.get(city.countryId);
    this.el.replaceChildren();
    const close = el('button', 'info-close', '×');
    close.setAttribute('aria-label', 'Close');
    const dl = el('dl');
    const row = (k: string, v: string | HTMLElement) => dl.append(el('dt', '', k), typeof v === 'string' ? el('dd', '', v) : wrap(v));
    const link = el('button', 'chip', country?.name ?? city.countryId);
    link.dataset.country = city.countryId;
    row('Country', link);
    row('Type', city.tier === 'capital' ? 'Capital city' : city.tier === 'major' ? 'Major city' : 'City');
    row('Population', city.population.toLocaleString());
    this.el.append(close, el('h2', '', city.name), dl);
    this.el.hidden = false;
  }
}

function wrap(child: HTMLElement): HTMLElement {
  const dd = el('dd');
  dd.append(child);
  return dd;
}

const SOVEREIGN_TYPES = new Set(['Sovereign country', 'Country', 'Sovereignty']);

/** NE's TYPE is terse ("Country" is used for Australia and Aruba alike), so phrase it for people. */
function describeStatus(m: CountryMeta): string {
  const selfGoverned = m.sovereignty === m.name || m.sovereignty === m.nameLong || m.sovereignty === m.formalName;
  if (selfGoverned && SOVEREIGN_TYPES.has(m.type)) return 'Sovereign state';
  return selfGoverned ? m.type : `${m.type} (${m.sovereignty})`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

import './style.css';
import { loadCountries } from './data/loadCountries';
import { Globe } from './globe/Globe';
import { createControls } from './ui/controls';
import { DebugHud } from './ui/debugHud';
import { InfoPanel } from './ui/infoPanel';
import { Tooltip } from './ui/tooltip';

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  const stage = document.getElementById('globe')!;
  const data = await loadCountries();
  const globe = new Globe(stage, data, { labelMode: 'all' });

  const tooltip = new Tooltip(app);
  const rightStack = document.createElement('div');
  rightStack.className = 'right-stack overlay';
  app.appendChild(rightStack);
  const hud = new DebugHud(rightStack);
  const select = (id: string | null) => {
    globe.setSelected(id);
    panel.show(id);
  };
  const panel = new InfoPanel(
    rightStack,
    data.meta,
    (id) => {
      select(id);
      void globe.flyToCountry(id);
    },
    () => select(null),
  );
  createControls(app, {
    zoomIn: () => void globe.flyTo({ zoom: globe.getCamera().zoom * 1.5 }, { duration: 300 }),
    zoomOut: () => void globe.flyTo({ zoom: globe.getCamera().zoom / 1.5 }, { duration: 300 }),
    home: () => void globe.flyHome(),
  });

  globe.on('hover', (e) => {
    const name = e.id ? data.meta.get(e.id)?.name : null;
    if (name) tooltip.show(name, e.x, e.y);
    else tooltip.hide();
  });
  globe.on('click', (e) => select(e.id));
  globe.on('dblclick', (e) => {
    if (e.id) void globe.flyToCountry(e.id);
  });
  globe.on('render', (s) => hud.update(s));

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'h') void globe.flyHome();
    else if (key === 'l') globe.setLabelMode(globe.getLabelMode() === 'all' ? 'none' : 'all');
    else if (key === 'd') hud.toggle();
  });

  if (import.meta.env.DEV) {
    // Handy for poking at the API from the console and for scripted measurements.
    (window as unknown as { globe: Globe }).globe = globe;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  document.getElementById('app')!.insertAdjacentHTML(
    'beforeend',
    `<div class="fatal overlay">Failed to start: ${String(err)}</div>`,
  );
});

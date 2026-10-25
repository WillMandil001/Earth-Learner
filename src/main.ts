import './style.css';
import { loadCountries } from './data/loadCountries';
import { Globe } from './globe/Globe';
import { CityLayer } from './layers/city/cityLayer';
import { loadCities } from './layers/city/cityData';
import { CountryLayer } from './layers/country/countryLayer';
import { QuizController } from './quiz/QuizController';
import { loadQuizData } from './quiz/data';
import { generateDemoDump } from './quiz/demoSeed';
import { QuizGlobeBinding } from './quiz/globeBinding';
import { SettingsStore } from './settings/store';
import { clock } from './srs/clock';
import { DB_NAME, DEMO_DB_NAME, openStore } from './storage/db';
import { createControls } from './ui/controls';
import { DebugHud } from './ui/debugHud';
import { h } from './ui/dom';
import { InfoPanel } from './ui/infoPanel';
import { LayersPanel } from './ui/layersPanel';
import { MapMarkers } from './ui/mapMarkers';
import { ModeSwitch, type AppMode } from './ui/modeSwitch';
import { QuizPanel } from './ui/quizPanel';
import { SettingsPanel } from './ui/settingsPanel';
import { Tooltip } from './ui/tooltip';

const MODE_KEY = 'earth-learner:mode';

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  const stage = document.getElementById('globe')!;
  const demo = new URLSearchParams(location.search).get('seed') === 'demo';

  const [data, quizData, cityData, store] = await Promise.all([
    loadCountries(),
    loadQuizData(),
    loadCities(),
    openStore(demo ? DEMO_DB_NAME : DB_NAME),
  ]);
  const settings = await SettingsStore.load(store, new Set(quizData.scopes.sovereign));
  const countryLayer = new CountryLayer(quizData, data.meta);
  const cityLayer = new CityLayer(cityData, data, {
    name: (id) => countryLayer.displayName(id),
    neighbours: (id) => data.meta.get(id)?.neighbours ?? [],
  });
  if (demo && (await store.loadCards()).size === 0) {
    await store.replaceAll(generateDemoDump(clock.now(), countryLayer.introductionOrder(settings.value), settings.value));
  }
  const quiz = await QuizController.create({ store, settings, layers: [countryLayer, cityLayer] });

  const globe = new Globe(stage, data, { labelMode: 'all', homeCountry: settings.value.global.homeCountry });
  const markers = new MapMarkers(stage, globe);
  globe.addLayer(cityLayer.render, { before: 'limbShade' });
  globe.addLabelProvider(cityLayer.render);
  const syncCities = () => {
    cityLayer.render.setCities(cityLayer.renderCities(settings.value));
    globe.redraw();
  };
  syncCities();
  const binding = new QuizGlobeBinding({ globe, markers }, quiz);

  // ---- Overlays ---------------------------------------------------------------
  const tooltip = new Tooltip(app);
  let mode: AppMode = 'explore';
  const settingsPanel = new SettingsPanel(app, {
    settings,
    quiz,
    store,
    countries: quizData.scopes[settings.value.layers.country.scope]
      .map((id): [string, string] => [id, quizData.names[id]?.display ?? id])
      .sort((a, b) => a[1].localeCompare(b[1])),
  });
  const modeSwitch = new ModeSwitch(app, (m) => setMode(m), () => settingsPanel.open());
  if (demo) app.append(h('div', { class: 'demo-banner overlay' }, 'Demo data: progress here is separate from your real progress'));

  const rightStack = h('div', { class: 'right-stack overlay' });
  app.appendChild(rightStack);
  const quizPanelEl = document.getElementById('quiz-panel')!;
  const quizPanel = new QuizPanel(quizPanelEl, quiz, settings, () => setMode('explore'));
  const hud = new DebugHud(rightStack, {
    card: () => quiz.currentCard(),
    onTimeTravel: () => quizPanel.render(true),
  });
  const select = (id: string | null) => {
    cityLayer.render.selected = null;
    globe.setSelected(id);
    infoPanel.show(id);
  };
  const selectCity = (id: string) => {
    const city = cityLayer.city(id)!;
    globe.setSelected(null);
    cityLayer.render.selected = id;
    globe.redraw();
    infoPanel.showCity({ name: city.n, countryId: city.c, tier: cityLayer.tiers(settings.value).get(id) ?? 'city', population: city.p });
  };
  const infoPanel = new InfoPanel(
    rightStack,
    data.meta,
    (id) => {
      select(id);
      void globe.flyToCountry(id);
    },
    () => select(null),
  );
  const layersPanel = new LayersPanel(app, [
    {
      id: 'countryLabels',
      label: 'Country labels',
      get: () => globe.getLabelMode() === 'all',
      set: (on) => globe.setLabelMode(on ? 'all' : 'none'),
    },
    {
      id: 'cities',
      label: 'Cities',
      get: () => cityLayer.render.visible,
      set: (on) => {
        cityLayer.render.visible = on;
        globe.redraw();
      },
    },
  ]);
  createControls(app, {
    zoomIn: () => void globe.flyTo({ zoom: globe.getCamera().zoom * 1.5 }, { duration: 300 }),
    zoomOut: () => void globe.flyTo({ zoom: globe.getCamera().zoom / 1.5 }, { duration: 300 }),
    home: () => void globe.flyHome(),
  });

  /** A card is on screen: no tooltips, info panel or label toggling (they would give answers away). */
  const inQuestion = () => mode === 'learn' && ['question', 'reveal'].includes(quiz.state.name);

  function setMode(m: AppMode): void {
    mode = m;
    modeSwitch.set(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // Storage unavailable (private mode): the mode just isn't remembered.
    }
    if (m === 'explore' && quiz.state.name !== 'idle') quiz.stop();
    if (m === 'learn') select(null);
    tooltip.hide();
    binding.setEnabled(m === 'learn');
    quizPanel.show(m === 'learn');
    layersPanel.show(m === 'explore');
    layersPanel.sync();
  }

  // ---- Globe events -------------------------------------------------------------
  globe.on('hover', (e) => {
    const city = e.hit?.layer === cityLayer.render.id ? cityLayer.city(e.hit.id) : null;
    const name = inQuestion() ? null : city ? `${city.n}, ${countryLayer.displayName(city.c)}` : e.id ? data.meta.get(e.id)?.name : null;
    if (name) tooltip.show(name, e.x, e.y);
    else tooltip.hide();
  });
  globe.on('click', (e) => {
    const cityId = e.hit?.layer === cityLayer.render.id ? e.hit.id : null;
    if (mode === 'explore') return cityId ? selectCity(cityId) : select(e.id);
    const p = quiz.state;
    if (p.name === 'question' && p.spec.answer === 'click') quiz.answerClick({ lonLat: e.lonLat, countryId: e.id, cityId });
  });
  globe.on('dblclick', (e) => {
    if (mode === 'explore' && e.id) void globe.flyToCountry(e.id);
  });
  globe.on('render', (s) => hud.update(s));

  quiz.subscribe(() => hud.paint());
  settings.subscribe((s) => {
    globe.setHomeCountry(s.global.homeCountry);
    syncCities();
    if (quiz.state.name === 'idle' || quiz.state.name === 'summary') quizPanel.render(true);
  });

  // ---- Keyboard -------------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (settingsPanel.isOpen) {
      if (e.key === 'Escape') settingsPanel.close();
      return;
    }
    if (isTyping(e.target)) return;
    const p = quiz.state;
    if (mode === 'learn') {
      const accept = e.key === 'Enter' || e.key === ' ';
      if (p.name === 'reveal' && (accept || /^[1-4]$/.test(e.key))) {
        e.preventDefault();
        if (accept) void quiz.accept();
        else quiz.select((['again', 'hard', 'good', 'easy'] as const)[Number(e.key) - 1]!);
        return;
      }
    }
    const key = e.key.toLowerCase();
    if (key === 'h') void globe.flyHome();
    else if (key === 'l' && !inQuestion()) {
      globe.setLabelMode(globe.getLabelMode() === 'all' ? 'none' : 'all');
      layersPanel.sync();
    }
    else if (key === 'd') hud.toggle();
  });

  let initial: AppMode = 'explore';
  try {
    initial = localStorage.getItem(MODE_KEY) === 'learn' ? 'learn' : 'explore';
  } catch {
    // Storage unavailable: start in Explore.
  }
  setMode(initial);

  if (import.meta.env.DEV) {
    // Handy for poking at the API from the console and for scripted checks.
    Object.assign(window, { globe, quiz, settings, clock, cityLayer });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  document.getElementById('app')!.insertAdjacentHTML(
    'beforeend',
    `<div class="fatal overlay">Failed to start: ${String(err)}</div>`,
  );
});

/** Bottom-right zoom / home buttons. */
export function createControls(
  parent: HTMLElement,
  actions: { zoomIn(): void; zoomOut(): void; home(): void },
): HTMLElement {
  const box = document.createElement('div');
  box.className = 'controls overlay';
  const buttons: [string, string, () => void][] = [
    ['+', 'Zoom in', actions.zoomIn],
    ['−', 'Zoom out', actions.zoomOut],
    ['⌂', 'Home (H)', actions.home],
  ];
  for (const [label, title, fn] of buttons) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', fn);
    box.appendChild(b);
  }
  parent.appendChild(box);
  return box;
}

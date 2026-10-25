/** Small floating label that follows the pointer. */
export class Tooltip {
  private readonly el: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'tooltip';
    this.el.hidden = true;
    parent.appendChild(this.el);
  }

  show(text: string, x: number, y: number): void {
    this.el.textContent = text;
    this.el.hidden = false;
    this.el.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 16)}px)`;
  }

  hide(): void {
    this.el.hidden = true;
  }
}

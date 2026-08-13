export interface Size {
  width: number;
  height: number;
}

export interface ViewportOptions {
  splitRatio?: number;
  topInset?: number;
  minWidth?: number;
}

export interface ViewportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const whole = (value: number) => Math.max(0, Math.round(value));

export function calculateBrowserBounds(
  size: Size,
  options: ViewportOptions = {},
): ViewportBounds {
  const width = whole(size.width);
  const height = whole(size.height);
  const minWidth = Math.min(width, whole(options.minWidth ?? 320));
  const ratio = Math.min(0.8, Math.max(0.2, options.splitRatio ?? 0.42));
  const browserWidth = Math.min(
    width,
    Math.max(minWidth, whole(width * ratio)),
  );
  const topInset = Math.min(height, whole(options.topInset ?? 48));
  return {
    x: width - browserWidth,
    y: topInset,
    width: browserWidth,
    height: height - topInset,
  };
}

export interface NativeBrowserView {
  setBounds(bounds: ViewportBounds): void;
  setVisible(visible: boolean): void;
  setInputEnabled(enabled: boolean): void;
  focus(): void;
  destroy(): void;
}

export class BrowserViewportCoordinator {
  private visible = true;
  private inputBlocked = true;
  private destroyed = false;
  private options: ViewportOptions = {};

  constructor(private readonly view: NativeBrowserView) {}

  configure(options: ViewportOptions): void {
    this.options = { ...options };
  }

  layout(size: Size): void {
    if (this.destroyed) return;
    this.view.setBounds(calculateBrowserBounds(size, this.options));
    this.view.setVisible(this.visible);
    this.view.setInputEnabled(!this.inputBlocked);
  }

  setVisible(visible: boolean): void {
    if (this.destroyed) return;
    if (this.visible === visible) return;
    this.visible = visible;
    this.view.setVisible(visible);
  }

  beginTakeover(): void {
    if (this.destroyed) return;
    this.inputBlocked = true;
    this.view.setInputEnabled(false);
  }

  acknowledgeTakeover(): void {
    if (this.destroyed) return;
    this.inputBlocked = false;
    this.view.setInputEnabled(true);
    this.view.focus();
  }

  cancelTakeover(): void {
    if (this.destroyed) return;
    this.inputBlocked = false;
    this.view.setInputEnabled(true);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.view.destroy();
  }
}

import type { LocalDiagnostic } from "./crash-reporting.js";

type RenderProcessGoneListener = (event: unknown, details: unknown) => void;

export interface RenderProcessEventSource {
  on(
    event: "render-process-gone",
    listener: RenderProcessGoneListener,
  ): unknown;
  removeListener(
    event: "render-process-gone",
    listener: RenderProcessGoneListener,
  ): unknown;
}

export interface RenderProcessRecoveryOptions {
  browser: RenderProcessEventSource;
  trustedRenderer: RenderProcessEventSource;
  fenceBrowser(): void;
  markBrowserUnavailable(): void;
  capture(diagnostic: LocalDiagnostic): void;
  reloadTrustedRenderer(url: "village://app/"): Promise<void>;
  republishTrustedState(): void;
}

/**
 * Converts renderer loss into bounded local state. Chromium crash details are
 * deliberately ignored because they can contain local paths or page data.
 */
export class RenderProcessRecovery {
  private started = false;
  private browserUnavailable = false;
  private trustedRecovery: Promise<void> | undefined;
  private readonly additionalBrowsers = new Set<RenderProcessEventSource>();

  constructor(private readonly options: RenderProcessRecoveryOptions) {}

  private readonly browserGone: RenderProcessGoneListener = () => {
    if (!this.started || this.browserUnavailable) return;
    this.browserUnavailable = true;
    this.options.fenceBrowser();
    this.options.markBrowserUnavailable();
    this.options.capture({
      component: "BROWSER_HOST",
      code: "REMOTE_RENDERER_GONE",
      retriable: true,
    });
  };

  private readonly trustedRendererGone: RenderProcessGoneListener = () => {
    if (!this.started || this.trustedRecovery) return;
    this.options.capture({
      component: "BROWSER_HOST",
      code: "TRUSTED_RENDERER_GONE",
      retriable: true,
    });
    const recovery = this.options
      .reloadTrustedRenderer("village://app/")
      .then(() => {
        if (this.started) this.options.republishTrustedState();
      })
      .catch(() => {
        if (!this.started) return;
        this.options.capture({
          component: "BROWSER_HOST",
          code: "TRUSTED_RENDERER_RECOVERY_FAILED",
          retriable: true,
        });
      })
      .finally(() => {
        if (this.trustedRecovery === recovery) {
          this.trustedRecovery = undefined;
        }
      });
    this.trustedRecovery = recovery;
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    this.options.browser.on("render-process-gone", this.browserGone);
    this.options.trustedRenderer.on(
      "render-process-gone",
      this.trustedRendererGone,
    );
    for (const browser of this.additionalBrowsers) {
      browser.on("render-process-gone", this.browserGone);
    }
  }

  watchBrowser(browser: RenderProcessEventSource): () => void {
    if (this.additionalBrowsers.has(browser)) return () => undefined;
    this.additionalBrowsers.add(browser);
    if (this.started) browser.on("render-process-gone", this.browserGone);
    return () => {
      if (!this.additionalBrowsers.delete(browser)) return;
      if (this.started) {
        browser.removeListener("render-process-gone", this.browserGone);
      }
    };
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.options.browser.removeListener(
      "render-process-gone",
      this.browserGone,
    );
    for (const browser of this.additionalBrowsers) {
      browser.removeListener("render-process-gone", this.browserGone);
    }
    this.options.trustedRenderer.removeListener(
      "render-process-gone",
      this.trustedRendererGone,
    );
  }

  settled(): Promise<void> {
    return this.trustedRecovery ?? Promise.resolve();
  }
}

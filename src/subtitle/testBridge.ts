// testBridge.ts - lets E2E tests drive subtitle-mode internals.
// Content scripts run in an isolated world, so tests in the page's main world
// talk to them through window.postMessage. Inert unless
// chrome.storage.local.devExposeInternals === true (set only by the E2E harness).

type Handler = (payload: any) => Promise<any>;

export function installTestBridge(handlers: Record<string, Handler>): void {
  chrome.storage.local
    .get('devExposeInternals')
    .then(({ devExposeInternals }) => {
      if (devExposeInternals !== true) return;
      window.addEventListener('message', async event => {
        if (event.source !== window || typeof event.data?.astTest !== 'string') return;
        const { astTest, id, payload } = event.data;
        const handler = handlers[astTest];
        if (!handler) return;
        try {
          window.postMessage({ astTestResult: id, result: await handler(payload) }, '*');
        } catch (error) {
          window.postMessage({ astTestResult: id, error: error instanceof Error ? error.message : String(error) }, '*');
        }
      });
      document.documentElement.dataset.astTestBridge = 'ready';
    })
    .catch(() => undefined);
}

export function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    // When a newer service worker takes over (i.e. a new deploy), reload once so the page
    // on screen is the new version rather than the one it was opened with.
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  }
}

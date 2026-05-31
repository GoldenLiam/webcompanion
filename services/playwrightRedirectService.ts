const PLAYWRIGHT_EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';

export function initPlaywrightRedirect() {
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const url = changeInfo.url;
    if (url && url.startsWith(`chrome-extension://${PLAYWRIGHT_EXTENSION_ID}/`)) {
      const redirectUrl = url.replace(
        `chrome-extension://${PLAYWRIGHT_EXTENSION_ID}/`,
        `chrome-extension://${browser.runtime.id}/`
      );
      browser.tabs.update(tabId, { url: redirectUrl });
    }
  });
}

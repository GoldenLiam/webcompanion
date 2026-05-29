export function initSidePanelBehavior() {
  browser.sidePanel
    .setPanelBehavior({
      openPanelOnActionClick: false,
    })
    .catch((error) => {
      console.warn('Unable to enable side panel on action click.', error);
    });
}   
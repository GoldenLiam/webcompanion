export default defineBackground(() => {
  console.log('Hello background!', { id: browser.runtime.id });

  browser.sidePanel
    .setPanelBehavior({
      openPanelOnActionClick: true,
    })
    .catch((error) => {
      console.warn('Unable to enable side panel on action click.', error);
    });
});

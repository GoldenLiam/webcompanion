import { initSidePanelBehavior } from "@/services/panelService";

export default defineBackground(() => {
  console.log('Hello background!', { id: browser.runtime.id });

  initSidePanelBehavior();
});

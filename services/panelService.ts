import { isTabInWebbotGroup } from '@/services/tabGroupService';

const FALLBACK_POPUP_PATH = '/popup.html';

async function syncActionBehaviorForTab(tabId: number, defaultPopupPath: string) {
  try {
    const inWebbotGroup = await isTabInWebbotGroup(tabId);

    // Dynamically switch openPanelOnActionClick so Chrome handles opening natively
    await browser.sidePanel.setPanelBehavior({
      openPanelOnActionClick: inWebbotGroup,
    });

    // Per-tab popup: show popup only when tab is not in webbot group
    await browser.action.setPopup({
      tabId,
      popup: inWebbotGroup ? '' : defaultPopupPath,
    });
  } catch (error) {
    console.error('Unable to sync action behavior for tab.', tabId, error);
  }
}

export function initSidePanelBehavior() {
  const defaultPopupPath =
    browser.runtime.getManifest().action?.default_popup || FALLBACK_POPUP_PATH;

  // Initialize for all existing tabs
  browser.tabs
    .query({})
    .then((tabs) =>
      Promise.all(
        tabs
          .filter((tab) => typeof tab.id === 'number')
          .map((tab) => syncActionBehaviorForTab(tab.id!, defaultPopupPath)),
      ),
    )
    .catch(console.warn);

  // Re-sync whenever user switches tab
  browser.tabs.onActivated.addListener(({ tabId }) => {
    void syncActionBehaviorForTab(tabId, defaultPopupPath);
  });

  // Re-sync when a tab's group membership changes
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (typeof changeInfo.groupId !== 'undefined' || changeInfo.status === 'complete') {
      void syncActionBehaviorForTab(tabId, defaultPopupPath);
    }
  });
}
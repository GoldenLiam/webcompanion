const WEBBOT_GROUP_TITLE = 'webbot';

type TabShape = {
  id?: number;
  windowId?: number;
  groupId?: number;
};

export type InspectWebbotGroupResult = {
  status: 'in-group' | 'needs-move';
  message: string;
  activeTabId: number;
  targetGroupId: number;
};

function isActiveTabComplete(tab: TabShape | undefined): tab is {
  id: number;
  windowId: number;
  groupId: number;
} {
  return (
    typeof tab?.id === 'number'
    && typeof tab.windowId === 'number'
    && typeof tab.groupId === 'number'
  );
}

export async function inspectOrCreateWebbotGroupForCurrentTab(): Promise<InspectWebbotGroupResult> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const currentTab = tabs[0] as TabShape | undefined;

  if (!isActiveTabComplete(currentTab)) {
    throw new Error('Khong tim thay tab hien tai.');
  }

  const groupInCurrentWindow = (
    await browser.tabGroups.query({
      title: WEBBOT_GROUP_TITLE,
      windowId: currentTab.windowId,
    })
  )[0];

  if (!groupInCurrentWindow) {
    const newGroupId = await browser.tabs.group({ tabIds: currentTab.id });
    await browser.tabGroups.update(newGroupId, {
      title: WEBBOT_GROUP_TITLE,
    });

    return {
      status: 'in-group',
      message: 'Da tao group webbot va them tab hien tai vao group.',
      activeTabId: currentTab.id,
      targetGroupId: newGroupId,
    };
  }

  if (currentTab.groupId === groupInCurrentWindow.id) {
    return {
      status: 'in-group',
      message: 'Tab hien tai da nam trong group webbot.',
      activeTabId: currentTab.id,
      targetGroupId: groupInCurrentWindow.id,
    };
  }

  return {
    status: 'needs-move',
    message: 'Tab hien tai chua nam trong group webbot.',
    activeTabId: currentTab.id,
    targetGroupId: groupInCurrentWindow.id,
  };
}

export async function moveTabToWebbotGroup(tabId: number, groupId: number): Promise<string> {
  await browser.tabs.group({
    groupId,
    tabIds: tabId,
  });

  return 'Da di chuyen tab hien tai vao group webbot.';
}

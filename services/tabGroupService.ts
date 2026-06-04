const WEBBOT_GROUP_TITLE = 'webbot';
const WEBBOT_GROUP_COLOR = 'blue';

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
    throw new Error('Không tìm thấy tab hiện tại.');
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
      color: WEBBOT_GROUP_COLOR,
    });

    return {
      status: 'in-group',
      message: 'Đã tạo group webbot và thêm tab hiện tại vào group.',
      activeTabId: currentTab.id,
      targetGroupId: newGroupId,
    };
  }

  if (currentTab.groupId === groupInCurrentWindow.id) {
    return {
      status: 'in-group',
      message: 'Tab hiện tại đã nằm trong group webbot.',
      activeTabId: currentTab.id,
      targetGroupId: groupInCurrentWindow.id,
    };
  }

  return {
    status: 'needs-move',
    message: 'Tab hiện tại chưa nằm trong group webbot.',
    activeTabId: currentTab.id,
    targetGroupId: groupInCurrentWindow.id,
  };
}

export async function moveTabToWebbotGroup(tabId: number, groupId: number): Promise<string> {
  await browser.tabs.group({
    groupId,
    tabIds: tabId,
  });

  return 'Đã di chuyển tab hiện tại vào group webbot.';
}

export async function isTabInWebbotGroup(tabId: number): Promise<boolean> {
  const tab = (await browser.tabs.get(tabId)) as TabShape;

  if (!isActiveTabComplete(tab)) {
    return false;
  }

  const groupInCurrentWindow = (
    await browser.tabGroups.query({
      title: WEBBOT_GROUP_TITLE,
      windowId: tab.windowId,
    })
  )[0];

  if (!groupInCurrentWindow) {
    return false;
  }

  return tab.groupId === groupInCurrentWindow.id;
}

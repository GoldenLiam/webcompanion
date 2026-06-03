declare const chrome: any;

// Tên của Tab Group dùng chung giữa WXT Extension và Playwright
const PLAYWRIGHT_GROUP_TITLE = 'webbot';

// Danh sách các schema URL không thể bật Debugger (chrome://, edge://, devtools://, etc.)
const NON_DEBUGGABLE_SCHEMES = ['chrome:', 'edge:', 'devtools:'];

// Biến cờ (flag) để xác định xem Extension đang trong quá trình khởi tạo (startup) hay không.
let isInitializing = true;

// Tab ID gốc mà Playwright kết nối đến đầu tiên.
// Dùng để đánh lừa Playwright (cdpRelay) rằng mọi tab khác trong group đều là "con" của tab này,
// từ đó Playwright mới đưa các tab này vào chung một BrowserContext (context.pages()).
let primaryTabId: number | undefined = undefined;

/**
 * Kiểm tra xem một URL có hợp lệ để kết nối Debugger hay không.
 */
function isNonDebuggableUrl(url?: string) {
  return !!url && NON_DEBUGGABLE_SCHEMES.some((s) => url.startsWith(s));
}

export function initPlaywrightInterceptor() {
  const onUpdatedListeners = new Set<any>();
  const listenerMap = new Map<any, any>();

  // Đánh chặn hàm addListener của chrome.tabs.onUpdated để chèn openerTabId
  const originalAddListener = chrome.tabs.onUpdated.addListener;
  chrome.tabs.onUpdated.addListener = function (listener: any) {
    const wrappedListener = function (tabId: number, changeInfo: any, tab: any) {
      let modifiedTab = tab;
      // Nếu tab không có openerTabId (do người dùng kéo thả thủ công)
      // Ta sẽ gán ép nó làm con của primaryTabId để Playwright MCP không bỏ qua tab này.
      if (tab && !tab.openerTabId && primaryTabId && tab.id !== primaryTabId) {
        modifiedTab = { ...tab, openerTabId: primaryTabId };
      }
      return listener(tabId, changeInfo, modifiedTab);
    };
    listenerMap.set(listener, wrappedListener);
    onUpdatedListeners.add(wrappedListener);
    originalAddListener.call(chrome.tabs.onUpdated, wrappedListener);
  };

  // Đánh chặn hàm removeListener để dọn dẹp bộ nhớ
  const originalRemoveListener = chrome.tabs.onUpdated.removeListener;
  chrome.tabs.onUpdated.removeListener = function (listener: any) {
    const wrappedListener = listenerMap.get(listener);
    if (wrappedListener) {
      onUpdatedListeners.delete(wrappedListener);
      originalRemoveListener.call(chrome.tabs.onUpdated, wrappedListener);
      listenerMap.delete(listener);
    } else {
      originalRemoveListener.call(chrome.tabs.onUpdated, listener);
    }
  };

  // Đánh chặn hàm chrome.tabs.group
  const originalGroup = chrome.tabs.group;
  chrome.tabs.group = async function (options: any) {
    if (options && options.groupId === undefined) {
      const tabIds = Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds];
      const firstTabId = tabIds[0];

      if (typeof firstTabId === 'number') {
        // Lưu lại tab đầu tiên làm tab gốc (primary) cho context
        primaryTabId = firstTabId;

        try {
          const tab = await chrome.tabs.get(firstTabId);
          const existingGroups = await chrome.tabGroups.query({
            title: PLAYWRIGHT_GROUP_TITLE,
            windowId: tab.windowId,
          });

          if (existingGroups.length > 0) {
            const groupId = existingGroups[0].id;

            // Đưa tab mới vào group "webbot" hiện có
            await originalGroup.call(chrome.tabs, { groupId, tabIds: options.tabIds });

            // Đợi Playwright kết nối hoàn tất, sau đó gửi sự kiện cho các tab có sẵn
            setTimeout(async () => {
              try {
                const existingTabs = await chrome.tabs.query({ groupId });

                for (const t of existingTabs) {
                  if (!tabIds.includes(t.id!) && t.id !== undefined && !isNonDebuggableUrl(t.url)) {
                    // Gán openerTabId để Playwright nhận diện tab này thuộc context
                    const fakeTab = { ...t, openerTabId: primaryTabId };

                    for (const listener of onUpdatedListeners) {
                      try {
                        listener(t.id, { groupId }, fakeTab);
                      } catch (e) {
                        console.error('[Interceptor] Lỗi:', e);
                      }
                    }
                  }
                }
              } catch (error) {
                console.error('[Interceptor] Lỗi truy vấn tab cũ:', error);
              }
            }, 1500);

            return groupId;
          }
        } catch (error) {
          console.error('[Interceptor] Lỗi chrome.tabs.group:', error);
        }
      }
    }
    return originalGroup.call(chrome.tabs, options);
  };

  // Đánh chặn hàm chrome.tabs.ungroup
  const originalUngroup = chrome.tabs.ungroup;
  chrome.tabs.ungroup = async function (tabIds: any) {
    const stack = new Error().stack || '';
    if (isInitializing || stack.includes('_onConnectionClose')) {
      console.log('[Interceptor] Đã chặn rã nhóm.');
      return;
    }
    return originalUngroup.call(chrome.tabs, tabIds);
  };
}

export function markPlaywrightInitialized() {
  isInitializing = false;
}

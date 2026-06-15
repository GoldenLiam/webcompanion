async function autoConnectToPlaywright() {
  const params = new URLSearchParams(window.location.search);
  const relayUrl = params.get("mcpRelayUrl");
  const parsedVersion = parseInt(params.get("protocolVersion") ?? "", 10);
  const requestedVersion = isNaN(parsedVersion) ? 1 : parsedVersion;
  
  let clientName = "Playwright Agent";
  const clientParam = params.get("client");
  if (clientParam) {
    try {
      clientName = JSON.parse(clientParam).name || "Playwright Agent";
    } catch (e) {
      console.error("Không thể parse thông tin client:", e);
    }
  }

  if (!relayUrl) {
    console.error("Không tìm thấy mcpRelayUrl trên URL.");
    return;
  }

  try {
    const connResponse = await browser.runtime.sendMessage({
      type: "connectionRequested",
      mcpRelayUrl: relayUrl,
      protocolVersion: requestedVersion
    });

    if (!connResponse.success) {
      console.error("Background không thể kết nối tới MCP Relay:", connResponse.error);
      return;
    }

    const tabsResponse = await browser.runtime.sendMessage({ type: "getTabs" });
    
    if (tabsResponse.success && tabsResponse.tabs && tabsResponse.tabs.length > 0) {
      let targetTab = null;

      // 1. Tìm tab đang active/focused được lưu trong localStorage (khi người dùng click popup kết nối)
      const lastActiveTabId = Number(localStorage.getItem('lastActiveTabId'));
      if (lastActiveTabId) {
        targetTab = tabsResponse.tabs.find((t: any) => t.id === lastActiveTabId);
      }

      // 2. Nếu không tìm thấy trong localStorage, tìm tab đang active/focused trong danh sách tab hiện có
      if (!targetTab) {
        targetTab = tabsResponse.tabs.find((t: any) => t.active === true);
      }

      // 3. Nếu không tìm thấy tab active, ưu tiên chọn tab đang nằm trong group "webbot"
      if (!targetTab) {
        try {
          const groups = await browser.tabGroups.query({ title: "webbot" });
          if (groups.length > 0) {
            const webbotGroupId = groups[0].id;
            const groupTab = tabsResponse.tabs.find((t: any) => t.groupId === webbotGroupId);
            if (groupTab) {
              targetTab = groupTab;
            }
          }
        } catch (e) {
          console.warn("Không thể truy vấn group webbot:", e);
        }
      }

      // 4. Fallback cuối cùng nếu không tìm thấy tab nào phù hợp
      if (!targetTab) {
        targetTab = tabsResponse.tabs[0];
      }

      const finalResponse = await browser.runtime.sendMessage({
        type: "connectToTab",
        tab: targetTab,
        clientName: clientName
      });

      if (finalResponse?.success) {
        const rootEl = document.getElementById("root");
        if (rootEl) {
          rootEl.innerHTML = `<h3 style="color: #4CAF50; font-family: sans-serif; text-align: center; margin-top: 50px;">
            ✓ Đã kết nối tự động thành công với Webb companion! Giao diện đang được điều khiển...
          </h3>`;
        }
      }
    } else {
      console.error("Không tìm thấy Tab nào hợp lệ để điều khiển.");
    }

  } catch (error) {
    console.error("Lỗi trong quá trình tự động kết nối:", error);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  autoConnectToPlaywright();

  setInterval(() => {
    browser.runtime.sendMessage({ type: "keepalive" }).catch(() => {});
  }, 2e4);
});
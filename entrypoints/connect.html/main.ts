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
      // Ưu tiên chọn tab đang nằm trong group "webbot" thay vì lấy tabs[0] mù quáng.
      // Nếu không tìm thấy tab nào trong group, fallback về tab đầu tiên.
      let targetTab = tabsResponse.tabs[0];
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
        console.warn("Không thể truy vấn group webbot, sử dụng tab mặc định:", e);
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
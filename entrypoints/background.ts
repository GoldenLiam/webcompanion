import { initSidePanelBehavior } from "@/services/panelService";
import { initPlaywrightRedirect } from "@/services/playwrightRedirectService";

export default defineBackground(() => {
  console.log('Hello background!', { id: browser.runtime.id });

  initSidePanelBehavior();
  initPlaywrightRedirect();

  // @ts-ignore: Bỏ qua kiểm tra lỗi thiếu file khai báo loại dữ liệu cho file mjs
  import('../services/playwrightBackground.mjs');

});

import { initSidePanelBehavior } from "@/services/panelService";
import { initPlaywrightRedirect } from "@/services/playwrightRedirectService";
import { initPlaywrightInterceptor, markPlaywrightInitialized } from "@/services/playwrightInterceptorService";

export default defineBackground(() => {
  console.log('Hello background!', { id: browser.runtime.id });

  initPlaywrightInterceptor();
  initSidePanelBehavior();
  initPlaywrightRedirect();

  // @ts-ignore: Bỏ qua kiểm tra lỗi thiếu file khai báo loại dữ liệu cho file mjs
  import('../services/playwrightBackground.mjs').then(() => {
    markPlaywrightInitialized();
  });

});

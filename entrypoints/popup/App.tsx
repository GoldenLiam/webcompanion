import { useEffect, useState } from 'react';
import './App.css';
import { Alert, Button, Spin, Typography, ConfigProvider } from 'antd';
import { MessageOutlined, LoadingOutlined } from '@ant-design/icons';
import {
  moveTabToWebbotGroup,
} from '@/services/tabGroupService';

type ViewState = 'loading' | 'needs-move' | 'in-group' | 'error';

function App() {
  const [viewState, setViewState] = useState<ViewState>('loading');
  const [message, setMessage] = useState('');
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [targetGroupId, setTargetGroupId] = useState<number | null>(null);
  const [isMoving, setIsMoving] = useState(false);

  const openCurrentWindowSidePanel = async () => {
    try {
      if (!browser.sidePanel?.open) {
        return false;
      }

      const currentWindow = await browser.windows.getCurrent();

      if (typeof currentWindow.id !== 'number') {
        return false;
      }

      await browser.sidePanel.open({ windowId: currentWindow.id });
      window.close();
      return true;
    } catch (error) {
      console.error('Khong the mo side panel.', error);
      return false;
    }
  };

  const inspectCurrentTab = async () => {
    setViewState('loading');
    setMessage('Đang kiểm tra tab group...');

    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const currentTab = tabs[0];
      if (!currentTab || typeof currentTab.id !== 'number' || typeof currentTab.windowId !== 'number') {
        throw new Error('Không tìm thấy tab hiện tại.');
      }

      // Lưu ID tab hiện tại để trang kết nối biết tab nào cần điều khiển
      localStorage.setItem('lastActiveTabId', String(currentTab.id));

      const existingGroups = await browser.tabGroups.query({
        title: 'webbot',
        windowId: currentTab.windowId,
      });

      if (existingGroups.length > 0) {
        const groupId = existingGroups[0].id;
        setActiveTabId(currentTab.id);
        setTargetGroupId(groupId);

        if (currentTab.groupId === groupId) {
          if (await openCurrentWindowSidePanel()) {
            return;
          }
          setViewState('in-group');
          setMessage('Tab hiện tại đã nằm trong group webbot.');
        } else {
          setViewState('needs-move');
          setMessage('Tab hiện tại chưa nằm trong group webbot.');
        }
      } else {
        setViewState('loading');
        setMessage('Không tìm thấy nhóm webbot. Đang kết nối tới Webbot socket để kích hoạt...');

        const ws = new WebSocket('ws://localhost:8080');

        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: 'playwright_navigate',
            url: currentTab.url || 'https://google.com'
          }));
          setMessage('Đã kết nối tới Webbot. Đang khởi chạy Tab Group...');
          // setTimeout(() => {
          //   window.close();
          // }, 2500);
        };

        ws.onerror = () => {
          setViewState('error');
          setMessage('Không thể kết nối tới Webbot server (ws://localhost:8080). Vui lòng chạy ứng dụng Webbot trước.');
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Không thể xử lý tab group lúc này.';
      setViewState('error');
      setMessage(errorMessage);
    }
  };

  const moveCurrentTabToWebbotGroup = async () => {
    if (activeTabId === null || targetGroupId === null) {
      return;
    }

    setIsMoving(true);
    try {
      const successMessage = await moveTabToWebbotGroup(activeTabId, targetGroupId);

      if (await openCurrentWindowSidePanel()) {
        return;
      }

      setViewState('in-group');
      setMessage(successMessage);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Di chuyen tab that bai.';
      setViewState('error');
      setMessage(errorMessage);
    } finally {
      setIsMoving(false);
    }
  };

  useEffect(() => {
    void inspectCurrentTab();
  }, []);

  return (
    <ConfigProvider
      theme={{
        token: {
          colorSuccess: '#10b981',
          colorWarning: '#f59e0b',
          colorError: '#ef4444',
          borderRadius: 12,
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
        components: {
          Button: {
            controlHeight: 38,
            fontWeight: 600,
          },
          Alert: {
            borderRadiusLG: 12,
          },
        },
      }}
    >
      <main className="popup-root">
        <div className="header-container">
          <div className="logo-wrapper">
            <img src="/icon/128.png" className="logo-img" alt="Webbot Icon" />
          </div>
          <div className="header-text-wrap">
            <Typography.Title level={4} className="title-text">
              Webbot
            </Typography.Title>
            <span className="subtitle-badge">Companion</span>
          </div>
        </div>

        <div className="content-card">
          {viewState === 'loading' && (
            <div className="loading-wrap">
              <Spin indicator={<LoadingOutlined style={{ fontSize: 22 }} spin />} />
              <Typography.Text className="status-message">{message}</Typography.Text>
            </div>
          )}

          {viewState === 'in-group' && (
            <div className="action-wrap">
              <Alert
                type="success"
                message={message}
                showIcon
              />
              <Button
                type="primary"
                icon={<MessageOutlined />}
                onClick={() => void openCurrentWindowSidePanel()}
                className="action-button hover-lift"
                block
              >
                Mở Chat
              </Button>
            </div>
          )}

          {viewState === 'needs-move' && (
            <div className="action-wrap">
              <Alert
                type="warning"
                message="Tab chưa ở trong group"
                description={message}
                showIcon
              />
              <Button
                type="primary"
                loading={isMoving}
                onClick={() => void moveCurrentTabToWebbotGroup()}
                className="action-button hover-lift"
                block
              >
                Di chuyển vào nhóm webbot
              </Button>
            </div>
          )}

          {viewState === 'error' && (
            <div className="action-wrap">
              <Alert
                type="error"
                message="Đã xảy ra lỗi"
                description={message}
                showIcon
              />
              <Button
                type="primary"
                onClick={() => void inspectCurrentTab()}
                className="action-button hover-lift"
                block
              >
                Thử lại
              </Button>
            </div>
          )}
        </div>
      </main>
    </ConfigProvider>
  );
}

export default App;

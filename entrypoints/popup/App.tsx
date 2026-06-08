import { useEffect, useState } from 'react';
import './App.css';
import { Alert, Button, Spin, Typography } from 'antd';
import { MessageOutlined } from '@ant-design/icons';
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
          setTimeout(() => {
            window.close();
          }, 2500);
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
    <main className="popup-root">
      <Typography.Title level={4} className="title">
        Webbot
      </Typography.Title>

      {viewState === 'loading' && (
        <div className="loading-wrap">
          <Spin size="small" />
          <Typography.Text>{message}</Typography.Text>
        </div>
      )}

      {viewState === 'in-group' && (
        <div className="action-wrap">
          <Alert
            type="success"
            title={message}
            showIcon
          />
          <Button type="primary" icon={<MessageOutlined />} onClick={() => void openCurrentWindowSidePanel()}>
            Mở Chat
          </Button>
        </div>
      )}

      {viewState === 'needs-move' && (
        <div className="action-wrap">
          <Alert
            type="warning"
            title="Tab hiện tại không thể truy cập"
            description={message}
            showIcon
          />
          <Button type="primary" loading={isMoving} onClick={() => void moveCurrentTabToWebbotGroup()}>
            Di chuyển tab hiện tại vào nhóm webbot
          </Button>
        </div>
      )}

      {viewState === 'error' && (
        <Alert
          type="error"
          title="Đã xảy ra lỗi"
          description={message}
          showIcon
        />
      )}
    </main>
  );
}

export default App;

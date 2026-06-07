import { useEffect, useState } from 'react';
import './App.css';
import { Alert, Button, Spin, Typography } from 'antd';
import { MessageOutlined } from '@ant-design/icons';
import {
  inspectOrCreateWebbotGroupForCurrentTab,
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
    setMessage('Dang kiem tra tab group...');

    try {
      const result = await inspectOrCreateWebbotGroupForCurrentTab();
      setActiveTabId(result.activeTabId);
      setTargetGroupId(result.targetGroupId);

      if (result.status === 'in-group' && await openCurrentWindowSidePanel()) {
        return;
      }

      setViewState(result.status);
      setMessage(result.message);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Khong the xu ly tab group luc nay.';
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
        Webbot Tab Group
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
            message={message}
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
            message="Can di chuyen tab vao group webbot"
            description={message}
            showIcon
          />
          <Button type="primary" loading={isMoving} onClick={() => void moveCurrentTabToWebbotGroup()}>
            Di chuyen tab hien tai vao webbot
          </Button>
        </div>
      )}

      {viewState === 'error' && (
        <Alert
          type="error"
          message="Khong the xu ly tab group"
          description={message}
          showIcon
        />
      )}
    </main>
  );
}

export default App;

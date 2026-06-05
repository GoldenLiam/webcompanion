import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Button, Input, message } from 'antd';
import {
  EditOutlined,
  MoreOutlined,
  CloseOutlined,
  PlusOutlined,
  AimOutlined,
  DownOutlined,
  UpOutlined,
  GlobalOutlined,
  SendOutlined,
} from '@ant-design/icons';
import './App.css';

type Message = {
  id: number;
  role: 'assistant' | 'user';
  title: string;
  content: string;
};

const initialMessages: Message[] = [
  {
    id: 1,
    role: 'assistant',
    title: 'WebCompanion',
    content:
      'Tôi có thể tóm tắt trang, giải thích nội dung đang mở, hoặc gợi ý bước tiếp theo ngay trong side panel.',
  },
  {
    id: 2,
    role: 'user',
    title: 'Bạn',
    content: 'Hãy giúp tôi hiểu nhanh trang này đang nói về gì.',
  },
  {
    id: 3,
    role: 'assistant',
    title: 'WebCompanion',
    content:
      'Tôi sẽ đọc tiêu đề, các heading chính và những khối nội dung nổi bật để tạo bản tóm tắt ngắn, rồi bạn có thể mở rộng nếu cần.',
  },
];

const suggestions = [
  'Tóm tắt trang này',
  'Giải thích đoạn đang chọn',
  'Soạn câu trả lời ngắn',
  'Đề xuất bước tiếp theo',
];

// Custom SVGs matching Copilot style
const SidebarIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ display: 'block' }}
  >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18" />
  </svg>
);

const AISparklesIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    style={{ display: 'block' }}
  >
    <path
      d="M10 2C10 2 10.5 6.5 12 8C13.5 9.5 18 10 18 10C18 10 13.5 10.5 12 12C10.5 13.5 10 18 10 18C10 18 9.5 13.5 8 12C6.5 10.5 2 10 2 10C2 10 6.5 9.5 8 8C9.5 6.5 10 2 10 2Z"
      fill="white"
    />
    <path
      d="M19 13C19 13 19.3 15.3 20 16C20.7 16.7 23 17 23 17C23 17 20.7 17.3 20 18C19.3 18.7 19 21 19 21C19 21 18.7 18.7 18 18C17.3 17.3 15 17 15 17C15 17 17.3 16.7 18 16C18.7 15.3 19 13 19 13Z"
      fill="white"
    />
  </svg>
);

function App() {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [isPickingElement, setIsPickingElement] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of messages container
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Listen for message from page content script
  useEffect(() => {
    const handleRuntimeMessage = (msg: any) => {
      if (msg.type === 'ELEMENT_PICKED_RESULT') {
        setIsPickingElement(false);
        const { selector, text } = msg;
        if (text) {
          setDraft((prev) => {
            const prefix = prev ? `${prev}\n` : '';
            return `${prefix}[Trích dẫn: "${text}" | Selector: ${selector}]`;
          });
          void message.success('Đã chọn phần tử thành công!');
        } else {
          void message.warning('Phần tử được chọn không có nội dung chữ.');
        }
      } else if (msg.type === 'ELEMENT_PICKED_CANCEL') {
        setIsPickingElement(false);
        void message.warning('Đã hủy chọn phần tử.');
      }
    };

    browser.runtime.onMessage.addListener(handleRuntimeMessage);
    return () => {
      browser.runtime.onMessage.removeListener(handleRuntimeMessage);
    };
  }, []);

  const handleStartPicker = async () => {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];
      if (!activeTab?.id) {
        void message.error('Không tìm thấy trang web đang hoạt động.');
        return;
      }

      // Check if page is restricted
      const url = activeTab.url || '';
      if (
        url.startsWith('chrome://') ||
        url.startsWith('edge://') ||
        url.startsWith('about:') ||
        url.startsWith('browser://') ||
        url.startsWith('chrome-extension://')
      ) {
        void message.error('Không thể sử dụng công cụ chọn trên các trang hệ thống.');
        return;
      }

      setIsPickingElement(true);
      await browser.tabs.sendMessage(activeTab.id, { type: 'START_ELEMENT_PICKER' });
      void message.info('Đang bật chế độ chọn phần tử. Di chuột và nhấp vào một vùng trên trang web.');
    } catch (err) {
      console.error('Error starting element picker:', err);
      setIsPickingElement(false);
      void message.error('Không thể khởi chạy bộ chọn phần tử. Vui lòng tải lại trang và thử lại.');
    }
  };

  const handleCancelPickerInPanel = async () => {
    setIsPickingElement(false);
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        await browser.tabs.sendMessage(tabs[0].id, { type: 'CANCEL_PICKER' });
      }
    } catch (err) {
      console.error('Error canceling picker:', err);
    }
  };

  const sendMessage = (text: string) => {
    const content = text.trim();

    if (!content) {
      return;
    }

    const timestamp = Date.now();

    setMessages((currentMessages) => [
      ...currentMessages,
      {
        id: timestamp,
        role: 'user',
        title: 'Bạn',
        content,
      },
      {
        id: timestamp + 1,
        role: 'assistant',
        title: 'WebCompanion',
        content:
          'Tôi đã nhận yêu cầu. Nếu bạn muốn, tôi có thể viết tiếp phần giải thích, trích ý chính hoặc tạo câu trả lời ngắn hơn.',
      },
    ]);
    setDraft('');
  };

  const handleNewChat = () => {
    setMessages([]);
  };

  return (
    <div className="copilot-sidebar">
      {/* Header section */}
      <header className="copilot-header">
        <div className="header-left">
          <Button
            type="text"
            icon={<SidebarIcon />}
            className="header-btn"
            title="Đóng sidebar"
          />
          <Button
            type="text"
            icon={<EditOutlined />}
            className="header-btn"
            title="Trò chuyện mới"
            onClick={handleNewChat}
          />
        </div>
        <div className="header-right">
          <Button
            type="text"
            icon={<MoreOutlined />}
            className="header-btn"
            title="Tùy chọn khác"
          />
          <Button
            type="text"
            icon={<CloseOutlined />}
            className="header-btn"
            title="Đóng"
          />
        </div>
      </header>

      {/* Main scrollable body */}
      <div className="copilot-content-scroll" ref={scrollRef}>
        {/* Welcome message */}
        <div className="copilot-welcome">
          <h1 className="welcome-title">Này Thắng, hôm nay bạn đang nghĩ gì thế?</h1>
        </div>

        {/* Message streams */}
        <div className="copilot-chat-stream">
          {messages.map((message) => (
            <div key={message.id} className={`copilot-msg-row ${message.role}`}>
              {message.role === 'assistant' && (
                <Avatar
                  className="copilot-avatar"
                  icon={<AISparklesIcon />}
                />
              )}
              <div className="copilot-msg-bubble">
                {message.role === 'assistant' && (
                  <div className="copilot-msg-sender">{message.title}</div>
                )}
                <div className="copilot-msg-text">{message.content}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer input and actions */}
      <footer className="copilot-footer">
        {/* Suggestion row */}
        {suggestions.length > 0 && (
          <div className="copilot-suggestions">
            {suggestions.map((item) => (
              <button
                key={item}
                className="copilot-suggestion-chip"
                onClick={() => sendMessage(item)}
              >
                {item}
              </button>
            ))}
          </div>
        )}

        {/* Current Active Context Tab Bar */}
        <div className="copilot-context-capsule">
          <div className="context-left">
            <span className="context-icon-wrapper">
              <GlobalOutlined style={{ color: '#2563eb' }} />
            </span>
            <span className="context-title">AI ChatHub - Microsoft Edge Addons</span>
            <span className="context-extra">+4 tab</span>
          </div>
          <UpOutlined className="context-expand-icon" />
        </div>

        {/* Composer Chat Input area */}
        {isPickingElement && (
          <div className="copilot-picker-banner">
            <span>Đang chọn phần tử trên trang...</span>
            <Button
              size="small"
              type="text"
              onClick={handleCancelPickerInPanel}
              style={{ color: '#ef4444', fontWeight: 600, padding: '0 4px', height: 'auto' }}
            >
              Hủy
            </Button>
          </div>
        )}
        <div className="copilot-composer">
          <Input.TextArea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage(draft);
              }
            }}
            placeholder="Nhắn tin cho Copilot hoặc @ đề cập đến một tab"
            autoSize={{ minRows: 1, maxRows: 5 }}
            className="copilot-input"
          />
          <div className="copilot-composer-actions">
            <div className="actions-left">
              <Button
                type="text"
                shape="circle"
                icon={<PlusOutlined />}
                className="composer-action-btn"
                title="Đính kèm tệp"
              />
              <div className="copilot-mode-selector">
                <span>Smart</span>
                <DownOutlined style={{ fontSize: '9px' }} />
              </div>
            </div>
            <div className="actions-right">
              {draft.trim() ? (
                <Button
                  type="text"
                  shape="circle"
                  icon={<SendOutlined />}
                  className="composer-action-btn send"
                  title="Gửi tin nhắn"
                  onClick={() => sendMessage(draft)}
                />
              ) : (
                <Button
                  type="text"
                  shape="circle"
                  icon={<AimOutlined />}
                  className={`composer-action-btn picker ${isPickingElement ? 'active' : ''}`}
                  title="Chọn phần tử trên trang"
                  onClick={handleStartPicker}
                />
              )}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
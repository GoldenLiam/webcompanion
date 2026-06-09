import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Button, Select, Dropdown, message } from 'antd';
import type { MenuProps } from 'antd';
import {
  PlusOutlined,
  AimOutlined,
  DownOutlined,
  UpOutlined,
  GlobalOutlined,
  SendOutlined,
  UploadOutlined,
  FormOutlined,
  PushpinOutlined,
  CopyOutlined,
  CheckOutlined,
} from '@ant-design/icons';
import { socketService } from '@/services/socketService';
import MarkdownIt from 'markdown-it';
import { RichComposer, RichComposerRef } from '../../components/RichComposer';
import './App.css';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
});

const renderMessageContent = (content: string) => {
  let html = md.render(content).trim();
  // Replace Tab format
  html = html.replace(
    /\[Tab đính kèm: &quot;([^&]+)&quot; \| Link: ([^\]]+)\]/g,
    '<span class="mention-tab-pill readonly">@$1</span>'
  );
  html = html.replace(
    /\[Tab đính kèm: "([^"]+)" \| Link: ([^\]]+)\]/g,
    '<span class="mention-tab-pill readonly">@$1</span>'
  );
  // Replace Element format
  html = html.replace(
    /\[Phần tử được chọn \| Selector: &quot;([^&]+)&quot; \| Nội dung chữ: &quot;([^\]]*)&quot;\]/g,
    '<span class="mention-element-pill readonly">#$1</span>'
  );
  html = html.replace(
    /\[Phần tử được chọn \| Selector: "([^"]+)" \| Nội dung chữ: "([^\]]*)"\]/g,
    '<span class="mention-element-pill readonly">#$1</span>'
  );
  return html;
};

type Attachment = {
  type: 'element' | 'tab';
  id: string;
  title: string;
  value: string;
  extraText?: string;
};

type Message = {
  id: number;
  role: 'assistant' | 'user';
  title: string;
  content: string;
  attachments?: Attachment[];
  toolCalls?: {
    name: string;
    input?: string;
    status: 'running' | 'completed' | 'error';
    output?: string;
    error?: string;
  }[];
};

const initialMessages: Message[] = [];

const suggestions = [
  'Tóm tắt trang này',
  'Đề xuất bước tiếp theo',
];


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

const ToolCallItem = ({ toolCall }: { toolCall: NonNullable<Message['toolCalls']>[number] }) => {
  const [expanded, setExpanded] = useState(false);

  const getStatusIcon = () => {
    switch (toolCall.status) {
      case 'running':
        return <span className="tool-status-dot running" />;
      case 'completed':
        return <span className="tool-status-dot completed">✓</span>;
      case 'error':
        return <span className="tool-status-dot error">✗</span>;
    }
  };

  const getStatusText = () => {
    switch (toolCall.status) {
      case 'running':
        return 'Đang gọi...';
      case 'completed':
        return 'Hoàn thành';
      case 'error':
        return 'Gặp lỗi';
    }
  };

  return (
    <div className={`tool-call-item ${toolCall.status}`}>
      <div className="tool-call-header" onClick={() => setExpanded(!expanded)}>
        <div className="tool-call-header-left">
          {getStatusIcon()}
          <span className="tool-name">{toolCall.name}</span>
        </div>
        <div className="tool-call-header-right">
          <span className="tool-status-text">{getStatusText()}</span>
          {expanded ? <UpOutlined style={{ fontSize: '10px' }} /> : <DownOutlined style={{ fontSize: '10px' }} />}
        </div>
      </div>
      {expanded && (
        <div className="tool-call-details">
          {toolCall.input && (
            <div className="tool-detail-section">
              <div className="tool-detail-label">Tham số đầu vào:</div>
              <pre className="tool-detail-code">{toolCall.input}</pre>
            </div>
          )}
          {toolCall.status === 'completed' && toolCall.output && (
            <div className="tool-detail-section">
              <div className="tool-detail-label">Kết quả trả về:</div>
              <pre className="tool-detail-code">{toolCall.output}</pre>
            </div>
          )}
          {toolCall.status === 'error' && toolCall.error && (
            <div className="tool-detail-section error">
              <div className="tool-detail-label">Chi tiết lỗi:</div>
              <pre className="tool-detail-code">{toolCall.error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function App() {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [isPickingElement, setIsPickingElement] = useState(false);
  const [copiedId, setCopiedId] = useState<number | string | null>(null);

  const handleCopy = async (text: string, id: number | string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      void message.success('Đã sao chép vào bộ nhớ tạm!');
      setTimeout(() => {
        setCopiedId(null);
      }, 2000);
    } catch (err) {
      console.error('Không thể sao chép văn bản:', err);
      void message.error('Sao chép thất bại.');
    }
  };
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const [isStreaming, setIsStreaming] = useState(false);
  const [models, setModels] = useState<any[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [activeTool, setActiveTool] = useState<{ name: string; input?: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [tabsList, setTabsList] = useState<any[]>([]);
  const [currentTab, setCurrentTab] = useState<any | null>(null);
  const [isContextExpanded, setIsContextExpanded] = useState(false);

  const composerRef = useRef<RichComposerRef>(null);
  const [isComposerEmpty, setIsComposerEmpty] = useState(true);

  const handleActivateTab = async (tabId: number | undefined) => {
    if (typeof tabId !== 'number') return;
    try {
      await browser.tabs.update(tabId, { active: true });
    } catch (err) {
      console.error('Không thể kích hoạt tab:', err);
    }
  };

  const handlePinTab = (tab: any) => {
    if (composerRef.current) {
      composerRef.current.insertTab({
        id: tab.id || Date.now(),
        title: tab.title || 'Tab',
        url: tab.url,
      });
      void message.success(`Đã đính kèm tab: ${tab.title}`);
    }
  };

  useEffect(() => {
    const updateTabs = async () => {
      try {
        const currentWindow = await browser.windows.getCurrent();
        if (typeof currentWindow.id !== 'number') return;

        const groups = await browser.tabGroups.query({
          title: 'webbot',
          windowId: currentWindow.id,
        });
        const webbotGroup = groups[0];

        const allTabs = await browser.tabs.query({ currentWindow: true });
        const activeTab = allTabs.find(t => t.active);

        const groupTabs = webbotGroup
          ? allTabs.filter((t) => t.groupId === webbotGroup.id)
          : [];
        setTabsList(groupTabs);

        let displayTab = null;
        if (activeTab && webbotGroup && activeTab.groupId === webbotGroup.id) {
          displayTab = activeTab;
        } else if (groupTabs.length > 0) {
          displayTab = groupTabs[0];
        } else {
          displayTab = activeTab || null;
        }
        setCurrentTab(displayTab);
      } catch (err) {
        console.error('Lỗi khi lấy danh sách tab:', err);
      }
    };

    void updateTabs();

    const handleTabEvent = () => {
      void updateTabs();
    };

    browser.tabs.onCreated.addListener(handleTabEvent);
    browser.tabs.onRemoved.addListener(handleTabEvent);
    browser.tabs.onUpdated.addListener(handleTabEvent);
    browser.tabs.onActivated.addListener(handleTabEvent);

    return () => {
      browser.tabs.onCreated.removeListener(handleTabEvent);
      browser.tabs.onRemoved.removeListener(handleTabEvent);
      browser.tabs.onUpdated.removeListener(handleTabEvent);
      browser.tabs.onActivated.removeListener(handleTabEvent);
    };
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (composerRef.current) {
        composerRef.current.insertText(`[Tải lên file: "${file.name}"]`);
        void message.success(`Đã tải lên file: ${file.name}`);
      }
      e.target.value = '';
    }
  };

  const handleMenuClick: MenuProps['onClick'] = (info) => {
    if (info.key === 'picker') {
      handleStartPicker();
    } else if (info.key === 'upload') {
      fileInputRef.current?.click();
    } else if (info.key === 'reset') {
      handleReset();
    }
  };

  const menuItems: MenuProps['items'] = [
    {
      key: 'picker',
      label: 'Chọn phần tử',
      icon: <AimOutlined />,
    },
    {
      key: 'upload',
      label: 'Tải lên file',
      icon: <UploadOutlined />,
    },
    {
      key: 'reset',
      label: 'Đoạn chat mới',
      icon: <FormOutlined />,
    },
  ];

  // Auto-scroll to bottom of messages container
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Connect socket and listen to events
  useEffect(() => {
    socketService.connect();
    setConnectionStatus(socketService.getStatus());

    const unsubStatus = socketService.onStatusChange((status) => {
      setConnectionStatus(status);
      if (status === 'connected') {
        socketService.getModels();
      }
    });

    const unsubModels = socketService.onModelsList((modelsList) => {
      setModels(modelsList);
      if (modelsList.length > 0) {
        setSelectedModelId((prev) => {
          const stillExists = modelsList.some(m => m.id === prev);
          return stillExists ? prev : modelsList[0].id;
        });
      } else {
        setSelectedModelId('');
      }
    });

    const unsubAgentEvent = socketService.onAgentEvent((payload) => {
      console.log('[App] Received agent event:', payload);
      if (payload.type === 'assistant_delta' && payload.delta) {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === 'assistant') {
            return [
              ...updated.slice(0, -1),
              {
                ...last,
                content: last.content + payload.delta,
              },
            ];
          }
          return prev;
        });
      } else if (payload.type === 'tool_start') {
        setActiveTool({ name: payload.toolName, input: payload.inputPreview });
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === 'assistant') {
            const currentTools = last.toolCalls || [];
            const exists = currentTools.some(t => t.name === payload.toolName && t.status === 'running');
            if (exists) return prev;
            return [
              ...updated.slice(0, -1),
              {
                ...last,
                toolCalls: [
                  ...currentTools,
                  {
                    name: payload.toolName,
                    input: payload.inputPreview,
                    status: 'running',
                  },
                ],
              },
            ];
          }
          return prev;
        });
      } else if (payload.type === 'tool_end') {
        setActiveTool(null);
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === 'assistant' && last.toolCalls) {
            const updatedTools = last.toolCalls.map((t) => {
              if (t.name === payload.toolName && t.status === 'running') {
                return {
                  ...t,
                  status: 'completed' as const,
                  output: payload.outputPreview,
                };
              }
              return t;
            });
            return [
              ...updated.slice(0, -1),
              {
                ...last,
                toolCalls: updatedTools,
              },
            ];
          }
          return prev;
        });
      } else if (payload.type === 'tool_error') {
        setActiveTool(null);
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === 'assistant' && last.toolCalls) {
            const updatedTools = last.toolCalls.map((t) => {
              if (t.name === payload.toolName && t.status === 'running') {
                return {
                  ...t,
                  status: 'error' as const,
                  error: payload.error,
                };
              }
              return t;
            });
            return [
              ...updated.slice(0, -1),
              {
                ...last,
                toolCalls: updatedTools,
              },
            ];
          }
          return prev;
        });
      }
    });

    const unsubCompleted = socketService.onChatCompleted((data) => {
      setIsStreaming(false);
      setActiveTool(null);
      if (!data.ok && data.error) {
        void message.error(`Gặp lỗi: ${data.error}`);
      }
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.role === 'assistant') {
          const updatedTools = last.toolCalls?.map((t) => {
            if (t.status === 'running') {
              return { ...t, status: 'completed' as const };
            }
            return t;
          });
          return [
            ...updated.slice(0, -1),
            {
              ...last,
              content: data.text || last.content,
              toolCalls: updatedTools,
            },
          ];
        }
        return prev;
      });
    });

    const unsubFailed = socketService.onChatFailed((error) => {
      setIsStreaming(false);
      setActiveTool(null);
      void message.error(`Lỗi kết nối hoặc xử lý: ${error}`);
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.role === 'assistant') {
          const updatedTools = last.toolCalls?.map((t) => {
            if (t.status === 'running') {
              return { ...t, status: 'error' as const, error };
            }
            return t;
          });
          return [
            ...updated.slice(0, -1),
            {
              ...last,
              toolCalls: updatedTools,
            },
          ];
        }
        return prev;
      });
    });

    const unsubHistory = socketService.onChatHistory((historyMessages) => {
      console.log('[App] Received chat history:', historyMessages);
      const mapped = historyMessages.map((msg: any) => ({
        id: msg.id || Date.now() + Math.random(),
        role: msg.role as 'assistant' | 'user',
        title: msg.role === 'user' ? 'Bạn' : 'WebCompanion',
        content: msg.text || '',
      }));
      setMessages(mapped);
    });

    if (socketService.getStatus() === 'connected') {
      socketService.getModels();
    }

    return () => {
      unsubStatus();
      unsubModels();
      unsubAgentEvent();
      unsubCompleted();
      unsubFailed();
      unsubHistory();
      socketService.disconnect();
    };
  }, []);

  // Listen for message from page content script
  useEffect(() => {
    const handleRuntimeMessage = (msg: any) => {
      if (msg.type === 'ELEMENT_PICKED_RESULT') {
        setIsPickingElement(false);
        const { selector, text } = msg;
        if (selector) {
          if (composerRef.current) {
            composerRef.current.insertElement({
              selector,
              text: text || '',
            });
            void message.success('Đã đính kèm phần tử thành công!');
          }
        } else {
          void message.warning('Không lấy được selector của phần tử.');
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

  const handleReset = () => {
    setIsStreaming(false);
    setActiveTool(null);
    const success = socketService.sendReset();
    if (success) {
      void message.success('Đã tạo phiên trò chuyện mới.');
    } else {
      void message.error('Không thể tạo phiên mới. Vui lòng kiểm tra kết nối.');
    }
  };

  const sendMessage = (finalPrompt: string) => {
    const content = finalPrompt.trim();

    if (!content) {
      return;
    }

    if (socketService.getStatus() !== 'connected') {
      void message.error('Không kết nối được với máy chủ. Vui lòng kiểm tra kết nối.');
      socketService.connect();
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
        content: '', // Start empty for streaming
      },
    ]);

    if (composerRef.current) {
      composerRef.current.clear();
    }
    setIsComposerEmpty(true);
    setIsStreaming(true);

    const success = socketService.sendChat(content, selectedModelId);
    if (!success) {
      setIsStreaming(false);
      void message.error('Lỗi khi gửi tin nhắn qua socket.');
    }
  };

  const getTabCountLabel = () => {
    if (!currentTab) return '';
    const isActiveInGroup = tabsList.some(t => t.id === currentTab.id);
    if (isActiveInGroup) {
      return tabsList.length > 1 ? `+${tabsList.length - 1} tab` : '';
    } else {
      return tabsList.length > 0 ? `${tabsList.length} tab` : '';
    }
  };

  return (
    <div className="webcompanion-sidebar">
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />
      {/* Main scrollable body */}
      <div className="webcompanion-content-scroll" ref={scrollRef}>
        {/* Welcome message */}
        {messages.length === 0 && (
          <div className="webcompanion-welcome">
            <h1 className="welcome-title">Mình đã sẵn sàng hỗ trợ</h1>
          </div>
        )}

        {/* Message streams */}
        <div className="webcompanion-chat-stream">
          {messages.map((message) => (
            <div key={message.id} className={`webcompanion-msg-row ${message.role}`}>
              {message.role === 'assistant' && (
                <Avatar
                  className="webcompanion-avatar"
                  icon={<AISparklesIcon />}
                />
              )}
              <div className="webcompanion-msg-bubble">
                {message.role === 'assistant' && (
                  <div className="webcompanion-msg-sender">{message.title}</div>
                )}
                {message.role === 'user' && message.attachments && message.attachments.length > 0 && (
                  <div className="webcompanion-message-bubble-attachments">
                    {message.attachments.map((att) => (
                      <div key={att.id} className={`webcompanion-attachment-pill ${att.type} readonly`}>
                        <span className="attachment-icon">
                          {att.type === 'tab' ? <GlobalOutlined /> : <AimOutlined />}
                        </span>
                        <span className="attachment-title" title={att.title}>{att.title}</span>
                      </div>
                    ))}
                  </div>
                )}
                {message.toolCalls && message.toolCalls.length > 0 && (
                  <div className="webcompanion-message-tool-calls">
                    {message.toolCalls.map((tc, idx) => (
                      <ToolCallItem key={idx} toolCall={tc} />
                    ))}
                  </div>
                )}
                {message.content === '' && isStreaming && message.id === messages[messages.length - 1]?.id ? (
                  <div className="typing-indicator">
                    <span />
                    <span />
                    <span />
                  </div>
                ) : (
                  <>
                    <div
                      className="webcompanion-msg-text"
                      dangerouslySetInnerHTML={{ __html: renderMessageContent(message.content) }}
                    />
                    {message.role === 'assistant' && message.content && (
                      <div className="webcompanion-msg-actions">
                        <Button
                          type="text"
                          size="small"
                          icon={copiedId === message.id ? <CheckOutlined style={{ color: '#10b981' }} /> : <CopyOutlined />}
                          onClick={() => handleCopy(message.content, message.id)}
                          className="webcompanion-copy-btn"
                          title="Sao chép câu trả lời"
                        >
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Active Tool Running status */}
        {isStreaming && activeTool && (
          <div className="webcompanion-tool-banner">
            <span className="webcompanion-tool-pulse" />
            <span>Đang sử dụng công cụ: <strong>{activeTool.name}</strong>...</span>
          </div>
        )}
      </div>

      {/* Footer input and actions */}
      <footer className="webcompanion-footer">
        {/* Connection status banner if not connected */}
        {connectionStatus !== 'connected' && (
          <div className={`webcompanion-status-banner ${connectionStatus}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span className="status-dot-indicator" />
              <span>
                {connectionStatus === 'connecting'
                  ? 'Đang kết nối tới máy chủ agent...'
                  : 'Mất kết nối tới máy chủ agent. Đang tự động thử lại...'}
              </span>
            </div>
            {connectionStatus === 'disconnected' && (
              <Button
                size="small"
                type="text"
                onClick={() => socketService.connect()}
                style={{ color: '#2563eb', fontWeight: 600, padding: 0, height: 'auto', fontSize: '11px' }}
              >
                Thử lại
              </Button>
            )}
          </div>
        )}

        {/* Suggestion row */}
        {suggestions.length > 0 && (
          <div className="webcompanion-suggestions">
            {suggestions.map((item) => (
              <button
                key={item}
                className="webcompanion-suggestion-chip"
                onClick={() => sendMessage(item)}
              >
                {item}
              </button>
            ))}
          </div>
        )}

        {/* Current Active Context Tab Bar */}
        <div className="webcompanion-context-capsule" onClick={() => setIsContextExpanded(!isContextExpanded)}>
          <div className="context-left">
            <span className="context-icon-wrapper">
              {currentTab?.favIconUrl ? (
                <img src={currentTab.favIconUrl} className="tab-favicon" style={{ marginRight: '2px' }} alt="" />
              ) : (
                <GlobalOutlined style={{ color: '#2563eb' }} />
              )}
            </span>
            <span className="context-title" title={currentTab?.title || 'Đang tải...'}>
              {currentTab?.title || 'Đang tải...'}
            </span>
            {getTabCountLabel() && (
              <span className="context-extra">{getTabCountLabel()}</span>
            )}
            <span className={`socket-dot ${connectionStatus}`} title={`Socket: ${connectionStatus}`} />
          </div>
          {isContextExpanded ? (
            <DownOutlined className="context-expand-icon" />
          ) : (
            <UpOutlined className="context-expand-icon" />
          )}
        </div>

        {/* Tab list expanded panel */}
        {isContextExpanded && (
          <div className="webcompanion-tabs-list-panel">
            {tabsList.map((tab) => (
              <div
                key={tab.id}
                className={`webcompanion-tab-item ${tab.active ? 'active' : ''}`}
                style={{ cursor: 'pointer' }}
                onClick={() => void handleActivateTab(tab.id)}
              >
                <div className="tab-item-left">
                  {tab.favIconUrl ? (
                    <img src={tab.favIconUrl} className="tab-favicon" alt="" />
                  ) : (
                    <GlobalOutlined className="tab-favicon-fallback" />
                  )}
                  <span className="tab-title" title={tab.title}>{tab.title}</span>
                </div>
                <div className="tab-item-actions">
                  <Button
                    size="small"
                    type="text"
                    icon={<PushpinOutlined />}
                    title="Ghim vào ô nhập"
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePinTab(tab);
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Composer Chat Input area */}
        {isPickingElement && (
          <div className="webcompanion-picker-banner">
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
        <div className="webcompanion-composer">
          <RichComposer
            ref={composerRef}
            tabsList={tabsList}
            onSubmit={sendMessage}
            onTextChange={() => {
              if (composerRef.current) {
                setIsComposerEmpty(composerRef.current.isEmpty());
              }
            }}
          />
          <div className="webcompanion-composer-actions">
            <div className="actions-left">
              <Dropdown
                menu={{ items: menuItems, onClick: handleMenuClick }}
                trigger={['click']}
                placement="topLeft"
                getPopupContainer={(triggerNode) => triggerNode.parentNode as HTMLElement}
              >
                <Button
                  type="text"
                  shape="circle"
                  icon={<PlusOutlined />}
                  className="composer-action-btn"
                  title="Thêm hành động"
                />
              </Dropdown>
              <Select
                value={selectedModelId || undefined}
                onChange={(val) => setSelectedModelId(val)}
                placeholder="Chọn Model"
                className="webcompanion-model-select"
                variant="borderless"
                options={models.map((m) => ({ value: m.id, label: m.modelName || m.model || m.id }))}
                dropdownStyle={{ zIndex: 2147483647 }}
              />
            </div>
            <div className="actions-right">
              <Button
                type="text"
                shape="circle"
                icon={<SendOutlined />}
                className={`composer-action-btn send ${!isComposerEmpty ? 'active' : ''}`}
                title="Gửi tin nhắn"
                disabled={isComposerEmpty}
                onClick={() => {
                  if (composerRef.current) {
                    const prompt = composerRef.current.getFinalPrompt();
                    if (prompt.trim()) {
                      sendMessage(prompt);
                    }
                  }
                }}
              />
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
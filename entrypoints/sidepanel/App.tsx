import { useMemo, useState } from 'react';
import { Avatar, Button, Card, Input, Space, Tag, Typography } from 'antd';
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
    title: 'Copilot-style companion',
    content:
      'Tôi có thể tóm tắt trang, giải thích nội dung đang mở, hoặc gợi ý bước tiếp theo ngay trong side panel.',
  },
  {
    id: 2,
    role: 'user',
    title: 'Người dùng',
    content: 'Hãy giúp tôi hiểu nhanh trang này đang nói về gì.',
  },
  {
    id: 3,
    role: 'assistant',
    title: 'Đề xuất',
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

function App() {
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState('');

  const actionSummary = useMemo(
    () => [
      { label: 'Context', value: 'Trang hiện tại' },
      { label: 'Mode', value: 'Assist' },
      { label: 'State', value: 'Ready' },
    ],
    [],
  );

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
        title: 'Copilot',
        content:
          'Tôi đã nhận yêu cầu. Nếu bạn muốn, tôi có thể viết tiếp phần giải thích, trích ý chính hoặc tạo câu trả lời ngắn hơn.',
      },
    ]);
    setDraft('');
  };

  return (
    <div className="side-chat-shell">
      <header className="side-chat-header">
        <div>
          <Typography.Text className="eyebrow">WebCompanion</Typography.Text>
          <Typography.Title level={4} className="header-title">
            Side Chat
          </Typography.Title>
        </div>

        <Space size={8} wrap>
          {actionSummary.map((item) => (
            <Tag key={item.label} className="status-tag">
              <span className="status-dot" />
              {item.label}: {item.value}
            </Tag>
          ))}
        </Space>
      </header>

      <section className="composer-card">
        <Space align="center" size={12} className="composer-topline">
          <Avatar className="assistant-avatar">WC</Avatar>
          <div>
            <Typography.Text className="composer-label">Ask anything about this page</Typography.Text>
            <Typography.Paragraph className="composer-hint">
              Side panel được thiết kế để đọc nhanh, hỏi nhanh và trả lời ngay bên cạnh nội dung.
            </Typography.Paragraph>
          </div>
        </Space>

        <Space size={8} wrap className="suggestion-row">
          {suggestions.map((item) => (
            <Button key={item} className="suggestion-button" onClick={() => sendMessage(item)}>
              {item}
            </Button>
          ))}
        </Space>

        <Input.TextArea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Nhập câu hỏi hoặc yêu cầu của bạn..."
          autoSize={{ minRows: 3, maxRows: 5 }}
          className="composer-input"
        />

        <div className="composer-actions">
          <Space>
            <Button className="ghost-button">+ Attach</Button>
            <Button className="ghost-button">Context</Button>
          </Space>

          <Button
            type="primary"
            onClick={() => sendMessage(draft)}
            className="send-button"
          >
            Send →
          </Button>
        </div>
      </section>

      <main className="chat-stream">
        {messages.map((message) => (
          <Card key={message.id} className={`message-card ${message.role}`} bordered={false}>
            <div className="message-header">
              <Avatar className={message.role === 'assistant' ? 'assistant-avatar' : 'user-avatar'}>
                {message.role === 'assistant' ? 'AI' : 'You'}
              </Avatar>
              <div>
                <Typography.Text className="message-role">{message.title}</Typography.Text>
                <Typography.Paragraph className="message-content">{message.content}</Typography.Paragraph>
              </div>
            </div>
          </Card>
        ))}
      </main>
    </div>
  );
}

export default App;
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import App from './App';
import './style.css';

const theme = {
  token: {
    colorPrimary: '#2563eb',
    colorInfo: '#2563eb',
    colorBgBase: '#f5f7fb',
    colorTextBase: '#0f172a',
    borderRadius: 16,
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider theme={theme}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface ModelSetting {
  id: string;
  name?: string;
  [key: string]: any;
}

export interface AgentEventPayload {
  type: string;
  delta?: string;
  [key: string]: any;
}

export type StatusListener = (status: ConnectionStatus) => void;
export type ModelsListener = (models: ModelSetting[]) => void;
export type AgentEventListener = (payload: AgentEventPayload) => void;
export type ChatCompletedListener = (data: { text: string; ok: boolean; error?: string }) => void;
export type ChatFailedListener = (error: string) => void;
export type ChatHistoryListener = (messages: any[]) => void;

class SocketService {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private url: string = 'ws://localhost:8080';
  private reconnectTimer: any = null;
  private autoReconnect: boolean = true;
  private conversationId: string = 'extension_companion';

  // Listeners
  private statusListeners = new Set<StatusListener>();
  private modelsListeners = new Set<ModelsListener>();
  private agentEventListeners = new Set<AgentEventListener>();
  private chatCompletedListeners = new Set<ChatCompletedListener>();
  private chatFailedListeners = new Set<ChatFailedListener>();
  private chatHistoryListeners = new Set<ChatHistoryListener>();

  constructor(url?: string) {
    if (url) {
      this.url = url;
    }
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  private setStatus(newStatus: ConnectionStatus) {
    if (this.status !== newStatus) {
      this.status = newStatus;
      this.statusListeners.forEach((listener) => listener(newStatus));
    }
  }

  public connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.setStatus('connecting');
    this.autoReconnect = true;

    try {
      const ws = new WebSocket(this.url);
      this.socket = ws;

      ws.onopen = () => {
        if (this.socket !== ws) return;
        console.log('[SocketService] Connected to server.');
        this.setStatus('connected');
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      };

      ws.onmessage = (event) => {
        if (this.socket !== ws) return;
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (err) {
          console.error('[SocketService] Failed to parse message:', err);
        }
      };

      ws.onclose = () => {
        if (this.socket === ws) {
          console.log('[SocketService] Socket closed.');
          this.setStatus('disconnected');
          this.socket = null;
          this.triggerReconnect();
        } else {
          console.log('[SocketService] Ignored old socket close event.');
        }
      };

      ws.onerror = (err) => {
        if (this.socket !== ws) return;
        console.error('[SocketService] Socket error:', err);
      };
    } catch (err) {
      console.error('[SocketService] Connect exception:', err);
      this.setStatus('disconnected');
      this.triggerReconnect();
    }
  }

  public disconnect() {
    this.autoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.setStatus('disconnected');
  }

  private triggerReconnect() {
    if (!this.autoReconnect) return;

    if (this.reconnectTimer === null) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        console.log('[SocketService] Attempting to reconnect...');
        this.connect();
      }, 4000);
    }
  }

  private handleMessage(data: any) {
    switch (data.type) {
      case 'connection_status':
        console.log('[SocketService] Connection status check:', data.message);
        if (data.conversationId) {
          this.conversationId = data.conversationId;
        }
        break;
      case 'session_reset':
        console.log('[SocketService] Session reset:', data.message);
        if (data.conversationId) {
          this.conversationId = data.conversationId;
          // Clear UI messages by passing empty history
          this.chatHistoryListeners.forEach((listener) => listener([]));
        }
        break;
      case 'chat_history':
        this.chatHistoryListeners.forEach((listener) => listener(data.messages || []));
        break;
      case 'models_list':
        this.modelsListeners.forEach((listener) => listener(data.models || []));
        break;
      case 'agent_event':
        if (data.payload) {
          this.agentEventListeners.forEach((listener) => listener(data.payload));
        }
        break;
      case 'chat_completed':
        this.chatCompletedListeners.forEach((listener) => listener({
          text: data.text || '',
          ok: data.ok,
          error: data.error,
        }));
        break;
      case 'chat_failed':
        this.chatFailedListeners.forEach((listener) => listener(data.error || 'Unknown error'));
        break;
      case 'error':
        this.chatFailedListeners.forEach((listener) => listener(data.message || 'Error occurred'));
        break;
      default:
        console.warn('[SocketService] Unknown message type:', data.type);
    }
  }

  public sendChat(text: string, modelId?: string) {
    if (!this.socket) {
      console.error('[SocketService] Cannot send chat: WebSocket is null.');
      return false;
    }

    if (this.socket.readyState !== WebSocket.OPEN) {
      console.error('[SocketService] Cannot send chat: readyState is', this.socket.readyState);
      return false;
    }

    try {
      const payload = {
        type: 'chat',
        text,
        modelId,
        conversationId: this.conversationId,
      };
      console.log('[SocketService] Sending chat payload:', payload);
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      console.error('[SocketService] Send exception:', err);
      return false;
    }
  }

  public sendReset() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      console.log('[SocketService] Sending reset request...');
      this.socket.send(JSON.stringify({ type: 'reset' }));
      return true;
    } catch (err) {
      console.error('[SocketService] Send reset exception:', err);
      return false;
    }
  }

  public getModels() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify({ type: 'get_models' }));
    return true;
  }

  // Event listener registry methods
  public onStatusChange(listener: StatusListener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  public onModelsList(listener: ModelsListener) {
    this.modelsListeners.add(listener);
    return () => this.modelsListeners.delete(listener);
  }

  public onAgentEvent(listener: AgentEventListener) {
    this.agentEventListeners.add(listener);
    return () => this.agentEventListeners.delete(listener);
  }

  public onChatCompleted(listener: ChatCompletedListener) {
    this.chatCompletedListeners.add(listener);
    return () => this.chatCompletedListeners.delete(listener);
  }

  public onChatFailed(listener: ChatFailedListener) {
    this.chatFailedListeners.add(listener);
    return () => this.chatFailedListeners.delete(listener);
  }

  public onChatHistory(listener: ChatHistoryListener) {
    this.chatHistoryListeners.add(listener);
    return () => this.chatHistoryListeners.delete(listener);
  }
}

// Export singleton instance
export const socketService = new SocketService();

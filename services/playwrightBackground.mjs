var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class ProtocolV1Handler {
  constructor(context) {
    __publicField(this, "_context");
    __publicField(this, "_selectedTabPromise");
    __publicField(this, "_selectedTabResolve");
    this._context = context;
    this._selectedTabPromise = new Promise((resolve) => this._selectedTabResolve = resolve);
  }
  async handleCommand(message) {
    if (message.method === "attachToTab") {
      const tabId = await this._selectedTabPromise;
      const debuggee = { tabId };
      await chrome.debugger.attach(debuggee, "1.3");
      this._context.notifyTabAttached(tabId);
      const result = await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo");
      return { targetInfo: result == null ? void 0 : result.targetInfo };
    }
    if (message.method === "forwardCDPCommand") {
      const { sessionId, method, params } = message.params;
      if (method === "Target.createTarget")
        throw new Error("Tab creation is not supported yet. Update Playwright MCP or CLI to the latest version.");
      const tabId = [...this._context.attachedTabs][0];
      if (tabId === void 0)
        throw new Error("No tab is connected");
      const debuggerSession = { tabId, sessionId };
      return await chrome.debugger.sendCommand(debuggerSession, method, params);
    }
    throw new Error(`Unknown method: ${message.method}`);
  }
  forwardChromeEvent(fullMethod, args) {
    if (fullMethod !== "chrome.debugger.onEvent")
      return;
    const [source, method, params] = args;
    this._context.sendMessage({
      method: "forwardCDPEvent",
      params: { sessionId: source.sessionId, method, params }
    });
  }
  onUserAttachRequest(tab) {
    if (tab.id !== void 0)
      this._selectedTabResolve(tab.id);
  }
  onUserDetachRequest(_tabId) {
  }
  didInitialize() {
  }
}
const ALLOWED_CHROME_COMMANDS = /* @__PURE__ */ new Set([
  "chrome.debugger.attach",
  "chrome.debugger.detach",
  "chrome.debugger.sendCommand",
  "chrome.tabs.create",
  "chrome.tabs.remove"
]);
class ProtocolV2Handler {
  constructor(context) {
    __publicField(this, "_context");
    this._context = context;
  }
  async handleCommand(message) {
    if (ALLOWED_CHROME_COMMANDS.has(message.method)) {
      const args = message.params ?? [];
      const result = await invokeChromeMethod(message.method, args);
      if (message.method === "chrome.debugger.attach") {
        const target = args[0];
        if ((target == null ? void 0 : target.tabId) !== void 0)
          this._context.notifyTabAttached(target.tabId);
      }
      return result ?? {};
    }
    throw new Error(`Unknown method: ${message.method}`);
  }
  forwardChromeEvent(fullMethod, args) {
    this._context.sendMessage({ method: fullMethod, params: args });
  }
  onUserAttachRequest(tab) {
    this._context.sendMessage({ method: "chrome.tabs.onCreated", params: [tab] });
  }
  didInitialize() {
    this._context.sendMessage({ method: "extension.initialized", params: [] });
  }
  onUserDetachRequest(tabId) {
    this._context.sendMessage({
      method: "chrome.debugger.onDetach",
      params: [{ tabId }, "target_closed"]
    });
  }
}
function resolveChromeMember(fullMethod) {
  const parts = fullMethod.split(".");
  if (parts[0] !== "chrome" || parts.length < 3)
    throw new Error(`Invalid chrome method: ${fullMethod}`);
  let obj = chrome;
  for (let i = 1; i < parts.length - 1; i++) {
    obj = obj == null ? void 0 : obj[parts[i]];
    if (obj === void 0)
      throw new Error(`Unknown chrome path: ${parts.slice(0, i + 1).join(".")}, calling ${fullMethod}`);
  }
  return { obj, name: parts[parts.length - 1] };
}
async function invokeChromeMethod(fullMethod, args) {
  const { obj, name } = resolveChromeMember(fullMethod);
  const fn = obj[name];
  if (typeof fn !== "function")
    throw new Error(`Not a function: ${fullMethod}`);
  return await fn.apply(obj, args);
}
function debugLog(...args) {
  {
    console.log("[Extension]", ...args);
  }
}
const CHROME_EVENT_METHODS = [
  "chrome.debugger.onEvent",
  "chrome.debugger.onDetach",
  "chrome.tabs.onCreated",
  "chrome.tabs.onRemoved"
];
class RelayConnection {
  constructor(ws, protocolVersion) {
    __publicField(this, "_ws");
    __publicField(this, "_handler");
    // Tabs whose debugger we have explicitly attached for this connection.
    __publicField(this, "_attachedTabs", /* @__PURE__ */ new Set());
    // Once we've attached at least one tab, detaching the last one closes the connection.
    __publicField(this, "_hasEverAttached", false);
    __publicField(this, "_eventListeners", []);
    __publicField(this, "_closed", false);
    __publicField(this, "onclose");
    __publicField(this, "ontabattached");
    __publicField(this, "ontabdetached");
    this._ws = ws;
    const context = {
      attachedTabs: this._attachedTabs,
      sendMessage: (msg) => this._sendMessage(msg),
      notifyTabAttached: (tabId) => this._notifyTabAttached(tabId),
      notifyTabDetached: (tabId) => this._notifyTabDetached(tabId)
    };
    this._handler = protocolVersion === 1 ? new ProtocolV1Handler(context) : new ProtocolV2Handler(context);
    this._installEventForwarders();
    this._ws.onmessage = this._onMessage.bind(this);
    this._ws.onclose = () => this._onClose();
  }
  get attachedTabs() {
    return this._attachedTabs;
  }
  // Signals the end of the initial-tab handshake — call after the initial
  // round of `attachTab` invocations. For v2 this sends `extension.initialized`
  // so the relay can unblock Playwright CDP traffic; v1 has no handshake.
  didInitialize() {
    this._handler.didInitialize();
  }
  close(message) {
    this._ws.close(1e3, message);
    this._onClose();
  }
  // Called when the UI adds a tab to the Playwright group. The handler asks
  // the relay to attach; the normal command path fires ontabattached.
  attachTab(tab) {
    if (this._closed || this._attachedTabs.has(tab.id))
      return;
    this._handler.onUserAttachRequest(tab);
  }
  // Called when the UI removes a tab from the Playwright group. We detach the
  // debugger and update bookkeeping; the handler emits the wire-level detach
  // notification for protocols that have one.
  detachTab(tabId) {
    if (this._closed || !this._attachedTabs.has(tabId))
      return;
    chrome.debugger.detach({ tabId }).catch((error) => {
      debugLog("Error detaching tab:", error);
    });
    this._notifyTabDetached(tabId);
    this._handler.onUserDetachRequest(tabId);
    this._checkLastTabDetached();
  }
  _notifyTabAttached(tabId) {
    var _a;
    this._attachedTabs.add(tabId);
    this._hasEverAttached = true;
    (_a = this.ontabattached) == null ? void 0 : _a.call(this, tabId);
  }
  _notifyTabDetached(tabId) {
    var _a;
    this._attachedTabs.delete(tabId);
    (_a = this.ontabdetached) == null ? void 0 : _a.call(this, tabId);
  }
  _installEventForwarders() {
    for (const fullMethod of CHROME_EVENT_METHODS) {
      const target = resolveChromeMember(fullMethod);
      const listener = (...args) => this._onChromeEvent(fullMethod, args);
      target.obj[target.name].addListener(listener);
      this._eventListeners.push({
        remove: () => target.obj[target.name].removeListener(listener)
      });
    }
  }
  _onClose() {
    var _a;
    if (this._closed)
      return;
    this._closed = true;
    for (const l of this._eventListeners)
      l.remove();
    this._eventListeners = [];
    for (const tabId of [...this._attachedTabs]) {
      chrome.debugger.detach({ tabId }).catch(() => {
      });
      this._notifyTabDetached(tabId);
    }
    (_a = this.onclose) == null ? void 0 : _a.call(this);
  }
  _checkLastTabDetached() {
    if (this._hasEverAttached && this._attachedTabs.size === 0)
      this.close("All controlled tabs detached");
  }
  // Filters chrome.* events to attached tabs, delegates wire formatting to the
  // handler, then runs shared detach bookkeeping.
  _onChromeEvent(fullMethod, args) {
    const tabId = this._tabIdForEventArgs(fullMethod, args);
    if (tabId === void 0 || !this._attachedTabs.has(tabId))
      return;
    this._handler.forwardChromeEvent(fullMethod, args);
    if (fullMethod === "chrome.debugger.onDetach") {
      this._notifyTabDetached(tabId);
      this._checkLastTabDetached();
    }
  }
  // Returns the tabId an event refers to, for filtering by _attachedTabs.
  _tabIdForEventArgs(fullMethod, args) {
    var _a;
    switch (fullMethod) {
      case "chrome.debugger.onEvent":
      case "chrome.debugger.onDetach":
        return (_a = args[0]) == null ? void 0 : _a.tabId;
      case "chrome.tabs.onCreated": {
        const tab = args[0];
        return tab.openerTabId;
      }
      case "chrome.tabs.onRemoved":
        return args[0];
    }
    return void 0;
  }
  _onMessage(event) {
    this._onMessageAsync(event).catch((e) => debugLog("Error handling message:", e));
  }
  async _onMessageAsync(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      debugLog(`Error parsing message ${event.data}:`, error);
      this._sendError(-32700, `Error parsing message: ${error.message}`);
      return;
    }
    const response = {
      id: message.id
    };
    try {
      response.result = await this._handler.handleCommand(message);
    } catch (error) {
      debugLog(`Error handling command ${JSON.stringify(message)}:`, error);
      response.error = error.message;
    }
    this._sendMessage(response);
  }
  _sendError(code, message) {
    this._sendMessage({
      error: {
        code,
        message
      }
    });
  }
  _sendMessage(message) {
    if (this._ws.readyState === WebSocket.OPEN)
      this._ws.send(JSON.stringify(message));
  }
}
class EagerPending {
  constructor(connection) {
    __publicField(this, "_connection");
    __publicField(this, "onclose");
    this._connection = connection;
    this._connection.onclose = () => {
      var _a;
      return (_a = this.onclose) == null ? void 0 : _a.call(this);
    };
  }
  static async create(mcpRelayUrl, protocolVersion) {
    const connection = await openRelayConnection(mcpRelayUrl, protocolVersion);
    return new EagerPending(connection);
  }
  async connect() {
    return this._connection;
  }
  close(reason) {
    this._connection.close(reason);
  }
}
class DeferredPending {
  constructor(_mcpRelayUrl, _protocolVersion) {
    this._mcpRelayUrl = _mcpRelayUrl;
    this._protocolVersion = _protocolVersion;
  }
  async connect() {
    return openRelayConnection(this._mcpRelayUrl, this._protocolVersion);
  }
  close(_reason) {
  }
}
class PendingConnections {
  constructor() {
    __publicField(this, "_map", /* @__PURE__ */ new Map());
    chrome.tabs.onRemoved.addListener(this._onTabRemoved.bind(this));
  }
  // v1 opens the relay WS eagerly — the daemon expects a prompt connection.
  // v2 records only the descriptor; the WS opens lazily in `take` once the
  // user clicks Allow.
  async create(selectorTabId, mcpRelayUrl, protocolVersion) {
    if (protocolVersion !== 1) {
      this._map.set(selectorTabId, new DeferredPending(mcpRelayUrl, protocolVersion));
      return;
    }
    const entry = await EagerPending.create(mcpRelayUrl, protocolVersion);
    entry.onclose = () => {
      if (this._map.get(selectorTabId) !== entry)
        return;
      this._map.delete(selectorTabId);
      chrome.tabs.sendMessage(selectorTabId, { type: "pendingConnectionClosed" }).catch(() => {
      });
    };
    this._map.set(selectorTabId, entry);
  }
  async take(selectorTabId) {
    const entry = this._map.get(selectorTabId);
    if (!entry)
      return void 0;
    this._map.delete(selectorTabId);
    return entry.connect();
  }
  _onTabRemoved(tabId) {
    const entry = this._map.get(tabId);
    if (!entry)
      return;
    this._map.delete(tabId);
    entry.close("Browser tab closed");
  }
}
async function openRelayConnection(mcpRelayUrl, protocolVersion) {
  try {
    const socket = new WebSocket(mcpRelayUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("WebSocket error"));
      setTimeout(() => reject(new Error("Connection timeout")), 5e3);
    });
    return new RelayConnection(socket, protocolVersion);
  } catch (error) {
    const message = `Failed to connect to MCP relay: ${error.message}`;
    debugLog(message);
    throw new Error(message);
  }
}
const PLAYWRIGHT_GROUP_TITLE = "webbot";
const PLAYWRIGHT_GROUP_COLOR = "green";
const NON_DEBUGGABLE_SCHEMES = ["chrome:", "edge:", "devtools:"];
const CONNECTED_BADGE = { text: "✓", color: "#4CAF50", title: "Connected to Playwright client" };
function isNonDebuggableUrl(url) {
  return !!url && NON_DEBUGGABLE_SCHEMES.some((s) => url.startsWith(s));
}
async function cleanupStalePlaywrightGroups() {
  try {
    const groups = await chrome.tabGroups.query({ title: PLAYWRIGHT_GROUP_TITLE });
    const tabsPerGroup = await Promise.all(groups.map((g) => chrome.tabs.query({ groupId: g.id })));
    const tabIds = tabsPerGroup.flat().map((t) => t.id).filter((id) => id !== void 0);
    if (tabIds.length)
      await chrome.tabs.ungroup(tabIds);
  } catch (error) {
    debugLog("Error cleaning up stale groups:", error);
  }
}
class ConnectedTabGroup {
  constructor(connection, selectedTab) {
    __publicField(this, "_connection");
    __publicField(this, "_groupId", null);
    __publicField(this, "_groupTabIds", /* @__PURE__ */ new Set());
    __publicField(this, "_onTabUpdatedListener");
    __publicField(this, "_onTabRemovedListener");
    __publicField(this, "onclose");
    this._connection = connection;
    this._connection.onclose = () => this._onConnectionClose();
    this._connection.ontabattached = (tabId) => this._onTabAttached(tabId);
    this._connection.ontabdetached = (tabId) => this._onTabDetached(tabId);
    this._onTabUpdatedListener = this._onTabUpdated.bind(this);
    this._onTabRemovedListener = this._onTabRemoved.bind(this);
    chrome.tabs.onUpdated.addListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.addListener(this._onTabRemovedListener);
    this._connection.attachTab(selectedTab);
    this._connection.didInitialize();
  }
  connectedTabIds() {
    return [...this._groupTabIds];
  }
  close(reason) {
    this._connection.close(reason);
  }
  _onTabUpdated(tabId, changeInfo, tab) {
    if (changeInfo.groupId !== void 0)
      this._onTabGroupChanged(tabId, tab);
    if (changeInfo.url === void 0)
      return;
    if (this._connection.attachedTabs.has(tabId))
      void this._updateBadge(tabId, CONNECTED_BADGE);
    else if (this._groupTabIds.has(tabId) && !isNonDebuggableUrl(changeInfo.url))
      this._connection.attachTab(tab);
  }
  // Single entry point for group membership changes, whether the user dragged
  // or we grouped the tab ourselves. Attaches on entry (if debuggable) and
  // detaches on exit; a chrome:// tab stays in the group until it navigates
  // (handled in _onTabUpdated).
  _onTabGroupChanged(tabId, tab) {
    const inOurGroup = this._groupId !== null && tab.groupId === this._groupId;
    const wasInGroup = this._groupTabIds.has(tabId);
    if (inOurGroup === wasInGroup)
      return;
    if (inOurGroup) {
      this._groupTabIds.add(tabId);
      if (!isNonDebuggableUrl(tab.url))
        this._connection.attachTab(tab);
    } else {
      this._groupTabIds.delete(tabId);
      if (this._connection.attachedTabs.has(tabId))
        this._connection.detachTab(tabId);
    }
  }
  _onTabRemoved(tabId) {
    this._groupTabIds.delete(tabId);
  }
  _onTabAttached(tabId) {
    void this._updateBadge(tabId, CONNECTED_BADGE);
    void this._addTabToGroup(tabId);
  }
  // The debugger detached (drag-out, tab close, or external action). Clear the
  // badge but leave the tab in the group — the user's intent is still there,
  // and a subsequent navigation will re-attach via _onTabUpdated.
  _onTabDetached(tabId) {
    void this._updateBadge(tabId, { text: "" });
  }
  _onConnectionClose() {
    var _a;
    chrome.tabs.onUpdated.removeListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.removeListener(this._onTabRemovedListener);
    const groupTabs = [...this._groupTabIds];
    this._groupTabIds.clear();
    if (groupTabs.length) {
      this._retryOnDrag(() => chrome.tabs.ungroup(groupTabs)).catch((error) => {
        debugLog("Error ungrouping tabs on close:", error);
      });
    }
    (_a = this.onclose) == null ? void 0 : _a.call(this);
  }
  async _updateBadge(tabId, { text, color, title }) {
    try {
      await Promise.all([
        chrome.action.setBadgeText({ tabId, text }),
        chrome.action.setTitle({ tabId, title: title || "" }),
        color ? chrome.action.setBadgeBackgroundColor({ tabId, color }) : Promise.resolve()
      ]);
    } catch (error) {
    }
  }
  // Moves an already-attached tab into our Chrome tab group, creating it on
  // first use. `_groupTabIds` is updated after the await so an onUpdated event
  // that arrives concurrently (`_groupId` still null, wasInGroup still false)
  // becomes a harmless no-op rather than taking the drag-out branch.
  async _addTabToGroup(tabId) {
    if (this._groupTabIds.has(tabId))
      return;
    try {
      await this._retryOnDrag(async () => {
        if (this._groupId === null) {
          this._groupId = await chrome.tabs.group({ tabIds: [tabId] });
          await chrome.tabGroups.update(this._groupId, { color: PLAYWRIGHT_GROUP_COLOR, title: PLAYWRIGHT_GROUP_TITLE });
        } else {
          await chrome.tabs.group({ groupId: this._groupId, tabIds: [tabId] });
        }
      });
      this._groupTabIds.add(tabId);
    } catch (error) {
      debugLog("Error adding tab to group:", error);
    }
  }
  // Chrome throws "user may be dragging a tab" while a drag is in progress.
  // Retry with backoff until it clears (or we give up).
  async _retryOnDrag(fn) {
    var _a;
    const delays = [0, 100, 200, 400, 800];
    let lastError;
    for (const delay of delays) {
      if (delay)
        await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await fn();
        return;
      } catch (error) {
        if (!((_a = error == null ? void 0 : error.message) == null ? void 0 : _a.includes("user may be dragging a tab")))
          throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
}
class PlaywrightExtension {
  constructor() {
    __publicField(this, "_activeGroup");
    __publicField(this, "_activeClientName");
    __publicField(this, "_pendingConnections", new PendingConnections());
    // Service worker restarts lose all connection state, so any existing
    // Playwright groups are stale. Connections wait on this before reconciling.
    __publicField(this, "_cleanupPromise");
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
    chrome.action.onClicked.addListener(this._onActionClicked.bind(this));
    this._cleanupPromise = cleanupStalePlaywrightGroups();
  }
  // Promise-based message handling is not supported in Chrome: https://issues.chromium.org/issues/40753031
  _onMessage(message, sender, sendResponse) {
    var _a;
    switch (message.type) {
      case "connectionRequested":
        this._pendingConnections.create(sender.tab.id, message.mcpRelayUrl, message.protocolVersion).then(
          () => sendResponse({ success: true }),
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true;
      case "getTabs":
        this._getTabs().then(
          (tabs) => {
            var _a2;
            return sendResponse({ success: true, tabs, currentTabId: (_a2 = sender.tab) == null ? void 0 : _a2.id });
          },
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true;
      case "connectToTab": {
        const selectedTab = message.tab ?? sender.tab;
        this._connectTab(sender.tab.id, selectedTab, message.clientName).then(
          () => sendResponse({ success: true }),
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true;
      }
      case "getConnectionStatus":
        sendResponse({
          connectedTabIds: ((_a = this._activeGroup) == null ? void 0 : _a.connectedTabIds()) ?? [],
          clientName: this._activeClientName
        });
        return false;
      case "disconnect":
        try {
          this._disconnect("User disconnected");
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
        return true;
      case "keepalive":
        return false;
    }
  }
  async _connectTab(selectorTabId, tab, clientName) {
    try {
      await this._cleanupPromise;
      this._disconnect("Another connection is requested");
      const connection = await this._pendingConnections.take(selectorTabId);
      if (!connection)
        throw new Error("Pending client connection closed");
      const group = new ConnectedTabGroup(connection, tab);
      group.onclose = () => {
        if (this._activeGroup === group) {
          this._activeGroup = void 0;
          this._activeClientName = void 0;
        }
      };
      this._activeGroup = group;
      this._activeClientName = clientName;
      await Promise.all([
        chrome.tabs.update(tab.id, { active: true }),
        chrome.windows.update(tab.windowId, { focused: true })
      ]).catch(() => {
      });
      if (tab.id !== selectorTabId)
        await chrome.tabs.remove(selectorTabId).catch(() => {
        });
    } catch (error) {
      debugLog(`Failed to connect tab ${tab.id}:`, error.message);
      throw error;
    }
  }
  async _getTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((tab) => !isNonDebuggableUrl(tab.url));
  }
  async _onActionClicked() {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("status.html"),
      active: true
    });
  }
  // Closes the active group's connection if any. ConnectedTabGroup's onclose
  // handles state cleanup (connectedTabIds, badges, reconcile).
  _disconnect(reason) {
    var _a;
    (_a = this._activeGroup) == null ? void 0 : _a.close(reason);
    this._activeGroup = void 0;
    this._activeClientName = void 0;
  }
}
new PlaywrightExtension();
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFja2dyb3VuZC5tanMiLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9wcm90b2NvbEhhbmRsZXJzLnRzIiwiLi4vLi4vc3JjL3JlbGF5Q29ubmVjdGlvbi50cyIsIi4uLy4uL3NyYy9wZW5kaW5nQ29ubmVjdGlvbi50cyIsIi4uLy4uL3NyYy9jb25uZWN0ZWRUYWJHcm91cC50cyIsIi4uLy4uL3NyYy9iYWNrZ3JvdW5kLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ29weXJpZ2h0IChjKSBNaWNyb3NvZnQgQ29ycG9yYXRpb24uXG4gKlxuICogTGljZW5zZWQgdW5kZXIgdGhlIEFwYWNoZSBMaWNlbnNlLCBWZXJzaW9uIDIuMCAodGhlIFwiTGljZW5zZVwiKTtcbiAqIHlvdSBtYXkgbm90IHVzZSB0aGlzIGZpbGUgZXhjZXB0IGluIGNvbXBsaWFuY2Ugd2l0aCB0aGUgTGljZW5zZS5cbiAqIFlvdSBtYXkgb2J0YWluIGEgY29weSBvZiB0aGUgTGljZW5zZSBhdFxuICpcbiAqIGh0dHA6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMFxuICpcbiAqIFVubGVzcyByZXF1aXJlZCBieSBhcHBsaWNhYmxlIGxhdyBvciBhZ3JlZWQgdG8gaW4gd3JpdGluZywgc29mdHdhcmVcbiAqIGRpc3RyaWJ1dGVkIHVuZGVyIHRoZSBMaWNlbnNlIGlzIGRpc3RyaWJ1dGVkIG9uIGFuIFwiQVMgSVNcIiBCQVNJUyxcbiAqIFdJVEhPVVQgV0FSUkFOVElFUyBPUiBDT05ESVRJT05TIE9GIEFOWSBLSU5ELCBlaXRoZXIgZXhwcmVzcyBvciBpbXBsaWVkLlxuICogU2VlIHRoZSBMaWNlbnNlIGZvciB0aGUgc3BlY2lmaWMgbGFuZ3VhZ2UgZ292ZXJuaW5nIHBlcm1pc3Npb25zIGFuZFxuICogbGltaXRhdGlvbnMgdW5kZXIgdGhlIExpY2Vuc2UuXG4gKi9cblxuZXhwb3J0IHR5cGUgUHJvdG9jb2xDb21tYW5kID0ge1xuICBpZDogbnVtYmVyO1xuICBtZXRob2Q6IHN0cmluZztcbiAgcGFyYW1zPzogYW55O1xufTtcblxuLy8gVGhlIG5hcnJvdyBzdXJmYWNlIG9mIFJlbGF5Q29ubmVjdGlvbiB0aGF0IHByb3RvY29sIGhhbmRsZXJzIHVzZS5cbmV4cG9ydCBpbnRlcmZhY2UgUmVsYXlDb250ZXh0IHtcbiAgcmVhZG9ubHkgYXR0YWNoZWRUYWJzOiBSZWFkb25seVNldDxudW1iZXI+O1xuICBzZW5kTWVzc2FnZShtZXNzYWdlOiBhbnkpOiB2b2lkO1xuICAvLyBSZWNvcmRzIHRoYXQgYSB0YWIncyBkZWJ1Z2dlciBpcyBub3cgYXR0YWNoZWQuIEZpcmVzIG9udGFiYXR0YWNoZWQgb24gdGhlXG4gIC8vIG93bmluZyBSZWxheUNvbm5lY3Rpb24uXG4gIG5vdGlmeVRhYkF0dGFjaGVkKHRhYklkOiBudW1iZXIpOiB2b2lkO1xuICAvLyBSZWNvcmRzIHRoYXQgYSB0YWIncyBkZWJ1Z2dlciBpcyBub3cgZGV0YWNoZWQuIEZpcmVzIG9udGFiZGV0YWNoZWQgb24gdGhlXG4gIC8vIG93bmluZyBSZWxheUNvbm5lY3Rpb24uXG4gIG5vdGlmeVRhYkRldGFjaGVkKHRhYklkOiBudW1iZXIpOiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFByb3RvY29sSGFuZGxlciB7XG4gIGhhbmRsZUNvbW1hbmQobWVzc2FnZTogUHJvdG9jb2xDb21tYW5kKTogUHJvbWlzZTxhbnk+O1xuICAvLyBGb3J3YXJkcyBhbiBhbHJlYWR5LWZpbHRlcmVkIGNocm9tZS4qIGV2ZW50IChjb25jZXJuaW5nIGEgY3VycmVudGx5LWF0dGFjaGVkXG4gIC8vIHRhYikgdG8gdGhlIHJlbGF5LiBTaGFwZSBpcyBwcm90b2NvbC1zcGVjaWZpYy5cbiAgZm9yd2FyZENocm9tZUV2ZW50KGZ1bGxNZXRob2Q6IHN0cmluZywgYXJnczogYW55W10pOiB2b2lkO1xuICAvLyBUaGUgVUkgYWRkZWQgYSB0YWIgdG8gdGhlIFBsYXl3cmlnaHQgZ3JvdXAsIHdoZXRoZXIgYXMgdGhlIGluaXRpYWwgcGlja1xuICAvLyBmcm9tIHRoZSBjb25uZWN0IHBhZ2Ugb3IgZnJvbSBhIGxhdGVyIGRyYWctaW4uIEhhbmRsZXIgdGVsbHMgdGhlIHJlbGF5XG4gIC8vIHRoZSB0YWIgaXMgbm93IGF2YWlsYWJsZTsgdGhlIHJlbGF5IGF0dGFjaGVzIHZpYSB0aGUgdXN1YWwgY29tbWFuZCBwYXRoLlxuICBvblVzZXJBdHRhY2hSZXF1ZXN0KHRhYjogY2hyb21lLnRhYnMuVGFiKTogdm9pZDtcbiAgLy8gVGhlIFVJIHJlbW92ZWQgYSB0YWIuIFJlbGF5Q29ubmVjdGlvbiBoYXMgYWxyZWFkeSBkZXRhY2hlZCB0aGUgZGVidWdnZXJcbiAgLy8gYW5kIGNhbGxlZCBub3RpZnlUYWJEZXRhY2hlZDsgdGhlIGhhbmRsZXIgb25seSBzZW5kcyB0aGUgd2lyZS1sZXZlbFxuICAvLyBkZXRhY2ggbm90aWZpY2F0aW9uIChpZiB0aGUgcHJvdG9jb2wgaGFzIG9uZSkuXG4gIG9uVXNlckRldGFjaFJlcXVlc3QodGFiSWQ6IG51bWJlcik6IHZvaWQ7XG4gIC8vIFNpZ25hbHMgdGhhdCB0aGUgaW5pdGlhbCBzZXQgb2YgYG9uVXNlckF0dGFjaFJlcXVlc3RgIGNhbGxzIGlzIGNvbXBsZXRlLlxuICAvLyBGb3IgdjIgdGhpcyBzZW5kcyBgZXh0ZW5zaW9uLmluaXRpYWxpemVkYCBzbyB0aGUgcmVsYXkgY2FuIHVuYmxvY2sgQ0RQXG4gIC8vIHRyYWZmaWMgZnJvbSBQbGF5d3JpZ2h0OyB2MSBoYXMgbm8gaGFuZHNoYWtlIGFuZCBpZ25vcmVzIGl0LlxuICBkaWRJbml0aWFsaXplKCk6IHZvaWQ7XG59XG5cbi8vIOKUgOKUgOKUgCBQcm90b2NvbCB2MSAobGVnYWN5IHNpbmdsZS10YWIpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgY2xhc3MgUHJvdG9jb2xWMUhhbmRsZXIgaW1wbGVtZW50cyBQcm90b2NvbEhhbmRsZXIge1xuICBwcml2YXRlIF9jb250ZXh0OiBSZWxheUNvbnRleHQ7XG4gIHByaXZhdGUgX3NlbGVjdGVkVGFiUHJvbWlzZTogUHJvbWlzZTxudW1iZXI+O1xuICBwcml2YXRlIF9zZWxlY3RlZFRhYlJlc29sdmUhOiAodGFiSWQ6IG51bWJlcikgPT4gdm9pZDtcblxuICBjb25zdHJ1Y3Rvcihjb250ZXh0OiBSZWxheUNvbnRleHQpIHtcbiAgICB0aGlzLl9jb250ZXh0ID0gY29udGV4dDtcbiAgICB0aGlzLl9zZWxlY3RlZFRhYlByb21pc2UgPSBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHRoaXMuX3NlbGVjdGVkVGFiUmVzb2x2ZSA9IHJlc29sdmUpO1xuICB9XG5cbiAgYXN5bmMgaGFuZGxlQ29tbWFuZChtZXNzYWdlOiBQcm90b2NvbENvbW1hbmQpOiBQcm9taXNlPGFueT4ge1xuICAgIGlmIChtZXNzYWdlLm1ldGhvZCA9PT0gJ2F0dGFjaFRvVGFiJykge1xuICAgICAgY29uc3QgdGFiSWQgPSBhd2FpdCB0aGlzLl9zZWxlY3RlZFRhYlByb21pc2U7XG4gICAgICBjb25zdCBkZWJ1Z2dlZTogY2hyb21lLmRlYnVnZ2VyLkRlYnVnZ2VlID0geyB0YWJJZCB9O1xuICAgICAgYXdhaXQgY2hyb21lLmRlYnVnZ2VyLmF0dGFjaChkZWJ1Z2dlZSwgJzEuMycpO1xuICAgICAgdGhpcy5fY29udGV4dC5ub3RpZnlUYWJBdHRhY2hlZCh0YWJJZCk7XG4gICAgICBjb25zdCByZXN1bHQ6IGFueSA9IGF3YWl0IGNocm9tZS5kZWJ1Z2dlci5zZW5kQ29tbWFuZChkZWJ1Z2dlZSwgJ1RhcmdldC5nZXRUYXJnZXRJbmZvJyk7XG4gICAgICByZXR1cm4geyB0YXJnZXRJbmZvOiByZXN1bHQ/LnRhcmdldEluZm8gfTtcbiAgICB9XG4gICAgaWYgKG1lc3NhZ2UubWV0aG9kID09PSAnZm9yd2FyZENEUENvbW1hbmQnKSB7XG4gICAgICBjb25zdCB7IHNlc3Npb25JZCwgbWV0aG9kLCBwYXJhbXMgfSA9IG1lc3NhZ2UucGFyYW1zO1xuICAgICAgaWYgKG1ldGhvZCA9PT0gJ1RhcmdldC5jcmVhdGVUYXJnZXQnKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RhYiBjcmVhdGlvbiBpcyBub3Qgc3VwcG9ydGVkIHlldC4gVXBkYXRlIFBsYXl3cmlnaHQgTUNQIG9yIENMSSB0byB0aGUgbGF0ZXN0IHZlcnNpb24uJyk7XG4gICAgICBjb25zdCB0YWJJZCA9IFsuLi50aGlzLl9jb250ZXh0LmF0dGFjaGVkVGFic11bMF07XG4gICAgICBpZiAodGFiSWQgPT09IHVuZGVmaW5lZClcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdObyB0YWIgaXMgY29ubmVjdGVkJyk7XG4gICAgICBjb25zdCBkZWJ1Z2dlclNlc3Npb246IGNocm9tZS5kZWJ1Z2dlci5EZWJ1Z2dlclNlc3Npb24gPSB7IHRhYklkLCBzZXNzaW9uSWQgfTtcbiAgICAgIHJldHVybiBhd2FpdCBjaHJvbWUuZGVidWdnZXIuc2VuZENvbW1hbmQoZGVidWdnZXJTZXNzaW9uLCBtZXRob2QsIHBhcmFtcyk7XG4gICAgfVxuICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBtZXRob2Q6ICR7bWVzc2FnZS5tZXRob2R9YCk7XG4gIH1cblxuICBmb3J3YXJkQ2hyb21lRXZlbnQoZnVsbE1ldGhvZDogc3RyaW5nLCBhcmdzOiBhbnlbXSk6IHZvaWQge1xuICAgIC8vIHYxIG9ubHkgZm9yd2FyZHMgQ0RQIGV2ZW50cyBmcm9tIHRoZSBzaW5nbGUgYXR0YWNoZWQgdGFiOyBhbGwgb3RoZXJcbiAgICAvLyBjaHJvbWUgZXZlbnRzIGhhdmUgbm8gdjEgZXF1aXZhbGVudC5cbiAgICBpZiAoZnVsbE1ldGhvZCAhPT0gJ2Nocm9tZS5kZWJ1Z2dlci5vbkV2ZW50JylcbiAgICAgIHJldHVybjtcbiAgICBjb25zdCBbc291cmNlLCBtZXRob2QsIHBhcmFtc10gPSBhcmdzIGFzIFtjaHJvbWUuZGVidWdnZXIuRGVidWdnZXJTZXNzaW9uLCBzdHJpbmcsIGFueV07XG4gICAgdGhpcy5fY29udGV4dC5zZW5kTWVzc2FnZSh7XG4gICAgICBtZXRob2Q6ICdmb3J3YXJkQ0RQRXZlbnQnLFxuICAgICAgcGFyYW1zOiB7IHNlc3Npb25JZDogc291cmNlLnNlc3Npb25JZCwgbWV0aG9kLCBwYXJhbXMgfSxcbiAgICB9KTtcbiAgfVxuXG4gIG9uVXNlckF0dGFjaFJlcXVlc3QodGFiOiBjaHJvbWUudGFicy5UYWIpOiB2b2lkIHtcbiAgICAvLyB2MSBpcyBzaW5nbGUtdGFiIGJ5IGRlc2lnbjogdGhlIGZpcnN0IGF0dGFjaCBjYWxsIGRldGVybWluZXMgdGhlIHRhYlxuICAgIC8vIHVzZWQgYnkgdGhlIHBlbmRpbmcgYGF0dGFjaFRvVGFiYCBjb21tYW5kLiBMYXRlciBhdHRhY2ggcmVxdWVzdHMgYXJlXG4gICAgLy8gc2lsZW50bHkgaWdub3JlZCAoUHJvbWlzZS5yZXNvbHZlIGlzIGEgbm8tb3Agb25jZSByZXNvbHZlZCkuXG4gICAgaWYgKHRhYi5pZCAhPT0gdW5kZWZpbmVkKVxuICAgICAgdGhpcy5fc2VsZWN0ZWRUYWJSZXNvbHZlKHRhYi5pZCk7XG4gIH1cblxuICBvblVzZXJEZXRhY2hSZXF1ZXN0KF90YWJJZDogbnVtYmVyKTogdm9pZCB7XG4gICAgLy8gdjEgaGFzIG5vIHdpcmUtbGV2ZWwgZGV0YWNoIG5vdGlmaWNhdGlvbjsgd2hlbiB0aGUgbGFzdCB0YWIgZGV0YWNoZXMgdGhlXG4gICAgLy8gc29ja2V0IGNsb3NlcyBhbmQgdGhlIHJlbGF5IG5vdGljZXMuXG4gIH1cblxuICBkaWRJbml0aWFsaXplKCk6IHZvaWQge1xuICAgIC8vIHYxIGhhcyBubyBpbml0aWFsLXRhYi1saXN0IGhhbmRzaGFrZS4gYF9zZWxlY3RlZFRhYlByb21pc2VgIGlzIHJlc29sdmVkXG4gICAgLy8gYnkgdGhlIGZpcnN0IGBvblVzZXJBdHRhY2hSZXF1ZXN0YCwgd2hpY2ggYWxyZWFkeSB1bmJsb2NrcyBgYXR0YWNoVG9UYWJgLlxuICB9XG59XG5cbi8vIOKUgOKUgOKUgCBQcm90b2NvbCB2MiAocmVmbGVjdGl2ZSBjaHJvbWUuKikg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8vIEFsbG93LWxpc3RlZCBjaHJvbWUuKiBjb21tYW5kcyB0aGUgcmVsYXkgbWF5IGludm9rZS4gVGhlIGhhbmRsZXIgcmVzb2x2ZXNcbi8vIHRoZSBtZXRob2QgcmVmbGVjdGl2ZWx5IGFuZCBzcHJlYWRzIHBvc2l0aW9uYWwgcGFyYW1zLlxuY29uc3QgQUxMT1dFRF9DSFJPTUVfQ09NTUFORFMgPSBuZXcgU2V0KFtcbiAgJ2Nocm9tZS5kZWJ1Z2dlci5hdHRhY2gnLFxuICAnY2hyb21lLmRlYnVnZ2VyLmRldGFjaCcsXG4gICdjaHJvbWUuZGVidWdnZXIuc2VuZENvbW1hbmQnLFxuICAnY2hyb21lLnRhYnMuY3JlYXRlJyxcbiAgJ2Nocm9tZS50YWJzLnJlbW92ZScsXG5dKTtcblxuZXhwb3J0IGNsYXNzIFByb3RvY29sVjJIYW5kbGVyIGltcGxlbWVudHMgUHJvdG9jb2xIYW5kbGVyIHtcbiAgcHJpdmF0ZSBfY29udGV4dDogUmVsYXlDb250ZXh0O1xuXG4gIGNvbnN0cnVjdG9yKGNvbnRleHQ6IFJlbGF5Q29udGV4dCkge1xuICAgIHRoaXMuX2NvbnRleHQgPSBjb250ZXh0O1xuICB9XG5cbiAgYXN5bmMgaGFuZGxlQ29tbWFuZChtZXNzYWdlOiBQcm90b2NvbENvbW1hbmQpOiBQcm9taXNlPGFueT4ge1xuICAgIGlmIChBTExPV0VEX0NIUk9NRV9DT01NQU5EUy5oYXMobWVzc2FnZS5tZXRob2QpKSB7XG4gICAgICBjb25zdCBhcmdzID0gKG1lc3NhZ2UucGFyYW1zID8/IFtdKSBhcyBhbnlbXTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGludm9rZUNocm9tZU1ldGhvZChtZXNzYWdlLm1ldGhvZCwgYXJncyk7XG4gICAgICAvLyBBdHRhY2ggYm9va2tlZXBpbmc7IGRldGFjaCBmbG93cyB0aHJvdWdoIHRoZSBjaHJvbWUuZGVidWdnZXIub25EZXRhY2ggZXZlbnQuXG4gICAgICBpZiAobWVzc2FnZS5tZXRob2QgPT09ICdjaHJvbWUuZGVidWdnZXIuYXR0YWNoJykge1xuICAgICAgICBjb25zdCB0YXJnZXQgPSBhcmdzWzBdIGFzIGNocm9tZS5kZWJ1Z2dlci5EZWJ1Z2dlZSB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKHRhcmdldD8udGFiSWQgIT09IHVuZGVmaW5lZClcbiAgICAgICAgICB0aGlzLl9jb250ZXh0Lm5vdGlmeVRhYkF0dGFjaGVkKHRhcmdldC50YWJJZCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gcmVzdWx0ID8/IHt9O1xuICAgIH1cbiAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gbWV0aG9kOiAke21lc3NhZ2UubWV0aG9kfWApO1xuICB9XG5cbiAgZm9yd2FyZENocm9tZUV2ZW50KGZ1bGxNZXRob2Q6IHN0cmluZywgYXJnczogYW55W10pOiB2b2lkIHtcbiAgICB0aGlzLl9jb250ZXh0LnNlbmRNZXNzYWdlKHsgbWV0aG9kOiBmdWxsTWV0aG9kLCBwYXJhbXM6IGFyZ3MgfSk7XG4gIH1cblxuICBvblVzZXJBdHRhY2hSZXF1ZXN0KHRhYjogY2hyb21lLnRhYnMuVGFiKTogdm9pZCB7XG4gICAgLy8gU2ltdWxhdGUgYSBcIm5ldyB0YWIgb3BlbmVkXCIgZXZlbnQ7IHRoZSByZWxheSByZXNwb25kcyBieSBjYWxsaW5nXG4gICAgLy8gY2hyb21lLmRlYnVnZ2VyLmF0dGFjaCwgd2hpY2ggZmxvd3MgdGhyb3VnaCBoYW5kbGVDb21tYW5kLlxuICAgIHRoaXMuX2NvbnRleHQuc2VuZE1lc3NhZ2UoeyBtZXRob2Q6ICdjaHJvbWUudGFicy5vbkNyZWF0ZWQnLCBwYXJhbXM6IFt0YWJdIH0pO1xuICB9XG5cbiAgZGlkSW5pdGlhbGl6ZSgpOiB2b2lkIHtcbiAgICAvLyBTaWduYWxzIHRoZSBlbmQgb2YgdGhlIGluaXRpYWwtdGFiIGhhbmRzaGFrZS4gVGhlIHJlbGF5IGhvbGRzIENEUFxuICAgIC8vIHRyYWZmaWMgZnJvbSBQbGF5d3JpZ2h0IHVudGlsIGl0IHNlZXMgdGhpcyBldmVudCwgc28gdGhhdFxuICAgIC8vIGBUYXJnZXQuc2V0QXV0b0F0dGFjaGAgaXMgYW5zd2VyZWQgZnJvbSBhIHBvcHVsYXRlZCB0YWIgbW9kZWwuXG4gICAgdGhpcy5fY29udGV4dC5zZW5kTWVzc2FnZSh7IG1ldGhvZDogJ2V4dGVuc2lvbi5pbml0aWFsaXplZCcsIHBhcmFtczogW10gfSk7XG4gIH1cblxuICBvblVzZXJEZXRhY2hSZXF1ZXN0KHRhYklkOiBudW1iZXIpOiB2b2lkIHtcbiAgICAvLyBjaHJvbWUuZGVidWdnZXIuZGV0YWNoIGRvZXMgbm90IGZpcmUgb25EZXRhY2ggZm9yIHRoZSBjYWxsZXIsIHNvIHdlXG4gICAgLy8gc3ludGhlc2l6ZSBvbmUgc28gdGhlIHJlbGF5IG5vdGljZXMgdGhlIHRhYiBpcyBnb25lLlxuICAgIHRoaXMuX2NvbnRleHQuc2VuZE1lc3NhZ2Uoe1xuICAgICAgbWV0aG9kOiAnY2hyb21lLmRlYnVnZ2VyLm9uRGV0YWNoJyxcbiAgICAgIHBhcmFtczogW3sgdGFiSWQgfSwgJ3RhcmdldF9jbG9zZWQnXSxcbiAgICB9KTtcbiAgfVxufVxuXG4vLyDilIDilIDilIAgUmVmbGVjdGl2ZSBjaHJvbWUuKiBpbnZvY2F0aW9uIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vLyBSZXNvbHZlcyBjaHJvbWUuPGFwaT4uPG1lbWJlcj4uIEV4cG9ydGVkIHNvIFJlbGF5Q29ubmVjdGlvbiBjYW4gaW5zdGFsbFxuLy8gbGlzdGVuZXJzIG9uIHRoZSBzYW1lIHNldCBvZiBjaHJvbWUgZXZlbnRzIHdpdGhvdXQgZHVwbGljYXRpbmcgdGhlIHRyYXZlcnNhbC5cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlQ2hyb21lTWVtYmVyKGZ1bGxNZXRob2Q6IHN0cmluZyk6IHsgb2JqOiBhbnk7IG5hbWU6IHN0cmluZyB9IHtcbiAgY29uc3QgcGFydHMgPSBmdWxsTWV0aG9kLnNwbGl0KCcuJyk7XG4gIGlmIChwYXJ0c1swXSAhPT0gJ2Nocm9tZScgfHwgcGFydHMubGVuZ3RoIDwgMylcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgY2hyb21lIG1ldGhvZDogJHtmdWxsTWV0aG9kfWApO1xuICBsZXQgb2JqOiBhbnkgPSBjaHJvbWU7XG4gIGZvciAobGV0IGkgPSAxOyBpIDwgcGFydHMubGVuZ3RoIC0gMTsgaSsrKSB7XG4gICAgb2JqID0gb2JqPy5bcGFydHNbaV1dO1xuICAgIGlmIChvYmogPT09IHVuZGVmaW5lZClcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBjaHJvbWUgcGF0aDogJHtwYXJ0cy5zbGljZSgwLCBpICsgMSkuam9pbignLicpfSwgY2FsbGluZyAke2Z1bGxNZXRob2R9YCk7XG4gIH1cbiAgcmV0dXJuIHsgb2JqLCBuYW1lOiBwYXJ0c1twYXJ0cy5sZW5ndGggLSAxXSB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBpbnZva2VDaHJvbWVNZXRob2QoZnVsbE1ldGhvZDogc3RyaW5nLCBhcmdzOiBhbnlbXSk6IFByb21pc2U8YW55PiB7XG4gIGNvbnN0IHsgb2JqLCBuYW1lIH0gPSByZXNvbHZlQ2hyb21lTWVtYmVyKGZ1bGxNZXRob2QpO1xuICBjb25zdCBmbiA9IG9ialtuYW1lXSBhcyAoLi4uYTogYW55W10pID0+IGFueTtcbiAgaWYgKHR5cGVvZiBmbiAhPT0gJ2Z1bmN0aW9uJylcbiAgICB0aHJvdyBuZXcgRXJyb3IoYE5vdCBhIGZ1bmN0aW9uOiAke2Z1bGxNZXRob2R9YCk7XG4gIHJldHVybiBhd2FpdCBmbi5hcHBseShvYmosIGFyZ3MpO1xufVxuIiwiLyoqXG4gKiBDb3B5cmlnaHQgKGMpIE1pY3Jvc29mdCBDb3Jwb3JhdGlvbi5cbiAqXG4gKiBMaWNlbnNlZCB1bmRlciB0aGUgQXBhY2hlIExpY2Vuc2UsIFZlcnNpb24gMi4wICh0aGUgXCJMaWNlbnNlXCIpO1xuICogeW91IG1heSBub3QgdXNlIHRoaXMgZmlsZSBleGNlcHQgaW4gY29tcGxpYW5jZSB3aXRoIHRoZSBMaWNlbnNlLlxuICogWW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG4gKlxuICogaHR0cDovL3d3dy5hcGFjaGUub3JnL2xpY2Vuc2VzL0xJQ0VOU0UtMi4wXG4gKlxuICogVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuICogZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuICogV0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuXG4gKiBTZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG4gKiBsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiAqL1xuXG5leHBvcnQgZnVuY3Rpb24gZGVidWdMb2coLi4uYXJnczogdW5rbm93bltdKTogdm9pZCB7XG4gIGNvbnN0IGVuYWJsZWQgPSB0cnVlO1xuICBpZiAoZW5hYmxlZCkge1xuICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgY29uc29sZS5sb2coJ1tFeHRlbnNpb25dJywgLi4uYXJncyk7XG4gIH1cbn1cblxuaW1wb3J0IHtcbiAgUHJvdG9jb2xDb21tYW5kLCBQcm90b2NvbEhhbmRsZXIsIFByb3RvY29sVjFIYW5kbGVyLCBQcm90b2NvbFYySGFuZGxlcixcbiAgUmVsYXlDb250ZXh0LCByZXNvbHZlQ2hyb21lTWVtYmVyLFxufSBmcm9tICcuL3Byb3RvY29sSGFuZGxlcnMnO1xuXG50eXBlIFByb3RvY29sUmVzcG9uc2UgPSB7XG4gIGlkPzogbnVtYmVyO1xuICBtZXRob2Q/OiBzdHJpbmc7XG4gIHBhcmFtcz86IGFueTtcbiAgcmVzdWx0PzogYW55O1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIGNocm9tZS4qIGV2ZW50cyB0aGUgZXh0ZW5zaW9uIGZvcndhcmRzIHRvIHRoZSByZWxheSAocG9zaXRpb25hbCBwYXJhbXMpLlxuY29uc3QgQ0hST01FX0VWRU5UX01FVEhPRFMgPSBbXG4gICdjaHJvbWUuZGVidWdnZXIub25FdmVudCcsXG4gICdjaHJvbWUuZGVidWdnZXIub25EZXRhY2gnLFxuICAnY2hyb21lLnRhYnMub25DcmVhdGVkJyxcbiAgJ2Nocm9tZS50YWJzLm9uUmVtb3ZlZCcsXG5dO1xuXG5leHBvcnQgY2xhc3MgUmVsYXlDb25uZWN0aW9uIHtcbiAgcHJpdmF0ZSBfd3M6IFdlYlNvY2tldDtcbiAgcHJpdmF0ZSBfaGFuZGxlcjogUHJvdG9jb2xIYW5kbGVyO1xuICAvLyBUYWJzIHdob3NlIGRlYnVnZ2VyIHdlIGhhdmUgZXhwbGljaXRseSBhdHRhY2hlZCBmb3IgdGhpcyBjb25uZWN0aW9uLlxuICBwcml2YXRlIF9hdHRhY2hlZFRhYnMgPSBuZXcgU2V0PG51bWJlcj4oKTtcbiAgLy8gT25jZSB3ZSd2ZSBhdHRhY2hlZCBhdCBsZWFzdCBvbmUgdGFiLCBkZXRhY2hpbmcgdGhlIGxhc3Qgb25lIGNsb3NlcyB0aGUgY29ubmVjdGlvbi5cbiAgcHJpdmF0ZSBfaGFzRXZlckF0dGFjaGVkID0gZmFsc2U7XG4gIHByaXZhdGUgX2V2ZW50TGlzdGVuZXJzOiBBcnJheTx7IHJlbW92ZTogKCkgPT4gdm9pZCB9PiA9IFtdO1xuICBwcml2YXRlIF9jbG9zZWQgPSBmYWxzZTtcblxuICBvbmNsb3NlPzogKCkgPT4gdm9pZDtcbiAgb250YWJhdHRhY2hlZD86ICh0YWJJZDogbnVtYmVyKSA9PiB2b2lkO1xuICBvbnRhYmRldGFjaGVkPzogKHRhYklkOiBudW1iZXIpID0+IHZvaWQ7XG5cbiAgZ2V0IGF0dGFjaGVkVGFicygpOiBSZWFkb25seVNldDxudW1iZXI+IHtcbiAgICByZXR1cm4gdGhpcy5fYXR0YWNoZWRUYWJzO1xuICB9XG5cbiAgY29uc3RydWN0b3Iod3M6IFdlYlNvY2tldCwgcHJvdG9jb2xWZXJzaW9uOiBudW1iZXIpIHtcbiAgICB0aGlzLl93cyA9IHdzO1xuICAgIGNvbnN0IGNvbnRleHQ6IFJlbGF5Q29udGV4dCA9IHtcbiAgICAgIGF0dGFjaGVkVGFiczogdGhpcy5fYXR0YWNoZWRUYWJzLFxuICAgICAgc2VuZE1lc3NhZ2U6IG1zZyA9PiB0aGlzLl9zZW5kTWVzc2FnZShtc2cpLFxuICAgICAgbm90aWZ5VGFiQXR0YWNoZWQ6IHRhYklkID0+IHRoaXMuX25vdGlmeVRhYkF0dGFjaGVkKHRhYklkKSxcbiAgICAgIG5vdGlmeVRhYkRldGFjaGVkOiB0YWJJZCA9PiB0aGlzLl9ub3RpZnlUYWJEZXRhY2hlZCh0YWJJZCksXG4gICAgfTtcbiAgICB0aGlzLl9oYW5kbGVyID0gcHJvdG9jb2xWZXJzaW9uID09PSAxXG4gICAgICA/IG5ldyBQcm90b2NvbFYxSGFuZGxlcihjb250ZXh0KVxuICAgICAgOiBuZXcgUHJvdG9jb2xWMkhhbmRsZXIoY29udGV4dCk7XG4gICAgdGhpcy5faW5zdGFsbEV2ZW50Rm9yd2FyZGVycygpO1xuICAgIHRoaXMuX3dzLm9ubWVzc2FnZSA9IHRoaXMuX29uTWVzc2FnZS5iaW5kKHRoaXMpO1xuICAgIHRoaXMuX3dzLm9uY2xvc2UgPSAoKSA9PiB0aGlzLl9vbkNsb3NlKCk7XG4gIH1cblxuICAvLyBTaWduYWxzIHRoZSBlbmQgb2YgdGhlIGluaXRpYWwtdGFiIGhhbmRzaGFrZSDigJQgY2FsbCBhZnRlciB0aGUgaW5pdGlhbFxuICAvLyByb3VuZCBvZiBgYXR0YWNoVGFiYCBpbnZvY2F0aW9ucy4gRm9yIHYyIHRoaXMgc2VuZHMgYGV4dGVuc2lvbi5pbml0aWFsaXplZGBcbiAgLy8gc28gdGhlIHJlbGF5IGNhbiB1bmJsb2NrIFBsYXl3cmlnaHQgQ0RQIHRyYWZmaWM7IHYxIGhhcyBubyBoYW5kc2hha2UuXG4gIGRpZEluaXRpYWxpemUoKTogdm9pZCB7XG4gICAgdGhpcy5faGFuZGxlci5kaWRJbml0aWFsaXplKCk7XG4gIH1cblxuICBjbG9zZShtZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLl93cy5jbG9zZSgxMDAwLCBtZXNzYWdlKTtcbiAgICAvLyB3cy5vbmNsb3NlIGlzIGNhbGxlZCBhc3luY2hyb25vdXNseSwgc28gd2UgY2FsbCBpdCBoZXJlIHRvIGF2b2lkIGZvcndhcmRpbmdcbiAgICAvLyBDRFAgZXZlbnRzIHRvIHRoZSBjbG9zZWQgY29ubmVjdGlvbi5cbiAgICB0aGlzLl9vbkNsb3NlKCk7XG4gIH1cblxuICAvLyBDYWxsZWQgd2hlbiB0aGUgVUkgYWRkcyBhIHRhYiB0byB0aGUgUGxheXdyaWdodCBncm91cC4gVGhlIGhhbmRsZXIgYXNrc1xuICAvLyB0aGUgcmVsYXkgdG8gYXR0YWNoOyB0aGUgbm9ybWFsIGNvbW1hbmQgcGF0aCBmaXJlcyBvbnRhYmF0dGFjaGVkLlxuICBhdHRhY2hUYWIodGFiOiBjaHJvbWUudGFicy5UYWIpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5fY2xvc2VkIHx8IHRoaXMuX2F0dGFjaGVkVGFicy5oYXModGFiLmlkISkpXG4gICAgICByZXR1cm47XG4gICAgdGhpcy5faGFuZGxlci5vblVzZXJBdHRhY2hSZXF1ZXN0KHRhYik7XG4gIH1cblxuICAvLyBDYWxsZWQgd2hlbiB0aGUgVUkgcmVtb3ZlcyBhIHRhYiBmcm9tIHRoZSBQbGF5d3JpZ2h0IGdyb3VwLiBXZSBkZXRhY2ggdGhlXG4gIC8vIGRlYnVnZ2VyIGFuZCB1cGRhdGUgYm9va2tlZXBpbmc7IHRoZSBoYW5kbGVyIGVtaXRzIHRoZSB3aXJlLWxldmVsIGRldGFjaFxuICAvLyBub3RpZmljYXRpb24gZm9yIHByb3RvY29scyB0aGF0IGhhdmUgb25lLlxuICBkZXRhY2hUYWIodGFiSWQ6IG51bWJlcik6IHZvaWQge1xuICAgIGlmICh0aGlzLl9jbG9zZWQgfHwgIXRoaXMuX2F0dGFjaGVkVGFicy5oYXModGFiSWQpKVxuICAgICAgcmV0dXJuO1xuICAgIGNocm9tZS5kZWJ1Z2dlci5kZXRhY2goeyB0YWJJZCB9KS5jYXRjaChlcnJvciA9PiB7XG4gICAgICBkZWJ1Z0xvZygnRXJyb3IgZGV0YWNoaW5nIHRhYjonLCBlcnJvcik7XG4gICAgfSk7XG4gICAgdGhpcy5fbm90aWZ5VGFiRGV0YWNoZWQodGFiSWQpO1xuICAgIHRoaXMuX2hhbmRsZXIub25Vc2VyRGV0YWNoUmVxdWVzdCh0YWJJZCk7XG4gICAgdGhpcy5fY2hlY2tMYXN0VGFiRGV0YWNoZWQoKTtcbiAgfVxuXG4gIHByaXZhdGUgX25vdGlmeVRhYkF0dGFjaGVkKHRhYklkOiBudW1iZXIpOiB2b2lkIHtcbiAgICB0aGlzLl9hdHRhY2hlZFRhYnMuYWRkKHRhYklkKTtcbiAgICB0aGlzLl9oYXNFdmVyQXR0YWNoZWQgPSB0cnVlO1xuICAgIHRoaXMub250YWJhdHRhY2hlZD8uKHRhYklkKTtcbiAgfVxuXG4gIHByaXZhdGUgX25vdGlmeVRhYkRldGFjaGVkKHRhYklkOiBudW1iZXIpOiB2b2lkIHtcbiAgICB0aGlzLl9hdHRhY2hlZFRhYnMuZGVsZXRlKHRhYklkKTtcbiAgICB0aGlzLm9udGFiZGV0YWNoZWQ/Lih0YWJJZCk7XG4gIH1cblxuICBwcml2YXRlIF9pbnN0YWxsRXZlbnRGb3J3YXJkZXJzKCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgZnVsbE1ldGhvZCBvZiBDSFJPTUVfRVZFTlRfTUVUSE9EUykge1xuICAgICAgY29uc3QgdGFyZ2V0ID0gcmVzb2x2ZUNocm9tZU1lbWJlcihmdWxsTWV0aG9kKTtcbiAgICAgIGNvbnN0IGxpc3RlbmVyID0gKC4uLmFyZ3M6IGFueVtdKSA9PiB0aGlzLl9vbkNocm9tZUV2ZW50KGZ1bGxNZXRob2QsIGFyZ3MpO1xuICAgICAgdGFyZ2V0Lm9ialt0YXJnZXQubmFtZV0uYWRkTGlzdGVuZXIobGlzdGVuZXIpO1xuICAgICAgdGhpcy5fZXZlbnRMaXN0ZW5lcnMucHVzaCh7XG4gICAgICAgIHJlbW92ZTogKCkgPT4gdGFyZ2V0Lm9ialt0YXJnZXQubmFtZV0ucmVtb3ZlTGlzdGVuZXIobGlzdGVuZXIpLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBfb25DbG9zZSgpIHtcbiAgICBpZiAodGhpcy5fY2xvc2VkKVxuICAgICAgcmV0dXJuO1xuICAgIHRoaXMuX2Nsb3NlZCA9IHRydWU7XG4gICAgZm9yIChjb25zdCBsIG9mIHRoaXMuX2V2ZW50TGlzdGVuZXJzKVxuICAgICAgbC5yZW1vdmUoKTtcbiAgICB0aGlzLl9ldmVudExpc3RlbmVycyA9IFtdO1xuICAgIGZvciAoY29uc3QgdGFiSWQgb2YgWy4uLnRoaXMuX2F0dGFjaGVkVGFic10pIHtcbiAgICAgIGNocm9tZS5kZWJ1Z2dlci5kZXRhY2goeyB0YWJJZCB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICB0aGlzLl9ub3RpZnlUYWJEZXRhY2hlZCh0YWJJZCk7XG4gICAgfVxuICAgIHRoaXMub25jbG9zZT8uKCk7XG4gIH1cblxuICBwcml2YXRlIF9jaGVja0xhc3RUYWJEZXRhY2hlZCgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5faGFzRXZlckF0dGFjaGVkICYmIHRoaXMuX2F0dGFjaGVkVGFicy5zaXplID09PSAwKVxuICAgICAgdGhpcy5jbG9zZSgnQWxsIGNvbnRyb2xsZWQgdGFicyBkZXRhY2hlZCcpO1xuICB9XG5cbiAgLy8gRmlsdGVycyBjaHJvbWUuKiBldmVudHMgdG8gYXR0YWNoZWQgdGFicywgZGVsZWdhdGVzIHdpcmUgZm9ybWF0dGluZyB0byB0aGVcbiAgLy8gaGFuZGxlciwgdGhlbiBydW5zIHNoYXJlZCBkZXRhY2ggYm9va2tlZXBpbmcuXG4gIHByaXZhdGUgX29uQ2hyb21lRXZlbnQoZnVsbE1ldGhvZDogc3RyaW5nLCBhcmdzOiBhbnlbXSk6IHZvaWQge1xuICAgIGNvbnN0IHRhYklkID0gdGhpcy5fdGFiSWRGb3JFdmVudEFyZ3MoZnVsbE1ldGhvZCwgYXJncyk7XG4gICAgaWYgKHRhYklkID09PSB1bmRlZmluZWQgfHwgIXRoaXMuX2F0dGFjaGVkVGFicy5oYXModGFiSWQpKVxuICAgICAgcmV0dXJuO1xuICAgIHRoaXMuX2hhbmRsZXIuZm9yd2FyZENocm9tZUV2ZW50KGZ1bGxNZXRob2QsIGFyZ3MpO1xuICAgIC8vIGNocm9tZS5kZWJ1Z2dlci5vbkRldGFjaCBpcyB0aGUgc2luZ2xlIHNvdXJjZSBvZiB0cnV0aCBmb3IgZGV0YWNoIGJvb2trZWVwaW5nLlxuICAgIGlmIChmdWxsTWV0aG9kID09PSAnY2hyb21lLmRlYnVnZ2VyLm9uRGV0YWNoJykge1xuICAgICAgdGhpcy5fbm90aWZ5VGFiRGV0YWNoZWQodGFiSWQpO1xuICAgICAgdGhpcy5fY2hlY2tMYXN0VGFiRGV0YWNoZWQoKTtcbiAgICB9XG4gIH1cblxuICAvLyBSZXR1cm5zIHRoZSB0YWJJZCBhbiBldmVudCByZWZlcnMgdG8sIGZvciBmaWx0ZXJpbmcgYnkgX2F0dGFjaGVkVGFicy5cbiAgcHJpdmF0ZSBfdGFiSWRGb3JFdmVudEFyZ3MoZnVsbE1ldGhvZDogc3RyaW5nLCBhcmdzOiBhbnlbXSk6IG51bWJlciB8IHVuZGVmaW5lZCB7XG4gICAgc3dpdGNoIChmdWxsTWV0aG9kKSB7XG4gICAgICBjYXNlICdjaHJvbWUuZGVidWdnZXIub25FdmVudCc6XG4gICAgICBjYXNlICdjaHJvbWUuZGVidWdnZXIub25EZXRhY2gnOlxuICAgICAgICByZXR1cm4gKGFyZ3NbMF0gYXMgY2hyb21lLmRlYnVnZ2VyLkRlYnVnZ2VlIHwgdW5kZWZpbmVkKT8udGFiSWQ7XG4gICAgICBjYXNlICdjaHJvbWUudGFicy5vbkNyZWF0ZWQnOiB7XG4gICAgICAgIGNvbnN0IHRhYiA9IGFyZ3NbMF0gYXMgY2hyb21lLnRhYnMuVGFiO1xuICAgICAgICAvLyBGb3J3YXJkIG9ubHkgcG9wdXBzIG9wZW5lZCBieSBhbiBhdHRhY2hlZCB0YWI7IHJlcG9ydCB0aGUgb3BlbmVyIHNvIGNkcFJlbGF5XG4gICAgICAgIC8vIGNhbiBmaWx0ZXIgLyBkZWNpZGUuIFdlIHVzZSB0aGUgb3BlbmVyVGFiSWQgZm9yIHRoZSBhdHRhY2hlZC10YWIgY2hlY2suXG4gICAgICAgIHJldHVybiB0YWIub3BlbmVyVGFiSWQ7XG4gICAgICB9XG4gICAgICBjYXNlICdjaHJvbWUudGFicy5vblJlbW92ZWQnOlxuICAgICAgICByZXR1cm4gYXJnc1swXSBhcyBudW1iZXI7XG4gICAgfVxuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICBwcml2YXRlIF9vbk1lc3NhZ2UoZXZlbnQ6IE1lc3NhZ2VFdmVudCk6IHZvaWQge1xuICAgIHRoaXMuX29uTWVzc2FnZUFzeW5jKGV2ZW50KS5jYXRjaChlID0+IGRlYnVnTG9nKCdFcnJvciBoYW5kbGluZyBtZXNzYWdlOicsIGUpKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgX29uTWVzc2FnZUFzeW5jKGV2ZW50OiBNZXNzYWdlRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBsZXQgbWVzc2FnZTogUHJvdG9jb2xDb21tYW5kO1xuICAgIHRyeSB7XG4gICAgICBtZXNzYWdlID0gSlNPTi5wYXJzZShldmVudC5kYXRhKTtcbiAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICBkZWJ1Z0xvZyhgRXJyb3IgcGFyc2luZyBtZXNzYWdlICR7ZXZlbnQuZGF0YX06YCwgZXJyb3IpO1xuICAgICAgdGhpcy5fc2VuZEVycm9yKC0zMjcwMCwgYEVycm9yIHBhcnNpbmcgbWVzc2FnZTogJHtlcnJvci5tZXNzYWdlfWApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHJlc3BvbnNlOiBQcm90b2NvbFJlc3BvbnNlID0ge1xuICAgICAgaWQ6IG1lc3NhZ2UuaWQsXG4gICAgfTtcbiAgICB0cnkge1xuICAgICAgcmVzcG9uc2UucmVzdWx0ID0gYXdhaXQgdGhpcy5faGFuZGxlci5oYW5kbGVDb21tYW5kKG1lc3NhZ2UpO1xuICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAgIGRlYnVnTG9nKGBFcnJvciBoYW5kbGluZyBjb21tYW5kICR7SlNPTi5zdHJpbmdpZnkobWVzc2FnZSl9OmAsIGVycm9yKTtcbiAgICAgIHJlc3BvbnNlLmVycm9yID0gZXJyb3IubWVzc2FnZTtcbiAgICB9XG4gICAgdGhpcy5fc2VuZE1lc3NhZ2UocmVzcG9uc2UpO1xuICB9XG5cbiAgcHJpdmF0ZSBfc2VuZEVycm9yKGNvZGU6IG51bWJlciwgbWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5fc2VuZE1lc3NhZ2Uoe1xuICAgICAgZXJyb3I6IHtcbiAgICAgICAgY29kZSxcbiAgICAgICAgbWVzc2FnZSxcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIF9zZW5kTWVzc2FnZShtZXNzYWdlOiBhbnkpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5fd3MucmVhZHlTdGF0ZSA9PT0gV2ViU29ja2V0Lk9QRU4pXG4gICAgICB0aGlzLl93cy5zZW5kKEpTT04uc3RyaW5naWZ5KG1lc3NhZ2UpKTtcbiAgfVxufVxuIiwiLyoqXG4gKiBDb3B5cmlnaHQgKGMpIE1pY3Jvc29mdCBDb3Jwb3JhdGlvbi5cbiAqXG4gKiBMaWNlbnNlZCB1bmRlciB0aGUgQXBhY2hlIExpY2Vuc2UsIFZlcnNpb24gMi4wICh0aGUgXCJMaWNlbnNlXCIpO1xuICogeW91IG1heSBub3QgdXNlIHRoaXMgZmlsZSBleGNlcHQgaW4gY29tcGxpYW5jZSB3aXRoIHRoZSBMaWNlbnNlLlxuICogWW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG4gKlxuICogaHR0cDovL3d3dy5hcGFjaGUub3JnL2xpY2Vuc2VzL0xJQ0VOU0UtMi4wXG4gKlxuICogVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuICogZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuICogV0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuXG4gKiBTZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG4gKiBsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiAqL1xuXG5pbXBvcnQgeyBSZWxheUNvbm5lY3Rpb24sIGRlYnVnTG9nIH0gZnJvbSAnLi9yZWxheUNvbm5lY3Rpb24nO1xuXG5pbnRlcmZhY2UgUGVuZGluZ0VudHJ5IHtcbiAgY29ubmVjdCgpOiBQcm9taXNlPFJlbGF5Q29ubmVjdGlvbj47XG4gIGNsb3NlKHJlYXNvbjogc3RyaW5nKTogdm9pZDtcbn1cblxuY2xhc3MgRWFnZXJQZW5kaW5nIGltcGxlbWVudHMgUGVuZGluZ0VudHJ5IHtcbiAgcHJpdmF0ZSBfY29ubmVjdGlvbjogUmVsYXlDb25uZWN0aW9uO1xuICBvbmNsb3NlPzogKCkgPT4gdm9pZDtcblxuICBzdGF0aWMgYXN5bmMgY3JlYXRlKG1jcFJlbGF5VXJsOiBzdHJpbmcsIHByb3RvY29sVmVyc2lvbjogbnVtYmVyKTogUHJvbWlzZTxFYWdlclBlbmRpbmc+IHtcbiAgICBjb25zdCBjb25uZWN0aW9uID0gYXdhaXQgb3BlblJlbGF5Q29ubmVjdGlvbihtY3BSZWxheVVybCwgcHJvdG9jb2xWZXJzaW9uKTtcbiAgICByZXR1cm4gbmV3IEVhZ2VyUGVuZGluZyhjb25uZWN0aW9uKTtcbiAgfVxuXG4gIHByaXZhdGUgY29uc3RydWN0b3IoY29ubmVjdGlvbjogUmVsYXlDb25uZWN0aW9uKSB7XG4gICAgdGhpcy5fY29ubmVjdGlvbiA9IGNvbm5lY3Rpb247XG4gICAgdGhpcy5fY29ubmVjdGlvbi5vbmNsb3NlID0gKCkgPT4gdGhpcy5vbmNsb3NlPy4oKTtcbiAgfVxuXG4gIGFzeW5jIGNvbm5lY3QoKTogUHJvbWlzZTxSZWxheUNvbm5lY3Rpb24+IHtcbiAgICByZXR1cm4gdGhpcy5fY29ubmVjdGlvbjtcbiAgfVxuXG4gIGNsb3NlKHJlYXNvbjogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5fY29ubmVjdGlvbi5jbG9zZShyZWFzb24pO1xuICB9XG59XG5cbmNsYXNzIERlZmVycmVkUGVuZGluZyBpbXBsZW1lbnRzIFBlbmRpbmdFbnRyeSB7XG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgX21jcFJlbGF5VXJsOiBzdHJpbmcsIHByaXZhdGUgX3Byb3RvY29sVmVyc2lvbjogbnVtYmVyKSB7fVxuXG4gIGFzeW5jIGNvbm5lY3QoKTogUHJvbWlzZTxSZWxheUNvbm5lY3Rpb24+IHtcbiAgICByZXR1cm4gb3BlblJlbGF5Q29ubmVjdGlvbih0aGlzLl9tY3BSZWxheVVybCwgdGhpcy5fcHJvdG9jb2xWZXJzaW9uKTtcbiAgfVxuXG4gIGNsb3NlKF9yZWFzb246IHN0cmluZyk6IHZvaWQge1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBQZW5kaW5nQ29ubmVjdGlvbnMge1xuICBwcml2YXRlIF9tYXAgPSBuZXcgTWFwPG51bWJlciwgUGVuZGluZ0VudHJ5PigpO1xuXG4gIGNvbnN0cnVjdG9yKCkge1xuICAgIGNocm9tZS50YWJzLm9uUmVtb3ZlZC5hZGRMaXN0ZW5lcih0aGlzLl9vblRhYlJlbW92ZWQuYmluZCh0aGlzKSk7XG4gIH1cblxuICAvLyB2MSBvcGVucyB0aGUgcmVsYXkgV1MgZWFnZXJseSDigJQgdGhlIGRhZW1vbiBleHBlY3RzIGEgcHJvbXB0IGNvbm5lY3Rpb24uXG4gIC8vIHYyIHJlY29yZHMgb25seSB0aGUgZGVzY3JpcHRvcjsgdGhlIFdTIG9wZW5zIGxhemlseSBpbiBgdGFrZWAgb25jZSB0aGVcbiAgLy8gdXNlciBjbGlja3MgQWxsb3cuXG4gIGFzeW5jIGNyZWF0ZShzZWxlY3RvclRhYklkOiBudW1iZXIsIG1jcFJlbGF5VXJsOiBzdHJpbmcsIHByb3RvY29sVmVyc2lvbjogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHByb3RvY29sVmVyc2lvbiAhPT0gMSkge1xuICAgICAgdGhpcy5fbWFwLnNldChzZWxlY3RvclRhYklkLCBuZXcgRGVmZXJyZWRQZW5kaW5nKG1jcFJlbGF5VXJsLCBwcm90b2NvbFZlcnNpb24pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgZW50cnkgPSBhd2FpdCBFYWdlclBlbmRpbmcuY3JlYXRlKG1jcFJlbGF5VXJsLCBwcm90b2NvbFZlcnNpb24pO1xuICAgIGVudHJ5Lm9uY2xvc2UgPSAoKSA9PiB7XG4gICAgICBpZiAodGhpcy5fbWFwLmdldChzZWxlY3RvclRhYklkKSAhPT0gZW50cnkpXG4gICAgICAgIHJldHVybjtcbiAgICAgIHRoaXMuX21hcC5kZWxldGUoc2VsZWN0b3JUYWJJZCk7XG4gICAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZShzZWxlY3RvclRhYklkLCB7IHR5cGU6ICdwZW5kaW5nQ29ubmVjdGlvbkNsb3NlZCcgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAgIH07XG4gICAgdGhpcy5fbWFwLnNldChzZWxlY3RvclRhYklkLCBlbnRyeSk7XG4gIH1cblxuICBhc3luYyB0YWtlKHNlbGVjdG9yVGFiSWQ6IG51bWJlcik6IFByb21pc2U8UmVsYXlDb25uZWN0aW9uIHwgdW5kZWZpbmVkPiB7XG4gICAgY29uc3QgZW50cnkgPSB0aGlzLl9tYXAuZ2V0KHNlbGVjdG9yVGFiSWQpO1xuICAgIGlmICghZW50cnkpXG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIHRoaXMuX21hcC5kZWxldGUoc2VsZWN0b3JUYWJJZCk7XG4gICAgcmV0dXJuIGVudHJ5LmNvbm5lY3QoKTtcbiAgfVxuXG4gIHByaXZhdGUgX29uVGFiUmVtb3ZlZCh0YWJJZDogbnVtYmVyKTogdm9pZCB7XG4gICAgY29uc3QgZW50cnkgPSB0aGlzLl9tYXAuZ2V0KHRhYklkKTtcbiAgICBpZiAoIWVudHJ5KVxuICAgICAgcmV0dXJuO1xuICAgIHRoaXMuX21hcC5kZWxldGUodGFiSWQpO1xuICAgIGVudHJ5LmNsb3NlKCdCcm93c2VyIHRhYiBjbG9zZWQnKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBvcGVuUmVsYXlDb25uZWN0aW9uKG1jcFJlbGF5VXJsOiBzdHJpbmcsIHByb3RvY29sVmVyc2lvbjogbnVtYmVyKTogUHJvbWlzZTxSZWxheUNvbm5lY3Rpb24+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzb2NrZXQgPSBuZXcgV2ViU29ja2V0KG1jcFJlbGF5VXJsKTtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBzb2NrZXQub25vcGVuID0gKCkgPT4gcmVzb2x2ZSgpO1xuICAgICAgc29ja2V0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QobmV3IEVycm9yKCdXZWJTb2NrZXQgZXJyb3InKSk7XG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHJlamVjdChuZXcgRXJyb3IoJ0Nvbm5lY3Rpb24gdGltZW91dCcpKSwgNTAwMCk7XG4gICAgfSk7XG4gICAgcmV0dXJuIG5ldyBSZWxheUNvbm5lY3Rpb24oc29ja2V0LCBwcm90b2NvbFZlcnNpb24pO1xuICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGBGYWlsZWQgdG8gY29ubmVjdCB0byBNQ1AgcmVsYXk6ICR7ZXJyb3IubWVzc2FnZX1gO1xuICAgIGRlYnVnTG9nKG1lc3NhZ2UpO1xuICAgIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbiAgfVxufVxuIiwiLyoqXG4gKiBDb3B5cmlnaHQgKGMpIE1pY3Jvc29mdCBDb3Jwb3JhdGlvbi5cbiAqXG4gKiBMaWNlbnNlZCB1bmRlciB0aGUgQXBhY2hlIExpY2Vuc2UsIFZlcnNpb24gMi4wICh0aGUgXCJMaWNlbnNlXCIpO1xuICogeW91IG1heSBub3QgdXNlIHRoaXMgZmlsZSBleGNlcHQgaW4gY29tcGxpYW5jZSB3aXRoIHRoZSBMaWNlbnNlLlxuICogWW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG4gKlxuICogaHR0cDovL3d3dy5hcGFjaGUub3JnL2xpY2Vuc2VzL0xJQ0VOU0UtMi4wXG4gKlxuICogVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuICogZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuICogV0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuXG4gKiBTZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG4gKiBsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiAqL1xuXG5pbXBvcnQgeyBSZWxheUNvbm5lY3Rpb24sIGRlYnVnTG9nIH0gZnJvbSAnLi9yZWxheUNvbm5lY3Rpb24nO1xuXG5jb25zdCBQTEFZV1JJR0hUX0dST1VQX1RJVExFID0gJ1BsYXl3cmlnaHQnO1xuY29uc3QgUExBWVdSSUdIVF9HUk9VUF9DT0xPUiA9ICdncmVlbic7XG5jb25zdCBOT05fREVCVUdHQUJMRV9TQ0hFTUVTID0gWydjaHJvbWU6JywgJ2VkZ2U6JywgJ2RldnRvb2xzOiddO1xuY29uc3QgQ09OTkVDVEVEX0JBREdFID0geyB0ZXh0OiAn4pyTJywgY29sb3I6ICcjNENBRjUwJywgdGl0bGU6ICdDb25uZWN0ZWQgdG8gUGxheXdyaWdodCBjbGllbnQnIH07XG5cbmV4cG9ydCBmdW5jdGlvbiBpc05vbkRlYnVnZ2FibGVVcmwodXJsOiBzdHJpbmcgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcbiAgcmV0dXJuICEhdXJsICYmIE5PTl9ERUJVR0dBQkxFX1NDSEVNRVMuc29tZShzID0+IHVybC5zdGFydHNXaXRoKHMpKTtcbn1cblxuLy8gVW5ncm91cHMgYW55IFBsYXl3cmlnaHQtdGl0bGVkIGdyb3VwcyBsZWZ0IGJlaGluZCBieSBhIHByaW9yIHNlcnZpY2Ugd29ya2VyLlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFudXBTdGFsZVBsYXl3cmlnaHRHcm91cHMoKTogUHJvbWlzZTx2b2lkPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgZ3JvdXBzID0gYXdhaXQgY2hyb21lLnRhYkdyb3Vwcy5xdWVyeSh7IHRpdGxlOiBQTEFZV1JJR0hUX0dST1VQX1RJVExFIH0pO1xuICAgIGNvbnN0IHRhYnNQZXJHcm91cCA9IGF3YWl0IFByb21pc2UuYWxsKGdyb3Vwcy5tYXAoZyA9PiBjaHJvbWUudGFicy5xdWVyeSh7IGdyb3VwSWQ6IGcuaWQgfSkpKTtcbiAgICBjb25zdCB0YWJJZHMgPSB0YWJzUGVyR3JvdXAuZmxhdCgpLm1hcCh0ID0+IHQuaWQpLmZpbHRlcigoaWQpOiBpZCBpcyBudW1iZXIgPT4gaWQgIT09IHVuZGVmaW5lZCk7XG4gICAgaWYgKHRhYklkcy5sZW5ndGgpXG4gICAgICBhd2FpdCBjaHJvbWUudGFicy51bmdyb3VwKHRhYklkcyk7XG4gIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICBkZWJ1Z0xvZygnRXJyb3IgY2xlYW5pbmcgdXAgc3RhbGUgZ3JvdXBzOicsIGVycm9yKTtcbiAgfVxufVxuXG4vLyBUaGUgUGxheXdyaWdodCB0YWIgZ3JvdXAgZm9yIGFuIGFjdGl2ZSBSZWxheUNvbm5lY3Rpb24uIFRoZSBDaHJvbWUgdGFiIGdyb3VwXG4vLyBpcyB0aGUgc2luZ2xlIHNvdXJjZSBvZiB0cnV0aCBmb3Igd2hpY2ggdGFicyB0aGUgY2xpZW50IHRhcmdldHM6XG4vLyAgLSBVc2VyIGRyYWdzIGEgdGFiIGluL291dCDihpIgYF9vblRhYkdyb3VwQ2hhbmdlZGAgYXR0YWNoZXMvZGV0YWNoZXMuXG4vLyAgLSBSZWxheSBhdHRhY2hlcyBvbiBpdHMgb3duIChpbml0aWFsIHRhYiwgcG9wdXAsIFRhcmdldC5jcmVhdGVUYXJnZXQpIOKGklxuLy8gICAgYF9vblRhYkF0dGFjaGVkYCBwdWxscyB0aGUgbmV3IHRhYiBpbnRvIHRoZSBncm91cCwgd2hvc2Ugb25VcGRhdGVkIGV2ZW50XG4vLyAgICBmbG93cyBiYWNrIHRocm91Z2ggYF9vblRhYkdyb3VwQ2hhbmdlZGAgZm9yIGNvbnNpc3RlbmN5LlxuLy8gYF9ncm91cFRhYklkc2AgY2FjaGVzIGdyb3VwIG1lbWJlcnNoaXAgZnJvbSBDaHJvbWUgZXZlbnRzIHNvIGhvdC1wYXRoIGNoZWNrc1xuLy8gaW4gYF9vblRhYlVwZGF0ZWRgIHN0YXkgc3luY2hyb25vdXMuXG5leHBvcnQgY2xhc3MgQ29ubmVjdGVkVGFiR3JvdXAge1xuICBwcml2YXRlIF9jb25uZWN0aW9uOiBSZWxheUNvbm5lY3Rpb247XG4gIHByaXZhdGUgX2dyb3VwSWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIF9ncm91cFRhYklkczogU2V0PG51bWJlcj4gPSBuZXcgU2V0KCk7XG4gIHByaXZhdGUgX29uVGFiVXBkYXRlZExpc3RlbmVyOiAodGFiSWQ6IG51bWJlciwgY2hhbmdlSW5mbzogY2hyb21lLnRhYnMuVGFiQ2hhbmdlSW5mbywgdGFiOiBjaHJvbWUudGFicy5UYWIpID0+IHZvaWQ7XG4gIHByaXZhdGUgX29uVGFiUmVtb3ZlZExpc3RlbmVyOiAodGFiSWQ6IG51bWJlcikgPT4gdm9pZDtcblxuICBvbmNsb3NlPzogKCkgPT4gdm9pZDtcblxuICBjb25zdHJ1Y3Rvcihjb25uZWN0aW9uOiBSZWxheUNvbm5lY3Rpb24sIHNlbGVjdGVkVGFiOiBjaHJvbWUudGFicy5UYWIpIHtcbiAgICB0aGlzLl9jb25uZWN0aW9uID0gY29ubmVjdGlvbjtcbiAgICB0aGlzLl9jb25uZWN0aW9uLm9uY2xvc2UgPSAoKSA9PiB0aGlzLl9vbkNvbm5lY3Rpb25DbG9zZSgpO1xuICAgIHRoaXMuX2Nvbm5lY3Rpb24ub250YWJhdHRhY2hlZCA9ICh0YWJJZDogbnVtYmVyKSA9PiB0aGlzLl9vblRhYkF0dGFjaGVkKHRhYklkKTtcbiAgICB0aGlzLl9jb25uZWN0aW9uLm9udGFiZGV0YWNoZWQgPSAodGFiSWQ6IG51bWJlcikgPT4gdGhpcy5fb25UYWJEZXRhY2hlZCh0YWJJZCk7XG4gICAgdGhpcy5fb25UYWJVcGRhdGVkTGlzdGVuZXIgPSB0aGlzLl9vblRhYlVwZGF0ZWQuYmluZCh0aGlzKTtcbiAgICB0aGlzLl9vblRhYlJlbW92ZWRMaXN0ZW5lciA9IHRoaXMuX29uVGFiUmVtb3ZlZC5iaW5kKHRoaXMpO1xuICAgIGNocm9tZS50YWJzLm9uVXBkYXRlZC5hZGRMaXN0ZW5lcih0aGlzLl9vblRhYlVwZGF0ZWRMaXN0ZW5lcik7XG4gICAgY2hyb21lLnRhYnMub25SZW1vdmVkLmFkZExpc3RlbmVyKHRoaXMuX29uVGFiUmVtb3ZlZExpc3RlbmVyKTtcbiAgICAvLyBTZWVkIHRoZSByZWxheSB3aXRoIHRoZSB1c2VyLXNlbGVjdGVkIHRhYiwgdGhlbiBjbG9zZSBvdXQgdGhlIGluaXRpYWxcbiAgICAvLyBoYW5kc2hha2UuIFRoZSByZWxheSBob2xkcyBQbGF5d3JpZ2h0LXNpZGUgQ0RQIHRyYWZmaWMgdW50aWxcbiAgICAvLyBgZGlkSW5pdGlhbGl6ZWAgYXJyaXZlcywgc28gaXQgc2VlcyBhIGZ1bGx5IHBvcHVsYXRlZCB0YWIgbW9kZWwgYnkgdGhlXG4gICAgLy8gdGltZSBpdCBoYW5kbGVzIGBUYXJnZXQuc2V0QXV0b0F0dGFjaGAuXG4gICAgdGhpcy5fY29ubmVjdGlvbi5hdHRhY2hUYWIoc2VsZWN0ZWRUYWIpO1xuICAgIHRoaXMuX2Nvbm5lY3Rpb24uZGlkSW5pdGlhbGl6ZSgpO1xuICB9XG5cbiAgY29ubmVjdGVkVGFiSWRzKCk6IG51bWJlcltdIHtcbiAgICByZXR1cm4gWy4uLnRoaXMuX2dyb3VwVGFiSWRzXTtcbiAgfVxuXG4gIGNsb3NlKHJlYXNvbjogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5fY29ubmVjdGlvbi5jbG9zZShyZWFzb24pO1xuICB9XG5cbiAgcHJpdmF0ZSBfb25UYWJVcGRhdGVkKHRhYklkOiBudW1iZXIsIGNoYW5nZUluZm86IGNocm9tZS50YWJzLlRhYkNoYW5nZUluZm8sIHRhYjogY2hyb21lLnRhYnMuVGFiKTogdm9pZCB7XG4gICAgaWYgKGNoYW5nZUluZm8uZ3JvdXBJZCAhPT0gdW5kZWZpbmVkKVxuICAgICAgdGhpcy5fb25UYWJHcm91cENoYW5nZWQodGFiSWQsIHRhYik7XG4gICAgaWYgKGNoYW5nZUluZm8udXJsID09PSB1bmRlZmluZWQpXG4gICAgICByZXR1cm47XG4gICAgLy8gQ2hyb21lIHJlc2V0cyBwZXItdGFiIGJhZGdlIHN0YXRlIG9uIG5hdmlnYXRpb24sIHNvIHJlLWFwcGx5IGl0LlxuICAgIGlmICh0aGlzLl9jb25uZWN0aW9uLmF0dGFjaGVkVGFicy5oYXModGFiSWQpKVxuICAgICAgdm9pZCB0aGlzLl91cGRhdGVCYWRnZSh0YWJJZCwgQ09OTkVDVEVEX0JBREdFKTtcbiAgICBlbHNlIGlmICh0aGlzLl9ncm91cFRhYklkcy5oYXModGFiSWQpICYmICFpc05vbkRlYnVnZ2FibGVVcmwoY2hhbmdlSW5mby51cmwpKVxuICAgICAgdGhpcy5fY29ubmVjdGlvbi5hdHRhY2hUYWIodGFiKTtcbiAgfVxuXG4gIC8vIFNpbmdsZSBlbnRyeSBwb2ludCBmb3IgZ3JvdXAgbWVtYmVyc2hpcCBjaGFuZ2VzLCB3aGV0aGVyIHRoZSB1c2VyIGRyYWdnZWRcbiAgLy8gb3Igd2UgZ3JvdXBlZCB0aGUgdGFiIG91cnNlbHZlcy4gQXR0YWNoZXMgb24gZW50cnkgKGlmIGRlYnVnZ2FibGUpIGFuZFxuICAvLyBkZXRhY2hlcyBvbiBleGl0OyBhIGNocm9tZTovLyB0YWIgc3RheXMgaW4gdGhlIGdyb3VwIHVudGlsIGl0IG5hdmlnYXRlc1xuICAvLyAoaGFuZGxlZCBpbiBfb25UYWJVcGRhdGVkKS5cbiAgcHJpdmF0ZSBfb25UYWJHcm91cENoYW5nZWQodGFiSWQ6IG51bWJlciwgdGFiOiBjaHJvbWUudGFicy5UYWIpOiB2b2lkIHtcbiAgICBjb25zdCBpbk91ckdyb3VwID0gdGhpcy5fZ3JvdXBJZCAhPT0gbnVsbCAmJiB0YWIuZ3JvdXBJZCA9PT0gdGhpcy5fZ3JvdXBJZDtcbiAgICBjb25zdCB3YXNJbkdyb3VwID0gdGhpcy5fZ3JvdXBUYWJJZHMuaGFzKHRhYklkKTtcbiAgICBpZiAoaW5PdXJHcm91cCA9PT0gd2FzSW5Hcm91cClcbiAgICAgIHJldHVybjtcbiAgICBpZiAoaW5PdXJHcm91cCkge1xuICAgICAgdGhpcy5fZ3JvdXBUYWJJZHMuYWRkKHRhYklkKTtcbiAgICAgIGlmICghaXNOb25EZWJ1Z2dhYmxlVXJsKHRhYi51cmwpKVxuICAgICAgICB0aGlzLl9jb25uZWN0aW9uLmF0dGFjaFRhYih0YWIpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl9ncm91cFRhYklkcy5kZWxldGUodGFiSWQpO1xuICAgICAgaWYgKHRoaXMuX2Nvbm5lY3Rpb24uYXR0YWNoZWRUYWJzLmhhcyh0YWJJZCkpXG4gICAgICAgIHRoaXMuX2Nvbm5lY3Rpb24uZGV0YWNoVGFiKHRhYklkKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIF9vblRhYlJlbW92ZWQodGFiSWQ6IG51bWJlcik6IHZvaWQge1xuICAgIHRoaXMuX2dyb3VwVGFiSWRzLmRlbGV0ZSh0YWJJZCk7XG4gIH1cblxuICBwcml2YXRlIF9vblRhYkF0dGFjaGVkKHRhYklkOiBudW1iZXIpOiB2b2lkIHtcbiAgICB2b2lkIHRoaXMuX3VwZGF0ZUJhZGdlKHRhYklkLCBDT05ORUNURURfQkFER0UpO1xuICAgIHZvaWQgdGhpcy5fYWRkVGFiVG9Hcm91cCh0YWJJZCk7XG4gIH1cblxuICAvLyBUaGUgZGVidWdnZXIgZGV0YWNoZWQgKGRyYWctb3V0LCB0YWIgY2xvc2UsIG9yIGV4dGVybmFsIGFjdGlvbikuIENsZWFyIHRoZVxuICAvLyBiYWRnZSBidXQgbGVhdmUgdGhlIHRhYiBpbiB0aGUgZ3JvdXAg4oCUIHRoZSB1c2VyJ3MgaW50ZW50IGlzIHN0aWxsIHRoZXJlLFxuICAvLyBhbmQgYSBzdWJzZXF1ZW50IG5hdmlnYXRpb24gd2lsbCByZS1hdHRhY2ggdmlhIF9vblRhYlVwZGF0ZWQuXG4gIHByaXZhdGUgX29uVGFiRGV0YWNoZWQodGFiSWQ6IG51bWJlcik6IHZvaWQge1xuICAgIHZvaWQgdGhpcy5fdXBkYXRlQmFkZ2UodGFiSWQsIHsgdGV4dDogJycgfSk7XG4gIH1cblxuICBwcml2YXRlIF9vbkNvbm5lY3Rpb25DbG9zZSgpOiB2b2lkIHtcbiAgICBjaHJvbWUudGFicy5vblVwZGF0ZWQucmVtb3ZlTGlzdGVuZXIodGhpcy5fb25UYWJVcGRhdGVkTGlzdGVuZXIpO1xuICAgIGNocm9tZS50YWJzLm9uUmVtb3ZlZC5yZW1vdmVMaXN0ZW5lcih0aGlzLl9vblRhYlJlbW92ZWRMaXN0ZW5lcik7XG4gICAgY29uc3QgZ3JvdXBUYWJzID0gWy4uLnRoaXMuX2dyb3VwVGFiSWRzXTtcbiAgICB0aGlzLl9ncm91cFRhYklkcy5jbGVhcigpO1xuICAgIGlmIChncm91cFRhYnMubGVuZ3RoKSB7XG4gICAgICB0aGlzLl9yZXRyeU9uRHJhZygoKSA9PiBjaHJvbWUudGFicy51bmdyb3VwKGdyb3VwVGFicykpLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgZGVidWdMb2coJ0Vycm9yIHVuZ3JvdXBpbmcgdGFicyBvbiBjbG9zZTonLCBlcnJvcik7XG4gICAgICB9KTtcbiAgICB9XG4gICAgdGhpcy5vbmNsb3NlPy4oKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgX3VwZGF0ZUJhZGdlKHRhYklkOiBudW1iZXIsIHsgdGV4dCwgY29sb3IsIHRpdGxlIH06IHsgdGV4dDogc3RyaW5nOyBjb2xvcj86IHN0cmluZywgdGl0bGU/OiBzdHJpbmcgfSk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICAgIGNocm9tZS5hY3Rpb24uc2V0QmFkZ2VUZXh0KHsgdGFiSWQsIHRleHQgfSksXG4gICAgICAgIGNocm9tZS5hY3Rpb24uc2V0VGl0bGUoeyB0YWJJZCwgdGl0bGU6IHRpdGxlIHx8ICcnIH0pLFxuICAgICAgICBjb2xvciA/IGNocm9tZS5hY3Rpb24uc2V0QmFkZ2VCYWNrZ3JvdW5kQ29sb3IoeyB0YWJJZCwgY29sb3IgfSkgOiBQcm9taXNlLnJlc29sdmUoKSxcbiAgICAgIF0pO1xuICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAgIC8vIElnbm9yZSBlcnJvcnMgYXMgdGhlIHRhYiBtYXkgYmUgY2xvc2VkIGFscmVhZHkuXG4gICAgfVxuICB9XG5cbiAgLy8gTW92ZXMgYW4gYWxyZWFkeS1hdHRhY2hlZCB0YWIgaW50byBvdXIgQ2hyb21lIHRhYiBncm91cCwgY3JlYXRpbmcgaXQgb25cbiAgLy8gZmlyc3QgdXNlLiBgX2dyb3VwVGFiSWRzYCBpcyB1cGRhdGVkIGFmdGVyIHRoZSBhd2FpdCBzbyBhbiBvblVwZGF0ZWQgZXZlbnRcbiAgLy8gdGhhdCBhcnJpdmVzIGNvbmN1cnJlbnRseSAoYF9ncm91cElkYCBzdGlsbCBudWxsLCB3YXNJbkdyb3VwIHN0aWxsIGZhbHNlKVxuICAvLyBiZWNvbWVzIGEgaGFybWxlc3Mgbm8tb3AgcmF0aGVyIHRoYW4gdGFraW5nIHRoZSBkcmFnLW91dCBicmFuY2guXG4gIHByaXZhdGUgYXN5bmMgX2FkZFRhYlRvR3JvdXAodGFiSWQ6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLl9ncm91cFRhYklkcy5oYXModGFiSWQpKVxuICAgICAgcmV0dXJuO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCB0aGlzLl9yZXRyeU9uRHJhZyhhc3luYyAoKSA9PiB7XG4gICAgICAgIGlmICh0aGlzLl9ncm91cElkID09PSBudWxsKSB7XG4gICAgICAgICAgdGhpcy5fZ3JvdXBJZCA9IGF3YWl0IGNocm9tZS50YWJzLmdyb3VwKHsgdGFiSWRzOiBbdGFiSWRdIH0pO1xuICAgICAgICAgIGF3YWl0IGNocm9tZS50YWJHcm91cHMudXBkYXRlKHRoaXMuX2dyb3VwSWQsIHsgY29sb3I6IFBMQVlXUklHSFRfR1JPVVBfQ09MT1IsIHRpdGxlOiBQTEFZV1JJR0hUX0dST1VQX1RJVExFIH0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGF3YWl0IGNocm9tZS50YWJzLmdyb3VwKHsgZ3JvdXBJZDogdGhpcy5fZ3JvdXBJZCwgdGFiSWRzOiBbdGFiSWRdIH0pO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIHRoaXMuX2dyb3VwVGFiSWRzLmFkZCh0YWJJZCk7XG4gICAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgICAgZGVidWdMb2coJ0Vycm9yIGFkZGluZyB0YWIgdG8gZ3JvdXA6JywgZXJyb3IpO1xuICAgIH1cbiAgfVxuXG4gIC8vIENocm9tZSB0aHJvd3MgXCJ1c2VyIG1heSBiZSBkcmFnZ2luZyBhIHRhYlwiIHdoaWxlIGEgZHJhZyBpcyBpbiBwcm9ncmVzcy5cbiAgLy8gUmV0cnkgd2l0aCBiYWNrb2ZmIHVudGlsIGl0IGNsZWFycyAob3Igd2UgZ2l2ZSB1cCkuXG4gIHByaXZhdGUgYXN5bmMgX3JldHJ5T25EcmFnKGZuOiAoKSA9PiBQcm9taXNlPHZvaWQ+KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgZGVsYXlzID0gWzAsIDEwMCwgMjAwLCA0MDAsIDgwMF07XG4gICAgbGV0IGxhc3RFcnJvcjogdW5rbm93bjtcbiAgICBmb3IgKGNvbnN0IGRlbGF5IG9mIGRlbGF5cykge1xuICAgICAgaWYgKGRlbGF5KVxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgZGVsYXkpKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGZuKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAgICAgaWYgKCFlcnJvcj8ubWVzc2FnZT8uaW5jbHVkZXMoJ3VzZXIgbWF5IGJlIGRyYWdnaW5nIGEgdGFiJykpXG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIGxhc3RFcnJvciA9IGVycm9yO1xuICAgICAgfVxuICAgIH1cbiAgICB0aHJvdyBsYXN0RXJyb3I7XG4gIH1cbn1cbiIsIi8qKlxuICogQ29weXJpZ2h0IChjKSBNaWNyb3NvZnQgQ29ycG9yYXRpb24uXG4gKlxuICogTGljZW5zZWQgdW5kZXIgdGhlIEFwYWNoZSBMaWNlbnNlLCBWZXJzaW9uIDIuMCAodGhlIFwiTGljZW5zZVwiKTtcbiAqIHlvdSBtYXkgbm90IHVzZSB0aGlzIGZpbGUgZXhjZXB0IGluIGNvbXBsaWFuY2Ugd2l0aCB0aGUgTGljZW5zZS5cbiAqIFlvdSBtYXkgb2J0YWluIGEgY29weSBvZiB0aGUgTGljZW5zZSBhdFxuICpcbiAqIGh0dHA6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMFxuICpcbiAqIFVubGVzcyByZXF1aXJlZCBieSBhcHBsaWNhYmxlIGxhdyBvciBhZ3JlZWQgdG8gaW4gd3JpdGluZywgc29mdHdhcmVcbiAqIGRpc3RyaWJ1dGVkIHVuZGVyIHRoZSBMaWNlbnNlIGlzIGRpc3RyaWJ1dGVkIG9uIGFuIFwiQVMgSVNcIiBCQVNJUyxcbiAqIFdJVEhPVVQgV0FSUkFOVElFUyBPUiBDT05ESVRJT05TIE9GIEFOWSBLSU5ELCBlaXRoZXIgZXhwcmVzcyBvciBpbXBsaWVkLlxuICogU2VlIHRoZSBMaWNlbnNlIGZvciB0aGUgc3BlY2lmaWMgbGFuZ3VhZ2UgZ292ZXJuaW5nIHBlcm1pc3Npb25zIGFuZFxuICogbGltaXRhdGlvbnMgdW5kZXIgdGhlIExpY2Vuc2UuXG4gKi9cblxuaW1wb3J0IHsgZGVidWdMb2cgfSBmcm9tICcuL3JlbGF5Q29ubmVjdGlvbic7XG5pbXBvcnQgeyBQZW5kaW5nQ29ubmVjdGlvbnMgfSBmcm9tICcuL3BlbmRpbmdDb25uZWN0aW9uJztcbmltcG9ydCB7IENvbm5lY3RlZFRhYkdyb3VwLCBjbGVhbnVwU3RhbGVQbGF5d3JpZ2h0R3JvdXBzLCBpc05vbkRlYnVnZ2FibGVVcmwgfSBmcm9tICcuL2Nvbm5lY3RlZFRhYkdyb3VwJztcblxudHlwZSBQYWdlTWVzc2FnZSA9IHtcbiAgdHlwZTogJ2Nvbm5lY3Rpb25SZXF1ZXN0ZWQnO1xuICBtY3BSZWxheVVybDogc3RyaW5nO1xuICBwcm90b2NvbFZlcnNpb246IG51bWJlcjtcbn0gfCB7XG4gIHR5cGU6ICdnZXRUYWJzJztcbn0gfCB7XG4gIHR5cGU6ICdjb25uZWN0VG9UYWInO1xuICAvLyBQaWNrZWQgaW4gdGhlIGNvbm5lY3QgcGFnZTsgYWJzZW50IG9uIHRoZSB0b2tlbi1ieXBhc3MgcGF0aCB3aGVyZSBubyB0YWJcbiAgLy8gc2VsZWN0aW9uIGhhcHBlbnMuXG4gIHRhYj86IGNocm9tZS50YWJzLlRhYjtcbiAgY2xpZW50TmFtZT86IHN0cmluZztcbn0gfCB7XG4gIHR5cGU6ICdnZXRDb25uZWN0aW9uU3RhdHVzJztcbn0gfCB7XG4gIHR5cGU6ICdkaXNjb25uZWN0Jztcbn0gfCB7XG4gIHR5cGU6ICdrZWVwYWxpdmUnO1xufTtcblxuY2xhc3MgUGxheXdyaWdodEV4dGVuc2lvbiB7XG4gIHByaXZhdGUgX2FjdGl2ZUdyb3VwOiBDb25uZWN0ZWRUYWJHcm91cCB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSBfYWN0aXZlQ2xpZW50TmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBwcml2YXRlIF9wZW5kaW5nQ29ubmVjdGlvbnMgPSBuZXcgUGVuZGluZ0Nvbm5lY3Rpb25zKCk7XG4gIC8vIFNlcnZpY2Ugd29ya2VyIHJlc3RhcnRzIGxvc2UgYWxsIGNvbm5lY3Rpb24gc3RhdGUsIHNvIGFueSBleGlzdGluZ1xuICAvLyBQbGF5d3JpZ2h0IGdyb3VwcyBhcmUgc3RhbGUuIENvbm5lY3Rpb25zIHdhaXQgb24gdGhpcyBiZWZvcmUgcmVjb25jaWxpbmcuXG4gIHByaXZhdGUgX2NsZWFudXBQcm9taXNlOiBQcm9taXNlPHZvaWQ+O1xuXG4gIGNvbnN0cnVjdG9yKCkge1xuICAgIGNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcih0aGlzLl9vbk1lc3NhZ2UuYmluZCh0aGlzKSk7XG4gICAgY2hyb21lLmFjdGlvbi5vbkNsaWNrZWQuYWRkTGlzdGVuZXIodGhpcy5fb25BY3Rpb25DbGlja2VkLmJpbmQodGhpcykpO1xuICAgIHRoaXMuX2NsZWFudXBQcm9taXNlID0gY2xlYW51cFN0YWxlUGxheXdyaWdodEdyb3VwcygpO1xuICB9XG5cbiAgLy8gUHJvbWlzZS1iYXNlZCBtZXNzYWdlIGhhbmRsaW5nIGlzIG5vdCBzdXBwb3J0ZWQgaW4gQ2hyb21lOiBodHRwczovL2lzc3Vlcy5jaHJvbWl1bS5vcmcvaXNzdWVzLzQwNzUzMDMxXG4gIHByaXZhdGUgX29uTWVzc2FnZShtZXNzYWdlOiBQYWdlTWVzc2FnZSwgc2VuZGVyOiBjaHJvbWUucnVudGltZS5NZXNzYWdlU2VuZGVyLCBzZW5kUmVzcG9uc2U6IChyZXNwb25zZTogYW55KSA9PiB2b2lkKSB7XG4gICAgc3dpdGNoIChtZXNzYWdlLnR5cGUpIHtcbiAgICAgIGNhc2UgJ2Nvbm5lY3Rpb25SZXF1ZXN0ZWQnOlxuICAgICAgICB0aGlzLl9wZW5kaW5nQ29ubmVjdGlvbnMuY3JlYXRlKHNlbmRlci50YWIhLmlkISwgbWVzc2FnZS5tY3BSZWxheVVybCwgbWVzc2FnZS5wcm90b2NvbFZlcnNpb24pLnRoZW4oXG4gICAgICAgICAgICAoKSA9PiBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlIH0pLFxuICAgICAgICAgICAgKGVycm9yOiBhbnkpID0+IHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogZXJyb3IubWVzc2FnZSB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgY2FzZSAnZ2V0VGFicyc6XG4gICAgICAgIHRoaXMuX2dldFRhYnMoKS50aGVuKFxuICAgICAgICAgICAgdGFicyA9PiBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlLCB0YWJzLCBjdXJyZW50VGFiSWQ6IHNlbmRlci50YWI/LmlkIH0pLFxuICAgICAgICAgICAgKGVycm9yOiBhbnkpID0+IHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogZXJyb3IubWVzc2FnZSB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgY2FzZSAnY29ubmVjdFRvVGFiJzoge1xuICAgICAgICAvLyBUb2tlbi1ieXBhc3MgKG5vIHNwZWNpZmljIHBpY2spIGZhbGxzIGJhY2sgdG8gdGhlIGNvbm5lY3QgcGFnZSBpdHNlbGZcbiAgICAgICAgLy8gc28gYENvbm5lY3RlZFRhYkdyb3VwYCBhbHdheXMgaGFzIGEgY29uY3JldGUgdGFiIHRvIHN0YXJ0IGZyb20uIEJvdGhcbiAgICAgICAgLy8gc2VuZGVyLnRhYiBhbmQgVUktc3VwcGxpZWQgdGFicyBjb21lIGZyb20gY2hyb21lLnRhYnMucXVlcnkgLyBydW50aW1lXG4gICAgICAgIC8vIG1lc3NhZ2Ugc2VuZGVyLCB3aGVyZSBgaWRgIGlzIGFsd2F5cyBkZWZpbmVkLlxuICAgICAgICBjb25zdCBzZWxlY3RlZFRhYiA9IChtZXNzYWdlLnRhYiA/PyBzZW5kZXIudGFiISkgYXMgY2hyb21lLnRhYnMuVGFiICYgeyBpZDogbnVtYmVyIH07XG4gICAgICAgIHRoaXMuX2Nvbm5lY3RUYWIoc2VuZGVyLnRhYiEuaWQhLCBzZWxlY3RlZFRhYiwgbWVzc2FnZS5jbGllbnROYW1lKS50aGVuKFxuICAgICAgICAgICAgKCkgPT4gc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSB9KSxcbiAgICAgICAgICAgIChlcnJvcjogYW55KSA9PiBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGVycm9yLm1lc3NhZ2UgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTsgLy8gUmV0dXJuIHRydWUgdG8gaW5kaWNhdGUgdGhhdCB0aGUgcmVzcG9uc2Ugd2lsbCBiZSBzZW50IGFzeW5jaHJvbm91c2x5XG4gICAgICB9XG4gICAgICBjYXNlICdnZXRDb25uZWN0aW9uU3RhdHVzJzpcbiAgICAgICAgc2VuZFJlc3BvbnNlKHtcbiAgICAgICAgICBjb25uZWN0ZWRUYWJJZHM6IHRoaXMuX2FjdGl2ZUdyb3VwPy5jb25uZWN0ZWRUYWJJZHMoKSA/PyBbXSxcbiAgICAgICAgICBjbGllbnROYW1lOiB0aGlzLl9hY3RpdmVDbGllbnROYW1lLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgY2FzZSAnZGlzY29ubmVjdCc6XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgdGhpcy5fZGlzY29ubmVjdCgnVXNlciBkaXNjb25uZWN0ZWQnKTtcbiAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlIH0pO1xuICAgICAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICAgICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBlcnJvci5tZXNzYWdlIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgY2FzZSAna2VlcGFsaXZlJzpcbiAgICAgICAgLy8gQ29ubmVjdCBwYWdlIHBpbmdzIHVzIGV2ZXJ5IH4yMHMgc28gcmVjZWl2aW5nIHRoaXMgbWVzc2FnZSByZXNldHNcbiAgICAgICAgLy8gdGhlIE1WMyBzZXJ2aWNlIHdvcmtlciBpZGxlIHRpbWVyIGFuZCBrZWVwcyB0aGUgcmVsYXkgV2ViU29ja2V0IGFsaXZlLlxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBfY29ubmVjdFRhYihzZWxlY3RvclRhYklkOiBudW1iZXIsIHRhYjogY2hyb21lLnRhYnMuVGFiICYgeyBpZDogbnVtYmVyIH0sIGNsaWVudE5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCB0aGlzLl9jbGVhbnVwUHJvbWlzZTtcbiAgICAgIHRoaXMuX2Rpc2Nvbm5lY3QoJ0Fub3RoZXIgY29ubmVjdGlvbiBpcyByZXF1ZXN0ZWQnKTtcblxuICAgICAgY29uc3QgY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuX3BlbmRpbmdDb25uZWN0aW9ucy50YWtlKHNlbGVjdG9yVGFiSWQpO1xuICAgICAgaWYgKCFjb25uZWN0aW9uKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1BlbmRpbmcgY2xpZW50IGNvbm5lY3Rpb24gY2xvc2VkJyk7XG5cbiAgICAgIGNvbnN0IGdyb3VwID0gbmV3IENvbm5lY3RlZFRhYkdyb3VwKGNvbm5lY3Rpb24sIHRhYik7XG4gICAgICBncm91cC5vbmNsb3NlID0gKCkgPT4ge1xuICAgICAgICBpZiAodGhpcy5fYWN0aXZlR3JvdXAgPT09IGdyb3VwKSB7XG4gICAgICAgICAgdGhpcy5fYWN0aXZlR3JvdXAgPSB1bmRlZmluZWQ7XG4gICAgICAgICAgdGhpcy5fYWN0aXZlQ2xpZW50TmFtZSA9IHVuZGVmaW5lZDtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIHRoaXMuX2FjdGl2ZUdyb3VwID0gZ3JvdXA7XG4gICAgICB0aGlzLl9hY3RpdmVDbGllbnROYW1lID0gY2xpZW50TmFtZTtcblxuICAgICAgYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICBjaHJvbWUudGFicy51cGRhdGUodGFiLmlkLCB7IGFjdGl2ZTogdHJ1ZSB9KSxcbiAgICAgICAgY2hyb21lLndpbmRvd3MudXBkYXRlKHRhYi53aW5kb3dJZCwgeyBmb2N1c2VkOiB0cnVlIH0pLFxuICAgICAgXSkuY2F0Y2goKCkgPT4ge30pO1xuXG4gICAgICBpZiAodGFiLmlkICE9PSBzZWxlY3RvclRhYklkKVxuICAgICAgICBhd2FpdCBjaHJvbWUudGFicy5yZW1vdmUoc2VsZWN0b3JUYWJJZCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAgIGRlYnVnTG9nKGBGYWlsZWQgdG8gY29ubmVjdCB0YWIgJHt0YWIuaWR9OmAsIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBfZ2V0VGFicygpOiBQcm9taXNlPGNocm9tZS50YWJzLlRhYltdPiB7XG4gICAgY29uc3QgdGFicyA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHt9KTtcbiAgICByZXR1cm4gdGFicy5maWx0ZXIodGFiID0+ICFpc05vbkRlYnVnZ2FibGVVcmwodGFiLnVybCkpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBfb25BY3Rpb25DbGlja2VkKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IGNocm9tZS50YWJzLmNyZWF0ZSh7XG4gICAgICB1cmw6IGNocm9tZS5ydW50aW1lLmdldFVSTCgnc3RhdHVzLmh0bWwnKSxcbiAgICAgIGFjdGl2ZTogdHJ1ZVxuICAgIH0pO1xuICB9XG5cbiAgLy8gQ2xvc2VzIHRoZSBhY3RpdmUgZ3JvdXAncyBjb25uZWN0aW9uIGlmIGFueS4gQ29ubmVjdGVkVGFiR3JvdXAncyBvbmNsb3NlXG4gIC8vIGhhbmRsZXMgc3RhdGUgY2xlYW51cCAoY29ubmVjdGVkVGFiSWRzLCBiYWRnZXMsIHJlY29uY2lsZSkuXG4gIHByaXZhdGUgX2Rpc2Nvbm5lY3QocmVhc29uOiBzdHJpbmcpIHtcbiAgICB0aGlzLl9hY3RpdmVHcm91cD8uY2xvc2UocmVhc29uKTtcbiAgICB0aGlzLl9hY3RpdmVHcm91cCA9IHVuZGVmaW5lZDtcbiAgICB0aGlzLl9hY3RpdmVDbGllbnROYW1lID0gdW5kZWZpbmVkO1xuICB9XG59XG5cbm5ldyBQbGF5d3JpZ2h0RXh0ZW5zaW9uKCk7XG4iXSwibmFtZXMiOlsiX2EiXSwibWFwcGluZ3MiOiI7OztBQXVETyxNQUFNLGtCQUE2QztBQUFBLEVBS3hELFlBQVksU0FBdUI7QUFKM0I7QUFDQTtBQUNBO0FBR04sU0FBSyxXQUFXO0FBQ2hCLFNBQUssc0JBQXNCLElBQUksUUFBUSxDQUFBLFlBQVcsS0FBSyxzQkFBc0Is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

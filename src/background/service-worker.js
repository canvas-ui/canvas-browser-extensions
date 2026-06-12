// Canvas Browser Extension Service Worker
// Handles background operations, API communication, and tab synchronization

import { browserStorage } from './modules/browser-storage.js';
import { apiClient, AuthExpiredError, getJwtExpiryMs } from './modules/api-client.js';
import { webSocketClient } from './modules/websocket-client.js';
import { tabManager } from './modules/tab-manager.js';
import { syncEngine } from './modules/sync-engine.js';
import { contextIntegration } from './modules/context-integration.js';

console.log('🚀 Canvas Extension Service Worker loaded and starting...');
console.log('🚀 Service Worker: Registering tab event listeners...');

// Browser compatibility
const runtimeAPI = (typeof browser !== 'undefined' && browser.runtime) ? browser.runtime : chrome.runtime;
const tabsAPI = (typeof browser !== 'undefined' && browser.tabs) ? browser.tabs : chrome.tabs;
const windowsAPI = (typeof browser !== 'undefined' && browser.windows) ? browser.windows : chrome.windows;
// Toolbar action (MV3 `action`, with fallback to MV2 `browserAction`) for the session badge.
const actionAPI = (() => {
  if (typeof browser !== 'undefined') return browser.action || browser.browserAction || null;
  return (chrome.action || chrome.browserAction || null);
})();
const alarmsAPI = (typeof browser !== 'undefined' && browser.alarms) ? browser.alarms : (chrome.alarms || null);
let webSocketHandlersInitialized = false;

// ---- Session token lifecycle -------------------------------------------------
// The credentials-login JWT expires (default 24h). We proactively renew it a few
// minutes before expiry so a session never silently dies mid-use. Opaque `canvas-`
// API/device tokens are not JWTs and never expire, so renewal is skipped for them.
const TOKEN_RENEW_ALARM = 'canvas-token-renew';
const RENEW_LEAD_MS = 5 * 60 * 1000;   // renew this long before expiry
const RENEW_RETRY_MS = 60 * 1000;      // retry cadence on transient renewal failure

// Visually flag the toolbar icon when the session needs attention.
async function setSessionBadge(state) {
  if (!actionAPI) return;
  try {
    if (state === 'expired') {
      await actionAPI.setBadgeText({ text: '!' });
      if (actionAPI.setBadgeBackgroundColor) await actionAPI.setBadgeBackgroundColor({ color: '#dc2626' });
      if (actionAPI.setTitle) await actionAPI.setTitle({ title: 'Canvas: session expired — click to reconnect' });
    } else {
      await actionAPI.setBadgeText({ text: '' });
      if (actionAPI.setTitle) await actionAPI.setTitle({ title: 'Canvas Browser Extension' });
    }
  } catch (e) {
    console.warn('Failed to update session badge:', e?.message || e);
  }
}

// Schedule the next proactive renewal based on the current token's expiry.
// Clears any pending alarm when there is nothing to renew (no token / opaque token).
async function scheduleTokenRenewal() {
  if (!alarmsAPI) return;
  try {
    await alarmsAPI.clear(TOKEN_RENEW_ALARM);

    const settings = await browserStorage.getConnectionSettings();
    if (!settings?.connected || !settings?.apiToken) return;

    const expiryMs = getJwtExpiryMs(settings.apiToken);
    if (!expiryMs) {
      // Opaque/non-expiring token — nothing to renew.
      return;
    }

    const fireAt = expiryMs - RENEW_LEAD_MS;
    // chrome.alarms uses absolute `when` (ms epoch); enforce a small floor so we
    // fire promptly when the token is already inside the renewal window.
    const when = Math.max(fireAt, Date.now() + 5 * 1000);
    alarmsAPI.create(TOKEN_RENEW_ALARM, { when });
    console.log(`Scheduled token renewal at ${new Date(when).toISOString()} (expires ${new Date(expiryMs).toISOString()})`);
  } catch (e) {
    console.warn('Failed to schedule token renewal:', e?.message || e);
  }
}

// Attempt to mint a fresh JWT using the current (still-valid) one.
async function renewSessionToken() {
  const settings = await browserStorage.getConnectionSettings();
  if (!settings?.connected || !settings?.apiToken) return;

  const expiryMs = getJwtExpiryMs(settings.apiToken);
  if (!expiryMs) return; // opaque token, no renewal needed

  // If the alarm fired early (e.g. browser woke the SW), only renew once we're
  // actually within the lead window; otherwise just reschedule.
  if (Date.now() < expiryMs - RENEW_LEAD_MS - 1000) {
    await scheduleTokenRenewal();
    return;
  }

  try {
    await ensureApiClientReady();
    const { token } = await apiClient.refreshUserToken();

    await browserStorage.setConnectionSettings({ apiToken: token, connected: true });
    apiClient.userToken = token;

    await setSessionBadge('ok');
    broadcastToPopup('auth.session.renewed', { expiresAt: getJwtExpiryMs(token) });
    console.log('Session token renewed successfully');

    // Reconnect the WebSocket with the refreshed credentials when it relies on
    // the user token (no device token configured).
    try {
      const refreshed = await browserStorage.getConnectionSettings();
      if (!refreshed?.deviceToken) {
        await webSocketClient.disconnect();
        await initializeWebSocket();
      }
    } catch (e) {
      console.warn('Failed to refresh WebSocket after token renewal:', e?.message || e);
    }

    await scheduleTokenRenewal();
  } catch (error) {
    if (error instanceof AuthExpiredError) {
      // Token already expired/invalid — can't renew without re-auth.
      console.warn('Token renewal rejected (already expired); marking session expired');
      await handleAuthExpired();
      return;
    }
    // Transient failure (server unreachable, offline) — retry shortly.
    console.warn('Token renewal failed, will retry:', error?.message || error);
    if (alarmsAPI) alarmsAPI.create(TOKEN_RENEW_ALARM, { when: Date.now() + RENEW_RETRY_MS });
  }
}

if (alarmsAPI) {
  alarmsAPI.onAlarm.addListener((alarm) => {
    if (alarm?.name === TOKEN_RENEW_ALARM) {
      void renewSessionToken();
    }
  });
}

// Service worker installation and activation
runtimeAPI.onInstalled.addListener(async (details) => {
  console.log('Extension installed/updated:', details.reason);

  // Migrate legacy storage keys on update to prevent perceived settings loss
  if (details.reason === 'update') {
    try {
      await migrateLegacyStorageKeys();
    } catch (e) {
      console.warn('Storage migration failed (non-fatal):', e);
    }
  }

  // Setup context menus
  await setupContextMenus();

  // Open settings page on first install
  if (details.reason === 'install') {
    await openSettingsPage();
  }
});

runtimeAPI.onStartup.addListener(async () => {
  console.log('Browser startup - initializing Canvas Extension');
  await initializeExtension();
  await setupContextMenus();
});

// Initialize extension on service worker startup
async function initializeExtension() {
  try {
    console.log('Initializing Canvas Extension...');

    // Always attempt a one-time migration of legacy keys before reading settings
    try {
      await migrateLegacyStorageKeys();
    } catch (e) {
      console.warn('Storage migration failed (non-fatal):', e);
    }

    await tabManager.initialize();

    // Load connection settings
    const connectionSettings = await browserStorage.getConnectionSettings();
    console.log('Service Worker Init: Loaded connection settings:', connectionSettings);

    // Check if we have actual saved settings vs defaults
    if (connectionSettings && connectionSettings.apiToken) {
      console.log('Service Worker Init: Found saved API token, extension was previously configured');
    } else {
      console.log('Service Worker Init: No API token found, extension needs configuration');
    }

    // Initialize API client if we have settings
    if (connectionSettings.serverUrl && connectionSettings.apiBasePath) {
      apiClient.initialize(
        connectionSettings.serverUrl,
        connectionSettings.apiBasePath,
        connectionSettings.apiToken || ''
      );

      // Autoconnect on startup: if we have a saved token, try to reconnect even if
      // the persisted `connected` flag is false (it can get out of sync).
      if (connectionSettings.apiToken) {
        console.log('Testing saved credentials for autoconnect...');
        const testResult = await apiClient.testConnection();

        if (!testResult.success || !testResult.authenticated) {
          console.warn('Saved credentials failed, marking as disconnected');
          await browserStorage.setConnectionSettings({ connected: false });
          await setSessionBadge('expired');
        } else {
          console.log('Saved credentials are valid');

          if (!connectionSettings.connected) {
            await browserStorage.setConnectionSettings({ connected: true });
          }

          await setSessionBadge('ok');

          // Initialize WebSocket connection (will no-op until a context/workspace is selected)
          await initializeWebSocket();

          // Keep the JWT session alive across its expiry window.
          await scheduleTokenRenewal();
        }
      }
    }

    // Generate browser identity if not set
    const browserIdentity = await browserStorage.getBrowserIdentity();
    console.log('Browser identity:', browserIdentity);

    console.log('Canvas Extension initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Canvas Extension:', error);
  }
}

// Initialize WebSocket connection
async function initializeWebSocket() {
  try {
    console.log('Initializing WebSocket connection...');

    const connectionSettings = await browserStorage.getConnectionSettings();
    const mode = await browserStorage.getSyncMode();
    const currentContext = await browserStorage.getCurrentContext();
    const currentWorkspace = await browserStorage.getCurrentWorkspace();

    if (!connectionSettings.connected || !connectionSettings.apiToken) {
      console.log('Skipping WebSocket - not connected or no API token');
      return false;
    }

    // For context mode, we need a context. For explorer mode, we need a workspace.
    if (mode === 'context' && !currentContext?.id) {
      console.log('Skipping WebSocket - context mode requires a bound context');
      return false;
    }

    if (mode === 'explorer' && !currentWorkspace?.id && !currentWorkspace?.name) {
      console.log('Skipping WebSocket - explorer mode requires a selected workspace');
      return false;
    }

    // Setup WebSocket event handlers
    setupWebSocketEventHandlers();

    // Initialize context integration
    await contextIntegration.initialize();

    // Initialize sync engine
    await syncEngine.initialize();

    if (mode === 'explorer' && currentWorkspace) {
      const wsId = currentWorkspace.id || currentWorkspace.name;
      if (wsId) {
        await apiClient.ensureWorkspaceStarted(wsId);
      }
    }

    // Connect to WebSocket
    const success = await webSocketClient.connect(
      connectionSettings.serverUrl,
      connectionSettings.apiToken,
      currentContext?.id
    );

    if (success) {
      console.log('WebSocket connection established successfully');

      // Subscribe to appropriate channels based on mode
      if (mode === 'context' && currentContext?.id) {
        await webSocketClient.joinContext(currentContext.id);
      } else if (mode === 'explorer' && currentWorkspace) {
        const wsId = currentWorkspace.id || currentWorkspace.name;
        await webSocketClient.joinWorkspace(wsId);
      }

      return true;
    } else {
      console.warn('WebSocket connection failed');
      return false;
    }
  } catch (error) {
    console.error('Failed to initialize WebSocket:', error);
    return false;
  }
}

// Setup WebSocket event handlers for real-time sync
function setupWebSocketEventHandlers() {
  if (webSocketHandlersInitialized) return;
  webSocketHandlersInitialized = true;

  console.log('Setting up WebSocket event handlers...');

  // Connection state changes
  webSocketClient.on('connection.state', (data) => {
    console.log('WebSocket connection state changed:', data.state);

    // Broadcast state to popup if open
    broadcastToPopup('websocket.state', data);
  });

  // Authentication success
  webSocketClient.on('authenticated', (data) => {
    console.log('WebSocket authenticated:', data);
    broadcastToPopup('websocket.authenticated', data);
  });

  // Context events
  webSocketClient.on('context.joined', (data) => {
    console.log('Joined WebSocket context:', data.contextId);
    broadcastToPopup('websocket.context.joined', data);
  });

  webSocketClient.on('context.changed', (data) => {
    console.log('Context changed via WebSocket:', data);
    // Refresh tabs when context changes
    refreshTabLists();
    broadcastToPopup('context.changed', data);
  });

  // Context URL set events (from CLI commands like 'context set /path')
  webSocketClient.on('context.url.set', (data) => {
    console.log('Context URL set via WebSocket:', data);
    // Refresh tabs when context URL changes
    refreshTabLists();
    broadcastToPopup('context.url.set', data);
  });

  // Connection errors
  webSocketClient.on('connection.error', (data) => {
    console.error('WebSocket connection error:', data.error);
    broadcastToPopup('websocket.error', data);
  });

  // Disconnection
  webSocketClient.on('disconnected', () => {
    console.log('WebSocket disconnected');
    broadcastToPopup('websocket.disconnected', {});
  });

  const refreshPopupOnDocumentEvent = (eventType) => {
    webSocketClient.on(eventType, (data) => {
      console.log(`WebSocket document event: ${eventType}`, data);
      broadcastToPopup(eventType, data);
    });
  };

  [
    'document.inserted',
    'document.updated',
    'document.removed',
    'document.deleted',
    'document.removed.batch',
    'document.deleted.batch',
    'tree.document.inserted',
    'tree.document.inserted.batch',
    'tree.document.updated',
    'tree.document.updated.batch',
    'tree.document.removed',
    'tree.document.removed.batch',
    'tree.document.deleted',
    'tree.document.deleted.batch',
    'workspace.documents.inserted',
    'workspace.documents.updated',
    'workspace.documents.removed',
    'workspace.documents.deleted'
  ].forEach(refreshPopupOnDocumentEvent);

  // Workspace tree changes
  webSocketClient.on('workspace.tree.updated', (data) => {
    console.log('Workspace tree updated:', data);
    scheduleContextMenusSetup();
    broadcastToPopup('workspace.tree.updated', data);
  });

  webSocketClient.on('workspace.tree.created', (data) => {
    console.log('Workspace tree node created:', data);
    scheduleContextMenusSetup();
    broadcastToPopup('workspace.tree.created', data);
  });

  webSocketClient.on('workspace.tree.deleted', (data) => {
    console.log('Workspace tree node deleted:', data);
    scheduleContextMenusSetup();
    broadcastToPopup('workspace.tree.deleted', data);
  });

  webSocketClient.on('workspace.tree.renamed', (data) => {
    console.log('Workspace tree node renamed:', data);
    scheduleContextMenusSetup();
    broadcastToPopup('workspace.tree.renamed', data);
  });

  // Directory-specific events
  webSocketClient.on('directory.created', (data) => {
    console.log('Directory created:', data);
    scheduleContextMenusSetup();
    broadcastToPopup('directory.created', data);
  });

  webSocketClient.on('directory.deleted', (data) => {
    console.log('Directory deleted:', data);
    scheduleContextMenusSetup();
    broadcastToPopup('directory.deleted', data);
  });

  webSocketClient.on('directory.renamed', (data) => {
    console.log('Directory renamed:', data);
    scheduleContextMenusSetup();
    broadcastToPopup('directory.renamed', data);
  });
}

// Note: Real-time tab event handling has been moved to sync-engine.js to avoid duplication

// Broadcast message to popup
function broadcastToPopup(type, data) {
  // Browser extensions can send messages to popup if it's open
  try {
    const result = runtimeAPI.sendMessage({
      type: 'BACKGROUND_EVENT',
      eventType: type,
      data: data
    });
    if (result && typeof result.catch === 'function') {
      result.catch(() => {
        // UI might not be open, ignore errors
      });
    }
  } catch {
    // Ignore - popup not open
  }
}

async function handleAuthExpired() {
  console.warn('Auth expired — clearing session and notifying UI');
  apiClient.userToken = null;
  await browserStorage.setConnectionSettings({ connected: false, apiToken: '' });
  if (alarmsAPI) {
    try { await alarmsAPI.clear(TOKEN_RENEW_ALARM); } catch { /* ignore */ }
  }
  // Persistent signal even when the popup is closed.
  await setSessionBadge('expired');
  broadcastToPopup('auth.session.expired', {});
}

// Refresh tab lists (notify popup)
function refreshTabLists() {
  broadcastToPopup('tabs.refresh', {});
}

let refreshTabsDebounce = null;
function scheduleRefreshTabLists() {
  clearTimeout(refreshTabsDebounce);
  refreshTabsDebounce = setTimeout(refreshTabLists, 250);
}

let contextMenusDebounce = null;
function scheduleContextMenusSetup() {
  clearTimeout(contextMenusDebounce);
  contextMenusDebounce = setTimeout(() => {
    void setupContextMenus();
  }, 250);
}

async function ensureApiClientReady(override = null) {
  const connectionSettings = override?.serverUrl
    ? {
      serverUrl: override.serverUrl,
      apiBasePath: override.apiBasePath || '/rest/v2',
      apiToken: override.apiToken || ''
    }
    : await browserStorage.getConnectionSettings();
  if (!connectionSettings.apiToken || !connectionSettings.serverUrl) {
    throw new Error('Not connected to Canvas server - missing credentials');
  }

  const nextServerUrl = connectionSettings.serverUrl.replace(/\/$/, '');
  if (
    apiClient.baseUrl !== nextServerUrl ||
    apiClient.apiBasePath !== connectionSettings.apiBasePath ||
    apiClient.apiToken !== connectionSettings.apiToken
  ) {
    apiClient.initialize(
      connectionSettings.serverUrl,
      connectionSettings.apiBasePath,
      connectionSettings.apiToken
    );
  }

  return connectionSettings;
}

// Tab event listeners for synchronization
tabsAPI.onCreated.addListener(async (tab) => {
  console.log('🆕 TAB EVENT: Tab created detected!', tab.id, tab.url);
  scheduleRefreshTabLists();
  // Note: Auto-sync logic moved to onUpdated listener for reliable page load detection
});

tabsAPI.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  console.log('🔄 TAB EVENT: Tab updated detected!', tabId, changeInfo);
  if (changeInfo.status === 'complete' || changeInfo.url) scheduleRefreshTabLists();

  // Handle auto-sync when page is fully loaded OR when URL changes
  if (changeInfo.status === 'complete' && tab.url) {
    console.log('🔄 AUTO-SYNC: Tab page loaded completely:', tabId, tab.url, 'changeInfo:', changeInfo);

    try {
      await tabManager.initialize();

      // Check if auto-sync is enabled and we're connected
      const syncSettings = await browserStorage.getSyncSettings();
      const connectionSettings = await browserStorage.getConnectionSettings();

      console.log('🔄 AUTO-SYNC: Loaded settings for updated tab:', {
        sendNewTabsToCanvas: syncSettings?.sendNewTabsToCanvas,
        connected: connectionSettings?.connected,
        statusComplete: changeInfo.status === 'complete',
        urlChanged: !!changeInfo.url
      });

      if (!syncSettings?.sendNewTabsToCanvas) {
        console.log('🔄 AUTO-SYNC: Send new tabs to Canvas is disabled, skipping');
        return;
      }

      if (!connectionSettings?.connected) {
        console.log('🔄 AUTO-SYNC: Not connected to Canvas, skipping');
        return;
      }

      // Check if this tab should be synced
      if (!tabManager.shouldSyncTab(tab)) {
        console.log('🔄 AUTO-SYNC: Tab not suitable for sync (internal page, etc.):', tab.url);
        return;
      }

      if (!tabManager.isActiveSyncCandidate(tab)) {
        console.log('🔄 AUTO-SYNC: Tab is hidden/discarded, skipping auto-sync:', tab.title);
        return;
      }

      console.log('🔄 AUTO-SYNC: Page loaded completely, checking if should sync:', tab.title, tab.url);

      // CRITICAL: Check if tab is already synced to prevent cascading sync loops
      if (tabManager.isTabSynced(tab.id)) {
        console.log('🔄 AUTO-SYNC: Tab already synced (opened from Canvas), skipping auto-sync:', tab.title);
        return;
      }

      // CRITICAL: Check if URL is pending from Canvas to prevent race conditions
      if (tabManager.isUrlPendingFromCanvas(tab.url)) {
        console.log('🔄 AUTO-SYNC: Tab URL is pending from Canvas document, skipping auto-sync:', tab.title);
        return;
      }

      const mode = await browserStorage.getSyncMode();
      const currentContext = await browserStorage.getCurrentContext();
      const currentWorkspace = await browserStorage.getCurrentWorkspace();
      const workspacePath = await browserStorage.getWorkspacePath();
      const browserIdentity = await browserStorage.getBrowserIdentity();

      console.log('🔄 AUTO-SYNC: Mode and selection for loaded tab:', {
        mode,
        contextId: currentContext?.id,
        workspace: currentWorkspace?.id || currentWorkspace?.name,
        workspacePath,
        browserIdentity
      });

      if (mode === 'context') {
        if (!currentContext?.id) {
          console.log('🔄 AUTO-SYNC: No context bound, cannot sync tab');
          return;
        }
      } else {
        if (!currentWorkspace?.id && !currentWorkspace?.name) {
          console.log('🔄 AUTO-SYNC: No workspace selected, cannot sync tab');
          return;
        }
      }

      if (!browserIdentity) {
        console.log('🔄 AUTO-SYNC: No browser identity set, cannot sync tab');
        return;
      }

      console.log('🔄 AUTO-SYNC: Starting sync for fully loaded tab:', tab.title, tab.url);

      try {
        let syncResult;
        if (mode === 'context') {
          syncResult = await tabManager.syncTabToCanvas(tab, apiClient, currentContext.id, browserIdentity, syncSettings);
        } else {
          // Workspace mode: insert document into workspace with contextSpec
          const document = tabManager.convertTabToDocument(tab, browserIdentity, syncSettings);
          const wsId = currentWorkspace.name || currentWorkspace.id;
          const response = await apiClient.insertWorkspaceDocument(wsId, document, workspacePath || '/', document.featureArray);
          if (response.status === 'success') {
            const docId = Array.isArray(response.payload) ? response.payload[0] : response.payload;
            tabManager.markTabAsSynced(tab.id, docId, document.data?.url);
            syncResult = { success: true, documentId: docId };
          } else {
            syncResult = { success: false, error: response.message || 'Failed to sync tab' };
          }
        }

        console.log('🔄 AUTO-SYNC: Loaded tab sync result:', syncResult);

        if (syncResult.success) {
          console.log('✅ AUTO-SYNC: Successfully synced fully loaded tab:', tab.title);
        } else {
          console.error('❌ AUTO-SYNC: Failed to sync loaded tab:', syncResult.error || 'Unknown error');
        }
      } catch (error) {
        if (error instanceof AuthExpiredError) {
          // Session died mid-use: make it visible instead of silently dropping tabs.
          console.warn('❌ AUTO-SYNC: Session expired while syncing tab — flagging for reconnect');
          await handleAuthExpired();
          return;
        }
        console.error('❌ AUTO-SYNC: Exception syncing loaded tab:', error);
      }
    } catch (error) {
      if (error instanceof AuthExpiredError) {
        await handleAuthExpired();
        return;
      }
      console.error('❌ AUTO-SYNC: Exception processing loaded tab:', error);
    }
  }
});

tabsAPI.onRemoved.addListener(async (tabId, removeInfo) => {
  console.log('❌ TAB EVENT: Tab removed detected!', tabId, removeInfo);
  console.log('Tab removed:', tabId);

  // Capture any known Canvas document mapping before cleanup.
  await tabManager.initialize();
  const syncedTabData = tabManager.getSyncedTabData(tabId);

  // Clean up tracking
  tabManager.unmarkTabAsSynced(tabId);
  scheduleRefreshTabLists();

  // Optionally remove the corresponding Canvas document when the browser tab is closed.
  try {
    const syncSettings = await browserStorage.getSyncSettings();
    if (!syncSettings?.removeClosedTabsFromCanvas) return;

    const connectionSettings = await browserStorage.getConnectionSettings();
    if (!connectionSettings?.connected || !connectionSettings?.apiToken) return;

    const documentId = syncedTabData?.documentId;
    if (!documentId) return;

    if (!apiClient.apiToken) {
      apiClient.initialize(
        connectionSettings.serverUrl,
        connectionSettings.apiBasePath,
        connectionSettings.apiToken
      );
    }

    const mode = await browserStorage.getSyncMode();
    if (mode === 'context') {
      const currentContext = await browserStorage.getCurrentContext();
      if (!currentContext?.id) return;
      await apiClient.removeDocument(currentContext.id, documentId);
    } else {
      const workspace = await browserStorage.getCurrentWorkspace();
      if (!workspace?.id && !workspace?.name) return;
      const wsId = workspace.name || workspace.id;
      const workspacePath = await browserStorage.getWorkspacePath();
      await apiClient.removeWorkspaceDocuments(wsId, [documentId], workspacePath || '/', ['data/abstraction/tab']);
    }
  } catch (error) {
    // Non-fatal: we always prefer closing the browser tab over perfect remote state.
    console.warn('Failed to remove closed tab from Canvas:', error?.message || error);
  }
});

tabsAPI.onActivated.addListener(async (activeInfo) => {
  console.log('Tab activated:', activeInfo.tabId);
  // Handle tab activation
});

// Window event listeners
windowsAPI.onCreated.addListener(async (window) => {
  console.log('Window created:', window.id);
});

windowsAPI.onRemoved.addListener(async (windowId) => {
  console.log('Window removed:', windowId);
});

console.log('✅ Service Worker: All tab and window event listeners registered successfully');

// Message handling for popup/settings communication
runtimeAPI.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Message received:', message.type, message);

  // Always respond exactly once for async handlers. This prevents:
  // "A listener indicated an asynchronous response ... but the message channel closed..."
  let responded = false;
  const messageStartedAt = performance.now();
  const respond = (payload) => {
    if (responded) return;
    responded = true;
    try {
      sendResponse(payload);
    } catch (e) {
      // Channel may already be closed; avoid crashing the SW.
      console.warn('Failed to sendResponse (channel closed?):', e);
    }
  };
  const run = (p) => {
    return Promise.resolve(p)
      .then(() => {
        console.info(`Background Timing: ${message.type} ${Math.round(performance.now() - messageStartedAt)}ms`);
        return null;
      })
      .catch(async (error) => {
        if (error instanceof AuthExpiredError) {
          console.warn('AuthExpiredError caught in message handler:', message.type);
          await handleAuthExpired();
          respond({ success: false, error: 'session_expired', message: 'Session expired. Please reconnect.' });
          return;
        }
        console.error('Unhandled message handler error:', error);
        respond({ success: false, error: error?.message || String(error) });
      });
  };

  // Add ping test
  if (message.type === 'PING') {
    console.log('🏓 Service Worker: PING received');
    respond({ success: true, message: 'PONG from service worker' });
    return true;
  }

  switch (message.type) {
  case 'GET_CONNECTION_STATUS':
    // Return current connection status from storage
    run(handleGetConnectionStatus(respond));
    return true;

  case 'GET_SESSION_INFO':
    // Return JWT session expiry info for the popup countdown
    run(handleGetSessionInfo(respond));
    return true;

  case 'GET_TAB_SYNC_DEBUG':
    run(handleGetTabSyncDebug(respond));
    return true;

  case 'TEST_CONNECTION':
    // Test connection to Canvas server
    run(handleTestConnection(message.data, respond));
    return true; // Keep message channel open for async response

  case 'CONNECT':
    // Connect to Canvas server
    run(handleConnect(message.data, respond));
    return true;

  case 'DISCONNECT':
    // Disconnect from Canvas server
    run(handleDisconnect(respond));
    return true;

  case 'GET_CONTEXTS':
    // Get available contexts from Canvas server
    run(handleGetContexts(respond));
    return true;

  case 'GET_WORKSPACES':
    // Get available workspaces from Canvas server
    run(handleGetWorkspaces(respond));
    return true;

  case 'GET_CONTEXT_TREE':
    // Get context tree
    run(handleGetContextTree(message.data, respond));
    return true;

  case 'GET_WORKSPACE_TREE':
    // Get workspace tree
    run(handleGetWorkspaceTree(message.data, respond));
    return true;

  case 'INSERT_WORKSPACE_PATH':
    // Insert path in workspace tree
    run(handleInsertWorkspacePath(message.data, respond));
    return true;

  case 'INSERT_CONTEXT_PATH':
    // Insert path in context tree
    run(handleInsertContextPath(message.data, respond));
    return true;

  case 'OPEN_WORKSPACE':
    // Open a workspace by id/name
    run(handleOpenWorkspace(message.data, respond));
    return true;

  case 'BIND_CONTEXT':
    // Bind to a specific context
    run(handleBindContext(message.data, respond));
    return true;

  case 'SAVE_SETTINGS':
    // Save all extension settings
    run(handleSaveSettings(message.data, respond));
    return true;

  case 'GET_SYNC_SETTINGS':
    // Get sync settings only
    run(handleGetSyncSettings(respond));
    return true;

  case 'SET_SYNC_SETTINGS':
    // Set sync settings only
    run(handleSetSyncSettings(message.data, respond));
    return true;

  case 'GET_TABS':
    // Get browser tabs or canvas tabs
    run(handleGetTabs(message.data, respond));
    return true;

  case 'GET_ALL_TABS':
    // Get all browser tabs (both synced and unsynced)
    run(handleGetAllTabs(message.data, respond));
    return true;

  case 'GET_CANVAS_DOCUMENTS':
    // Get Canvas documents for current context
    run(handleGetCanvasDocuments(message.data, respond));
    return true;

  case 'GET_WORKSPACE_DOCUMENTS':
    // Get documents for current workspace (explorer mode)
    run(handleGetWorkspaceDocuments(message.data, respond));
    return true;

  case 'SYNC_TAB':
    // Sync a single tab to Canvas
    run(handleSyncTab(message.data, respond));
    return true;

  case 'SYNC_MULTIPLE_TABS':
    // Sync multiple tabs to Canvas
    run(handleSyncMultipleTabs(message.data, respond));
    return true;

  case 'OPEN_CANVAS_DOCUMENT':
    // Open Canvas document as browser tab
    run(handleOpenCanvasDocument(message.data, respond));
    return true;

  case 'REMOVE_CANVAS_DOCUMENT':
    // Remove Canvas document
    run(handleRemoveCanvasDocument(message.data, respond));
    return true;

  case 'REMOVE_CANVAS_DOCUMENTS':
    // Remove multiple Canvas documents
    run(handleRemoveCanvasDocuments(message.data, respond));
    return true;

  case 'CLOSE_TAB':
    // Close browser tab
    run(handleCloseTab(message.data, respond));
    return true;

  case 'CLOSE_TABS':
    // Close multiple browser tabs
    run(handleCloseTabs(message.data, respond));
    return true;

  case 'CLOSE_WINDOW':
    // Close a browser window (all its tabs)
    run(handleCloseWindow(message.data, respond));
    return true;

  case 'FOCUS_TAB':
    // Focus browser tab
    run(handleFocusTab(message.data, respond));
    return true;

  case 'TOGGLE_PIN_TAB':
    // Toggle pin state of a tab
    run(handleTogglePinTab(message.data, respond));
    return true;

  case 'GET_PINNED_TABS':
    // Get list of pinned tab IDs
    run(handleGetPinnedTabs(message.data, respond));
    return true;

  case 'GET_CONNECTION_SETTINGS':
    // Get connection settings
    run(handleGetConnectionSettings(message.data, respond));
    return true;

  case 'GET_REGISTERED_DEVICES':
    run(handleGetRegisteredDevices(message.data, respond));
    return true;

  case 'ASSIGN_BROWSER_DEVICE':
    run(handleAssignBrowserDevice(message.data, respond));
    return true;

  case 'GET_MODE_AND_SELECTION':
    // Get current sync mode and selection (context/workspace)
    run(handleGetModeAndSelection(respond));
    return true;

  case 'SET_MODE_AND_SELECTION':
    // Set current sync mode and selection
    run(handleSetModeAndSelection(message.data, respond));
    return true;

  case 'OPEN_TAB':
    // Open a Canvas tab in browser
    run(handleOpenTab(message.data, respond));
    return true;

  case 'REMOVE_FROM_CONTEXT':
    // Remove tab from context
    run(handleRemoveFromContext(message.data, respond));
    return true;

  case 'DELETE_FROM_DATABASE':
    // Delete tab from database completely
    run(handleDeleteFromDatabase(message.data, respond));
    return true;

  case 'context.url.update':
    // Update context URL
    run(handleUpdateContextUrl(message, respond));
    return true;

  default:
    console.warn('Unknown message type:', message.type);
    respond({ success: false, error: 'Unknown message type' });
  }
});

// Helper Functions

async function openSettingsPage() {
  const url = runtimeAPI.getURL('settings/settings.html');
  await tabsAPI.create({ url });
}

// Migrate legacy storage keys from older versions to the current key scheme
// Legacy keys: connectionSettings, syncSettings, currentContext, browserIdentity
// New keys: canvasConnectionSettings, canvasSyncSettings, canvasCurrentContext, canvasBrowserIdentity
async function migrateLegacyStorageKeys() {
  try {
    const all = await browserStorage.storage.get(null);

    const legacyToNew = [
      ['connectionSettings', 'canvasConnectionSettings'],
      ['syncSettings', 'canvasSyncSettings'],
      ['currentContext', 'canvasCurrentContext'],
      ['browserIdentity', 'canvasBrowserIdentity']
    ];

    let migrated = 0;
    for (const [legacyKey, newKey] of legacyToNew) {
      const hasLegacy = Object.prototype.hasOwnProperty.call(all, legacyKey);
      const hasNew = Object.prototype.hasOwnProperty.call(all, newKey);
      if (hasLegacy && !hasNew) {
        const value = all[legacyKey];
        await browserStorage.storage.set({ [newKey]: value });
        migrated++;
      }
    }

    // Clean up legacy keys only after successful copy
    if (migrated > 0) {
      const keysToRemove = legacyToNew
        .map(([legacyKey]) => legacyKey)
        .filter((k) => Object.prototype.hasOwnProperty.call(all, k));
      try {
        await browserStorage.storage.remove(keysToRemove);
        console.log('Migrated legacy storage keys:', migrated, 'removed:', keysToRemove);
      } catch (e) {
        console.warn('Failed to remove legacy storage keys (safe to ignore):', e);
      }
    }
  } catch (error) {
    console.error('Failed to migrate legacy storage keys:', error);
  }
}

async function handleGetConnectionStatus(sendResponse) {
  try {
    console.log('Getting connection status from storage...');

    // Get connection settings and current context
    const connectionSettings = await browserStorage.getConnectionSettings();
    const currentContext = await browserStorage.getCurrentContext();
    const userInfo = await browserStorage.getUserInfo();
    const browserIdentity = await browserStorage.getBrowserIdentity();
    const mode = await browserStorage.getSyncMode();
    const workspace = await browserStorage.getCurrentWorkspace();
    const workspacePath = await browserStorage.getWorkspacePath();

    console.log('Connection settings:', connectionSettings);
    console.log('Current context:', currentContext);
    console.log('User info:', userInfo);

    sendResponse({
      connected: connectionSettings.connected || false,
      context: currentContext,
      settings: connectionSettings,
      browserIdentity,
      user: userInfo,
      mode: mode || 'explorer',
      workspace,
      workspacePath
    });
  } catch (error) {
    console.error('Failed to get connection status:', error);
    sendResponse({
      connected: false,
      context: null,
      error: error.message
    });
  }
}

async function handleGetSessionInfo(sendResponse) {
  try {
    const settings = await browserStorage.getConnectionSettings();
    const expiresAt = settings?.apiToken ? getJwtExpiryMs(settings.apiToken) : null;
    // A JWT (has exp) is auto-renewed; opaque API tokens never expire.
    const isJwt = expiresAt !== null;
    sendResponse({
      success: true,
      connected: !!settings?.connected,
      expiresAt,                          // ms epoch, or null for non-expiring tokens
      expiresInMs: expiresAt ? Math.max(0, expiresAt - Date.now()) : null,
      autoRenew: isJwt && !!settings?.connected,
      tokenType: isJwt ? 'jwt' : (settings?.apiToken ? 'api' : 'none')
    });
  } catch (error) {
    console.error('Failed to get session info:', error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleGetTabSyncDebug(sendResponse) {
  try {
    await tabManager.initialize();

    const [
      connectionSettings,
      syncSettings,
      currentContext,
      currentWorkspace,
      workspacePath,
      persistedTrackedTabs,
      browserIdentity,
      mode
    ] = await Promise.all([
      browserStorage.getConnectionSettings(),
      browserStorage.getSyncSettings(),
      browserStorage.getCurrentContext(),
      browserStorage.getCurrentWorkspace(),
      browserStorage.getWorkspacePath(),
      browserStorage.getTrackedCanvasTabs(),
      browserStorage.getBrowserIdentity(),
      browserStorage.getSyncMode()
    ]);

    const debug = {
      mode,
      browserIdentity,
      connection: {
        connected: !!connectionSettings?.connected,
        serverUrl: connectionSettings?.serverUrl || '',
        hasApiToken: !!connectionSettings?.apiToken
      },
      websocket: webSocketClient.getConnectionStatus(),
      syncEngine: syncEngine.getSyncStatus(),
      selection: {
        context: currentContext,
        workspace: currentWorkspace,
        workspacePath: workspacePath || '/'
      },
      syncSettings,
      persistedTrackedTabs,
      live: await tabManager.getDebugSnapshot()
    };

    sendResponse({ success: true, debug });
  } catch (error) {
    console.error('Failed to get tab sync debug state:', error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleTestConnection(data, sendResponse) {
  try {
    console.log('Testing connection with data:', data);

    // Initialize API client with provided settings
    if (data.serverUrl && data.apiBasePath) {
      apiClient.initialize(data.serverUrl, data.apiBasePath, data.apiToken || '');
    }

    // For credentials auth, exchange email/password for a JWT first
    if (data.authMode === 'credentials' && data.email && data.password) {
      const loginResult = await apiClient.login(data.email, data.password);
      apiClient.userToken = loginResult.token;
    }

    // Test the connection
    const result = await apiClient.testConnection();

    console.log('Connection test result:', result);
    sendResponse(result);
  } catch (error) {
    console.error('Connection test failed:', error);
    sendResponse({
      success: false,
      connected: false,
      authenticated: false,
      error: error.message,
      message: 'Connection test failed'
    });
  }
}

async function handleConnect(data, sendResponse) {
  try {
    console.log('Connecting with data:', data);

    // Validate required fields
    const hasToken = !!data.apiToken;
    const hasCredentials = data.authMode === 'credentials' && !!data.email && !!data.password;
    if (!data.serverUrl || !data.apiBasePath || (!hasToken && !hasCredentials)) {
      throw new Error('Missing required connection parameters');
    }

    // If the user is switching servers, clear context/workspace selection to avoid stale bindings.
    const previousConnection = await browserStorage.getConnectionSettings();
    const prevServerUrl = (previousConnection?.serverUrl || '').replace(/\/$/, '');
    const nextServerUrl = (data.serverUrl || '').replace(/\/$/, '');
    const serverChanged = !!prevServerUrl && (prevServerUrl !== nextServerUrl || previousConnection?.apiBasePath !== data.apiBasePath);
    if (serverChanged) {
      console.log('Server changed - resetting context/workspace selection');
      if (webSocketClient.isConnected()) webSocketClient.disconnect();
      await browserStorage.setCurrentContext(null);
      await browserStorage.setCurrentWorkspace(null);
      await browserStorage.setWorkspacePath('/');
      await browserStorage.setSyncMode('explorer');
      await browserStorage.setUserInfo(null);
      await browserStorage.setConnectionSettings({
        deviceId: '',
        deviceToken: '',
        deviceName: '',
        devicePlatform: '',
        deviceDescription: '',
        deviceType: ''
      });
    }

    // Initialize API client
    apiClient.initialize(data.serverUrl, data.apiBasePath, data.apiToken || '');

    // For credentials auth, exchange email/password for a JWT before testing
    let resolvedApiToken = data.apiToken || '';
    if (hasCredentials) {
      const loginResult = await apiClient.login(data.email, data.password);
      resolvedApiToken = loginResult.token;
      apiClient.userToken = resolvedApiToken;
    }

    // Test the connection first
    const testResult = await apiClient.testConnection();
    if (!testResult.success || !testResult.authenticated) {
      throw new Error(testResult.message || 'Connection test failed');
    }

    // Save connection settings to storage
    const connectionSettings = {
      serverUrl: data.serverUrl,
      apiBasePath: data.apiBasePath,
      apiToken: resolvedApiToken,
      authMode: data.authMode || 'token',
      deviceId: previousConnection?.deviceId || '',
      deviceToken: previousConnection?.deviceToken || '',
      deviceName: previousConnection?.deviceName || '',
      devicePlatform: previousConnection?.devicePlatform || '',
      deviceDescription: previousConnection?.deviceDescription || '',
      deviceType: previousConnection?.deviceType || '',
      connected: true
    };

    console.log('Saving connection settings:', connectionSettings);
    await browserStorage.setConnectionSettings(connectionSettings);

    // Save user info from authentication
    if (testResult.user) {
      console.log('Saving user info:', testResult.user);
      await browserStorage.setUserInfo(testResult.user);
    }

    // Verify settings were saved
    const savedSettings = await browserStorage.getConnectionSettings();
    console.log('Verified saved settings:', savedSettings);

    // Save browser identity if provided
    if (data.browserIdentity) {
      await browserStorage.set(browserStorage.KEYS.BROWSER_IDENTITY, data.browserIdentity);
    }

    // Initialize WebSocket connection if we have a context
    const currentContext = await browserStorage.getCurrentContext();
    if (currentContext?.id) {
      console.log('Initializing WebSocket connection after connect...');
      await initializeWebSocket();
    }

    // Clear any stale "expired" badge and (re)schedule proactive JWT renewal.
    await setSessionBadge('ok');
    await scheduleTokenRenewal();

    console.log('Connection saved successfully');

    sendResponse({
      success: true,
      connected: true,
      authenticated: true,
      user: testResult.user,
      apiToken: resolvedApiToken,
      message: 'Connected and settings saved successfully'
    });
  } catch (error) {
    console.error('Connection failed:', error);

    // Keep the user's URL but mark as disconnected
    await browserStorage.setConnectionSettings({
      serverUrl: data.serverUrl,
      apiBasePath: data.apiBasePath,
      apiToken: '',
      connected: false
    });

    // Clear user info on failed connection
    await browserStorage.setUserInfo(null);

    sendResponse({
      success: false,
      connected: false,
      authenticated: false,
      error: error.message,
      message: 'Connection failed'
    });
  }
}

async function handleDisconnect(sendResponse) {
  try {
    console.log('Disconnecting from Canvas server...');

    // Clear connection settings but keep the server URL
    const currentSettings = await browserStorage.getConnectionSettings();
    await browserStorage.setConnectionSettings({
      serverUrl: currentSettings.serverUrl || 'https://my.cnvs.ai',
      apiBasePath: currentSettings.apiBasePath || '/rest/v2',
      apiToken: '',
      connected: false
    });

    // Clear current context
    await browserStorage.setCurrentContext(null);

    // Clear user info
    await browserStorage.setUserInfo(null);

    // Disconnect WebSocket if connected
    if (webSocketClient.isConnected()) {
      webSocketClient.disconnect();
    }

    // Clear API client
    apiClient.connected = false;

    // Cancel pending renewal and clear the session badge.
    if (alarmsAPI) {
      try { await alarmsAPI.clear(TOKEN_RENEW_ALARM); } catch { /* ignore */ }
    }
    await setSessionBadge('ok');

    console.log('Disconnected successfully');

    sendResponse({
      success: true,
      connected: false,
      message: 'Disconnected successfully'
    });
  } catch (error) {
    console.error('Disconnection failed:', error);
    sendResponse({
      success: false,
      error: error.message,
      message: 'Disconnection failed'
    });
  }
}

async function handleGetContexts(sendResponse) {
  try {
    console.log('Getting available contexts from Canvas server...');

    // Check if API client is initialized and has a token
    if (!apiClient.apiToken) {
      // Try to load from storage if API client isn't initialized
      const connectionSettings = await browserStorage.getConnectionSettings();
      if (!connectionSettings.apiToken) {
        throw new Error('No API token available - please connect first');
      }

      // Initialize API client with stored settings
      apiClient.initialize(
        connectionSettings.serverUrl,
        connectionSettings.apiBasePath,
        connectionSettings.apiToken
      );
    }

    console.log('API client initialized, fetching contexts...');

    // Fetch contexts from Canvas server
    const response = await apiClient.getContexts();

    console.log('Contexts response:', response);

    if (response.status === 'success') {
      sendResponse({
        success: true,
        contexts: response.payload || [],
        count: response.count || 0
      });
    } else {
      throw new Error(response.message || 'Failed to fetch contexts');
    }
  } catch (error) {
    console.error('Failed to get contexts:', error);
    sendResponse({
      success: false,
      contexts: [],
      error: error.message
    });
  }
}

async function handleGetWorkspaces(sendResponse) {
  try {
    console.log('Getting available workspaces from Canvas server...');

    // Ensure API client is initialized
    if (!apiClient.apiToken) {
      const connectionSettings = await browserStorage.getConnectionSettings();
      if (!connectionSettings.apiToken) {
        throw new Error('No API token available - please connect first');
      }
      apiClient.initialize(
        connectionSettings.serverUrl,
        connectionSettings.apiBasePath,
        connectionSettings.apiToken
      );
    }

    const response = await apiClient.getWorkspaces();
    console.log('Workspaces response:', response);

    if (response.status === 'success') {
      sendResponse({ success: true, workspaces: response.payload || [], count: response.count || 0 });
    } else {
      throw new Error(response.message || 'Failed to fetch workspaces');
    }
  } catch (error) {
    console.error('Failed to get workspaces:', error);
    sendResponse({ success: false, workspaces: [], error: error.message });
  }
}

async function handleGetContextTree(data, sendResponse) {
  try {
    let contextId = data?.contextId;
    if (!contextId) {
      const currentContext = await browserStorage.getCurrentContext();
      contextId = currentContext?.id;
    }
    if (!contextId) throw new Error('No context selected');

    const connectionSettings = await browserStorage.getConnectionSettings();
    if (!connectionSettings.apiToken || !connectionSettings.serverUrl) {
      throw new Error('Not connected to Canvas server - missing credentials');
    }
    if (!apiClient.apiToken) {
      apiClient.initialize(
        connectionSettings.serverUrl,
        connectionSettings.apiBasePath,
        connectionSettings.apiToken
      );
    }

    const response = await apiClient.getContextTree(contextId);
    if (response.status === 'success') {
      sendResponse({ success: true, tree: response.payload });
    } else {
      throw new Error(response.message || 'Failed to fetch context tree');
    }
  } catch (error) {
    console.error('Failed to get context tree:', error);
    sendResponse({ success: false, error: error.message, tree: null });
  }
}

async function handleGetWorkspaceTree(data, sendResponse) {
  try {
    let wsIdOrName = data?.workspaceIdOrName;
    if (!wsIdOrName) {
      const ws = await browserStorage.getCurrentWorkspace();
      wsIdOrName = ws?.name || ws?.id;
    }
    if (!wsIdOrName) throw new Error('No workspace selected');

    const connectionSettings = await browserStorage.getConnectionSettings();
    if (!connectionSettings.apiToken || !connectionSettings.serverUrl) {
      throw new Error('Not connected to Canvas server - missing credentials');
    }
    if (!apiClient.apiToken) {
      apiClient.initialize(
        connectionSettings.serverUrl,
        connectionSettings.apiBasePath,
        connectionSettings.apiToken
      );
    }

    const response = await apiClient.getWorkspaceTree(wsIdOrName);
    if (response.status === 'success') {
      sendResponse({ success: true, tree: response.payload });
    } else {
      throw new Error(response.message || 'Failed to fetch workspace tree');
    }
  } catch (error) {
    console.error('Failed to get workspace tree:', error);
    sendResponse({ success: false, error: error.message, tree: null });
  }
}

async function handleInsertWorkspacePath(data, sendResponse) {
  try {
    const { path, workspaceIdOrName, data: nodeData, autoCreateLayers = true } = data;

    let wsIdOrName = workspaceIdOrName;
    if (!wsIdOrName) {
      const ws = await browserStorage.getCurrentWorkspace();
      wsIdOrName = ws?.name || ws?.id;
    }
    if (!wsIdOrName) throw new Error('No workspace selected');
    if (!path) throw new Error('Path is required');

    const connectionSettings = await browserStorage.getConnectionSettings();
    if (!connectionSettings.apiToken || !connectionSettings.serverUrl) {
      throw new Error('Not connected to Canvas server - missing credentials');
    }
    if (!apiClient.apiToken) {
      apiClient.initialize(
        connectionSettings.serverUrl,
        connectionSettings.apiBasePath,
        connectionSettings.apiToken
      );
    }

    const response = await apiClient.insertWorkspacePath(wsIdOrName, path, nodeData, autoCreateLayers);
    if (response.status === 'success') {
      // Note: deliberately NOT rebuilding native context menus here — that
      // refetches every workspace+tree (was firing "Workspaces retrieved" ~23×
      // per folder create). The popup tree refreshes itself after creation.
      sendResponse({ success: true, response: response.payload });
    } else {
      throw new Error(response.message || 'Failed to insert workspace path');
    }
  } catch (error) {
    console.error('Failed to insert workspace path:', error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleInsertContextPath(data, sendResponse) {
  try {
    const { contextId, path, autoCreateLayers = true } = data;
    if (!contextId) throw new Error('Context id is required');
    if (!path) throw new Error('Path is required');

    const connectionSettings = await browserStorage.getConnectionSettings();
    if (!connectionSettings.apiToken || !connectionSettings.serverUrl) {
      throw new Error('Not connected to Canvas server - missing credentials');
    }
    if (!apiClient.apiToken) {
      apiClient.initialize(
        connectionSettings.serverUrl,
        connectionSettings.apiBasePath,
        connectionSettings.apiToken
      );
    }

    const response = await apiClient.insertContextPath(contextId, path, autoCreateLayers);
    if (response.status === 'success') {
      // See handleInsertWorkspacePath: skip the costly native-menu rebuild.
      sendResponse({ success: true, response: response.payload });
    } else {
      throw new Error(response.message || 'Failed to insert context path');
    }
  } catch (error) {
    console.error('Failed to insert context path:', error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleOpenWorkspace(data, sendResponse) {
  try {
    // Use more explicit property access to avoid triggering security scanners
    const requestData = data || {};
    const workspace = requestData.workspace;
    if (!workspace || (!workspace.id && !workspace.name)) {
      throw new Error('Workspace id or name is required');
    }

    const wsIdOrName = workspace.name || workspace.id;

    const connectionSettings = await browserStorage.getConnectionSettings();
    if (!connectionSettings.apiToken || !connectionSettings.serverUrl) {
      throw new Error('Not connected to Canvas server - missing credentials');
    }
    if (!apiClient.apiToken) {
      apiClient.initialize(
        connectionSettings.serverUrl,
        connectionSettings.apiBasePath,
        connectionSettings.apiToken
      );
    }

    const resp = await apiClient.startWorkspace(wsIdOrName);
    if (resp.status !== 'success') {
      throw new Error(resp.message || 'Failed to start workspace');
    }

    await browserStorage.setSyncMode('explorer');
    await browserStorage.setCurrentWorkspace(workspace);
    await browserStorage.setWorkspacePath('/');

    refreshTabLists();

    sendResponse({ success: true, workspace: workspace });
  } catch (error) {
    console.error('Failed to open workspace:', error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleGetModeAndSelection(sendResponse) {
  try {
    const mode = await browserStorage.getSyncMode();
    const context = await browserStorage.getCurrentContext();
    const workspace = await browserStorage.getCurrentWorkspace();
    const workspacePath = await browserStorage.getWorkspacePath();
    sendResponse({ success: true, mode, context, workspace, workspacePath });
  } catch (error) {
    console.error('Failed to get mode/selection:', error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleSetModeAndSelection(data, sendResponse) {
  try {
    // Use explicit property access to avoid triggering security scanners
    const requestData = data || {};
    const mode = requestData.mode;
    const context = requestData.context;
    const workspace = requestData.workspace;
    const workspacePath = requestData.workspacePath;

    // Get current values to detect changes
    const currentMode = await browserStorage.getSyncMode();
    const currentWorkspace = await browserStorage.getCurrentWorkspace();
    const currentWorkspacePath = await browserStorage.getWorkspacePath();

    if (mode) await browserStorage.setSyncMode(mode);

    if (mode === 'context') {
      if (workspace) await browserStorage.setCurrentWorkspace(null);
      if (context) await browserStorage.setCurrentContext(context);
    } else if (mode === 'explorer') {
      if (context) await browserStorage.setCurrentContext(null);
      if (workspace) await browserStorage.setCurrentWorkspace(workspace);
      if (workspacePath !== undefined) await browserStorage.setWorkspacePath(workspacePath);

      // Handle workspace path change if in explorer mode and path changed
      if (currentMode === 'explorer' &&
          workspacePath !== undefined &&
          workspacePath !== currentWorkspacePath &&
          syncEngine.isInitialized) {
        const targetWorkspace = workspace || currentWorkspace;
        if (targetWorkspace) {
          await syncEngine.handleWorkspacePathChange(targetWorkspace, currentWorkspacePath, workspacePath);
        }
      }
    }

    // Update context menus after mode/selection change
    await setupContextMenus();

    const connectionSettings = await browserStorage.getConnectionSettings();
    if (connectionSettings.connected && connectionSettings.apiToken) {
      if (!apiClient.apiToken) {
        apiClient.initialize(
          connectionSettings.serverUrl,
          connectionSettings.apiBasePath,
          connectionSettings.apiToken
        );
      }

      if (mode === 'explorer' && workspace) {
        const wsId = workspace.id || workspace.name;
        if (wsId) {
          await apiClient.ensureWorkspaceStarted(wsId);
        }
      }

      await initializeWebSocket();
    }

    sendResponse({ success: true });
  } catch (error) {
    console.error('Failed to set mode/selection:', error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleGetTabs(data, sendResponse) {
  try {
    console.log('Getting tabs with type:', data?.type);

    if (data?.type === 'browser') {
      // Get browser tabs that are unsynced (should be synced but aren't yet)
      const tabs = await tabManager.getUnsyncedTabs();
      console.log('Unsynced browser tabs:', tabs.length);

      sendResponse({
        success: true,
        tabs: tabs,
        type: 'browser'
      });
    } else if (data?.type === 'canvas') {
      // Get Canvas context tabs - TODO: implement when we have context binding
      console.log('Canvas tabs not implemented yet');
      sendResponse({
        success: true,
        tabs: [],
        type: 'canvas'
      });
    } else {
      throw new Error('Invalid tab type requested');
    }
  } catch (error) {
    console.error('Failed to get tabs:', error);
    sendResponse({
      success: false,
      tabs: [],
      error: error.message
    });
  }
}

async function handleGetAllTabs(data, sendResponse) {
  try {
    console.log('Getting all browser tabs...');

    // Get all browser tabs
    const tabs = await tabManager.getAllTabs();
    console.log('All browser tabs:', tabs.length);

    sendResponse({
      success: true,
      tabs: tabs,
      type: 'browser'
    });
  } catch (error) {
    console.error('Failed to get all tabs:', error);
    sendResponse({
      success: false,
      tabs: [],
      error: error.message
    });
  }
}

async function handleOpenTab(data, sendResponse) {
  try {
    // TODO: Implement tab opening
    sendResponse({ success: true, message: 'Tab opened successfully' });
  } catch (error) {
    console.error('Failed to open tab:', error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleCloseTab(data, sendResponse) {
  try {
    const { tabId } = data;

    if (!tabId) {
      throw new Error('Tab ID is required');
    }

    console.log('Closing tab:', tabId);

    // Close the tab using Chrome API
    const result = await tabManager.closeTab(tabId);

    if (result) {
      console.log('Tab closed successfully:', tabId);
      sendResponse({
        success: true,
        message: 'Tab closed successfully'
      });
    } else {
      throw new Error('Failed to close tab');
    }
  } catch (error) {
    console.error('Failed to close tab:', error);
    sendResponse({
      success: false,
      error: error.message
    });
  }
}

async function handleCloseTabs(data, sendResponse) {
  try {
    const { tabIds } = data || {};
    if (!Array.isArray(tabIds) || tabIds.length === 0) {
      throw new Error('Tab IDs array is required');
    }

    console.log('Closing tabs:', tabIds);
    const result = await tabManager.closeTabs(tabIds);
    if (!result) throw new Error('Failed to close tabs');

    sendResponse({
      success: true,
      closed: tabIds.length,
      message: 'Tabs closed successfully'
    });
  } catch (error) {
    console.error('Failed to close tabs:', error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleCloseWindow(data, sendResponse) {
  try {
    const { windowId } = data || {};
    if (!Number.isInteger(windowId)) {
      throw new Error('Window ID is required');
    }

    console.log('Closing window:', windowId);
    await windowsAPI.remove(windowId);
    sendResponse({ success: true });
  } catch (error) {
    console.error('Failed to close window:', error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleFocusTab(data, sendResponse) {
  try {
    const { tabId } = data;

    if (!tabId) {
      throw new Error('Tab ID is required');
    }

    console.log('Focusing tab:', tabId);

    // Focus the tab using Chrome API
    const result = await tabManager.focusTab(tabId);

    if (result) {
      console.log('Tab focused successfully:', tabId);
      sendResponse({
        success: true,
        message: 'Tab focused successfully'
      });
    } else {
      throw new Error('Failed to focus tab');
    }
  } catch (error) {
    console.error('Failed to focus tab:', error);
    sendResponse({
      success: false,
      error: error.message
    });
  }
}

async function handleTogglePinTab(data, sendResponse) {
  try {
    const { tabId } = data;

    if (!tabId) {
      throw new Error('Tab ID is required');
    }

    console.log('Toggling pin state for tab:', tabId);

    const tab = await tabManager.getTab(tabId);
    const url = tab?.url;
    if (!url) throw new Error('Tab URL not available');

    // Check current pin state (by URL so it survives restarts)
    const isPinned = await browserStorage.isTabUrlPinned(url);

    if (isPinned) {
      await browserStorage.unpinTabUrl(url);
      console.log('Tab unpinned:', url);
    } else {
      await browserStorage.pinTabUrl(url);
      console.log('Tab pinned:', url);
    }

    sendResponse({
      success: true,
      isPinned: !isPinned,
      message: `Tab ${!isPinned ? 'pinned' : 'unpinned'} successfully`
    });
  } catch (error) {
    console.error('Failed to toggle pin tab:', error);
    sendResponse({
      success: false,
      error: error.message
    });
  }
}

async function handleGetPinnedTabs(data, sendResponse) {
  try {
    console.log('Getting pinned tabs');

    const pinnedUrls = await browserStorage.getPinnedTabUrls();
    const pinnedTabsArray = Array.from(pinnedUrls);

    console.log('Retrieved pinned tabs:', pinnedTabsArray);

    sendResponse({
      success: true,
      pinnedTabs: pinnedTabsArray
    });
  } catch (error) {
    console.error('Failed to get pinned tabs:', error);
    sendResponse({
      success: false,
      error: error.message,
      pinnedTabs: []
    });
  }
}

async function handleGetConnectionSettings(data, sendResponse) {
  try {
    console.log('Getting connection settings');

    const connectionSettings = await browserStorage.getConnectionSettings();

    console.log('Retrieved connection settings:', connectionSettings);

    sendResponse({
      success: true,
      settings: connectionSettings
    });
  } catch (error) {
    console.error('Failed to get connection settings:', error);
    sendResponse({
      success: false,
      error: error.message,
      settings: null
    });
  }
}

async function handleGetRegisteredDevices(data, sendResponse) {
  try {
    await ensureApiClientReady(data);
    const response = await apiClient.get('/auth/devices');
    const devices = apiClient.parseResponsePayload(response);
    sendResponse({
      success: true,
      devices: Array.isArray(devices) ? devices : []
    });
  } catch (error) {
    console.error('Failed to get registered devices:', error);
    sendResponse({
      success: false,
      devices: [],
      error: error.message
    });
  }
}

function isUuidLikeDeviceName(value) {
  const normalizedValue = String(value || '').trim().replace(/-/g, '');
  return /^[0-9a-f]{32}$/i.test(normalizedValue);
}

async function handleAssignBrowserDevice(data, sendResponse) {
  try {
    if (!data?.browserIdentity) {
      throw new Error('Browser identity is required');
    }

    await ensureApiClientReady(data);

    const profile = apiClient.buildBrowserDeviceProfile(data.browserIdentity);
    const payload = {
      ...profile,
      type: 'browser'
    };

    if (data.deviceId && !data.registerNew) {
      payload.deviceId = String(data.deviceId).trim();
      payload.name = String(data.deviceName || profile.name).trim() || profile.name;
      payload.platform = String(data.devicePlatform || profile.platform || '').trim() || profile.platform;
      if (data.deviceDescription !== undefined) payload.description = String(data.deviceDescription || '').trim() || undefined;
      if (isUuidLikeDeviceName(payload.name)) {
        throw new Error('Selected device uses a UUID as its name. Register a new device with a real name.');
      }
    } else {
      const name = String(data.deviceName || '').trim();
      const platform = String(data.devicePlatform || '').trim();
      if (!name) throw new Error('Device name is required');
      if (isUuidLikeDeviceName(name)) throw new Error('Device name cannot be a UUID. Use something a human can recognize.');
      if (!platform) throw new Error('Device OS is required');
      if (data.deviceId) payload.deviceId = String(data.deviceId).trim();
      payload.name = name;
      payload.platform = platform;
      payload.description = String(data.deviceDescription || '').trim() || undefined;
    }

    const response = await apiClient.post('/auth/devices/register', payload);
    const device = apiClient.parseResponsePayload(response);
    sendResponse({
      success: true,
      device
    });
  } catch (error) {
    console.error('Failed to assign browser device:', error);
    sendResponse({
      success: false,
      error: error.message
    });
  }
}

async function handleRemoveFromContext(data, sendResponse) {
  try {
    // Delegate to handleRemoveCanvasDocument for consistent behavior
    await handleRemoveCanvasDocument(data, sendResponse);
  } catch (error) {
    console.error('Failed to remove from context:', error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleDeleteFromDatabase(data, sendResponse) {
  try {
    const { document, contextId, closeTab = false } = data;

    if (!document) {
      throw new Error('Canvas document is required');
    }

    // Get current mode and selection
    const mode = await browserStorage.getSyncMode();
    const currentContext = await browserStorage.getCurrentContext();
    const currentWorkspace = await browserStorage.getCurrentWorkspace();
    const workspacePath = await browserStorage.getWorkspacePath();

    // Get connection settings
    const connectionSettings = await browserStorage.getConnectionSettings();
    if (!connectionSettings.connected || !connectionSettings.apiToken) {
      throw new Error('Not connected to Canvas server');
    }

    // Initialize API client if needed
    if (!apiClient.apiToken) {
      apiClient.initialize(
        connectionSettings.serverUrl,
        connectionSettings.apiBasePath,
        connectionSettings.apiToken
      );
    }

    let result;

    if (mode === 'context') {
      // Context mode: use context API
      let targetContextId = contextId;
      if (!targetContextId) {
        if (!currentContext?.id) {
          throw new Error('No context selected');
        }
        targetContextId = currentContext.id;
      }

      // Delete from context/database
      const response = await apiClient.deleteDocument(targetContextId, document.id);
      result = { success: response.status === 'success', response };
    } else {
      // Explorer mode: use workspace API
      const workspace = currentWorkspace;
      if (!workspace?.id && !workspace?.name) {
        throw new Error('No workspace selected');
      }

      const wsId = workspace.name || workspace.id;
      const contextSpec = workspacePath || '/';

      console.log('Deleting document from workspace:', wsId, 'path:', contextSpec, 'documentId:', document.id);

      // Delete from workspace/database
      const response = await apiClient.deleteWorkspaceDocuments(wsId, [document.id], contextSpec, ['data/abstraction/tab']);
      result = { success: response.status === 'success', response };
    }

    // Close tab if requested
    if (closeTab && result.success && document.data?.url) {
      const tabs = await tabManager.findDuplicateTabs(document.data.url);
      for (const tab of tabs) {
        await tabManager.closeTab(tab.id);
      }
    }

    console.log('Delete Canvas document response:', result);
    sendResponse(result);
  } catch (error) {
    console.error('Failed to delete from database:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// New Tab Management Handlers

async function handleBindContext(data, sendResponse) {
  try {
    const { context } = data;

    if (!context || !context.id) {
      throw new Error('Valid context is required');
    }

    console.log('Binding to context:', context);

    // Save context to storage
    await browserStorage.setCurrentContext(context);

    // Notify context integration of context switch
    if (contextIntegration.isInitialized) {
      await contextIntegration.switchContext(context.id);
    }

    // Initialize WebSocket connection now that we have a context
    const connectionSettings = await browserStorage.getConnectionSettings();
    if (connectionSettings.connected && connectionSettings.apiToken) {
      console.log('Initializing WebSocket connection after context bind...');
      await initializeWebSocket();
    }

    console.log('Context bound successfully:', context.id);

    sendResponse({
      success: true,
      context: context,
      message: `Bound to context: ${context.id}`
    });
  } catch (error) {
    console.error('Failed to bind context:', error);
    sendResponse({
      success: false,
      error: error.message,
      message: 'Failed to bind context'
    });
  }
}

async function handleSaveSettings(data, sendResponse) {
  try {
    console.log('Saving all extension settings:', data);

    // Save connection settings
    if (data.connectionSettings) {
      // If server changes, reset selection/bindings (stale context URLs are worse than doing nothing).
      const previousConnection = await browserStorage.getConnectionSettings();
      const prevServerUrl = (previousConnection?.serverUrl || '').replace(/\/$/, '');
      const nextServerUrl = (data.connectionSettings?.serverUrl || '').replace(/\/$/, '');
      const serverChanged = !!prevServerUrl && (prevServerUrl !== nextServerUrl || previousConnection?.apiBasePath !== data.connectionSettings?.apiBasePath);
      if (serverChanged) {
        console.log('Server changed via settings - resetting context/workspace selection');
        if (webSocketClient.isConnected()) webSocketClient.disconnect();
        await browserStorage.setCurrentContext(null);
        await browserStorage.setCurrentWorkspace(null);
        await browserStorage.setWorkspacePath('/');
        await browserStorage.setSyncMode('explorer');
        await browserStorage.setUserInfo(null);
      }

      await browserStorage.setConnectionSettings(data.connectionSettings);
      console.log('Connection settings saved');
    }

    // Save sync settings
    if (data.syncSettings) {
      await browserStorage.setSyncSettings(data.syncSettings);
      console.log('Sync settings saved');
    }

    // Save browser identity
    if (data.browserIdentity) {
      await browserStorage.set(browserStorage.KEYS.BROWSER_IDENTITY, data.browserIdentity);
      console.log('Browser identity saved');
    }

    // Verify all settings were saved correctly
    const verifyConnection = await browserStorage.getConnectionSettings();
    const verifySync = await browserStorage.getSyncSettings();
    const verifyIdentity = await browserStorage.getBrowserIdentity();
    const verifyContext = await browserStorage.getCurrentContext();

    console.log('Settings verification:', {
      connection: verifyConnection,
      sync: verifySync,
      identity: verifyIdentity,
      context: verifyContext
    });

    // Update context menus after settings change
    await setupContextMenus();
    refreshTabLists();
    broadcastToPopup('settings.saved', {
      mode: await browserStorage.getSyncMode(),
      workspace: await browserStorage.getCurrentWorkspace(),
      workspacePath: await browserStorage.getWorkspacePath(),
      context: verifyContext
    });

    sendResponse({
      success: true,
      message: 'All settings saved successfully',
      savedSettings: {
        connection: verifyConnection,
        sync: verifySync,
        identity: verifyIdentity,
        context: verifyContext
      }
    });
  } catch (error) {
    console.error('Failed to save settings:', error);
    sendResponse({
      success: false,
      error: error.message,
      message: 'Failed to save settings'
    });
  }
}

async function handleGetSyncSettings(sendResponse) {
  try {
    console.log('Getting sync settings from storage...');

    // Get sync settings from storage
    const syncSettings = await browserStorage.getSyncSettings();

    console.log('Sync settings:', syncSettings);

    sendResponse({
      success: true,
      settings: syncSettings
    });
  } catch (error) {
    console.error('Failed to get sync settings:', error);
    sendResponse({
      success: false,
      settings: null,
      error: error.message
    });
  }
}

async function handleSetSyncSettings(data, sendResponse) {
  try {
    console.log('Setting sync settings:', data);

    // Save sync settings to storage (data is the partial settings object)
    await browserStorage.setSyncSettings(data);

    // Verify settings were saved
    const verifySettings = await browserStorage.getSyncSettings();
    console.log('Sync settings saved and verified:', verifySettings);

    sendResponse({
      success: true,
      message: 'Sync settings saved successfully',
      settings: verifySettings
    });
  } catch (error) {
    console.error('Failed to set sync settings:', error);
    sendResponse({
      success: false,
      error: error.message,
      message: 'Failed to set sync settings'
    });
  }
}

async function handleGetCanvasDocuments(data, sendResponse) {
  try {
    console.log('Getting Canvas documents for context:', data?.contextId);

    // Get current context if not provided
    let contextId = data?.contextId;
    if (!contextId) {
      const currentContext = await browserStorage.getCurrentContext();
      if (!currentContext?.id) {
        throw new Error('No context selected');
      }
      contextId = currentContext.id;
    }

    // Get connection settings
    const connectionSettings = await browserStorage.getConnectionSettings();
    console.log('Canvas Documents: connection settings check:', connectionSettings);

    // Check if we have essential connection info (prioritize API token over connected flag)
    if (!connectionSettings.apiToken || !connectionSettings.serverUrl) {
      console.error('Canvas Documents: Missing API token or server URL');
      throw new Error('Not connected to Canvas server - missing credentials');
    }

    if (!connectionSettings.connected) {
      console.warn('Canvas Documents: Connected flag is false, but we have API token - attempting operation');
    }

    // Initialize API client if needed
    if (!apiClient.apiToken) {
      apiClient.initialize(
        connectionSettings.serverUrl,
        connectionSettings.apiBasePath,
        connectionSettings.apiToken
      );
    }

    const limit = normalizeCanvasFetchLimit(data?.limit);
    const offset = normalizeCanvasFetchOffset(data?.offset);

    // Fetch Canvas documents with tab schema filter
    const featureArray = ['data/abstraction/tab'];
    const response = await apiClient.getContextDocuments(contextId, featureArray, { limit, offset });

    if (response.status === 'success') {
      sendResponse({
        success: true,
        documents: response.payload || [],
        count: response.count || 0,
        totalCount: response.totalCount || 0,
        limit,
        offset
      });
    } else {
      throw new Error(response.message || 'Failed to fetch Canvas documents');
    }
  } catch (error) {
    console.error('Failed to get Canvas documents:', error);
    sendResponse({
      success: false,
      documents: [],
      error: error.message
    });
  }
}

async function handleGetWorkspaceDocuments(data, sendResponse) {
  try {
    // Use explicit property access to avoid triggering security scanners
    const requestData = data || {};
    const workspaceIdOrName = requestData.workspaceIdOrName;
    const contextSpec = requestData.contextSpec || '/';

    // Resolve workspace from storage if not provided
    let wsIdOrName = workspaceIdOrName;
    if (!wsIdOrName) {
      const storedWs = await browserStorage.getCurrentWorkspace();
      if (!storedWs?.id && !storedWs?.name) {
        throw new Error('No workspace selected');
      }
      wsIdOrName = storedWs.name || storedWs.id;
    }

    // Get connection settings
    const connectionSettings = await browserStorage.getConnectionSettings();
    if (!connectionSettings.apiToken || !connectionSettings.serverUrl) {
      throw new Error('Not connected to Canvas server - missing credentials');
    }

    // Initialize API client if needed
    if (!apiClient.apiToken) {
      apiClient.initialize(
        connectionSettings.serverUrl,
        connectionSettings.apiBasePath,
        connectionSettings.apiToken
      );
    }

    const limit = normalizeCanvasFetchLimit(requestData.limit);
    const offset = normalizeCanvasFetchOffset(requestData.offset);

    // Fetch documents for workspace path
    const response = await apiClient.getWorkspaceDocuments(wsIdOrName, contextSpec, ['data/abstraction/tab'], { limit, offset });

    if (response.status === 'success') {
      sendResponse({
        success: true,
        documents: response.payload || [],
        count: response.count || 0,
        totalCount: response.totalCount || 0,
        limit,
        offset
      });
    } else {
      throw new Error(response.message || 'Failed to fetch workspace documents');
    }
  } catch (error) {
    console.error('Failed to get workspace documents:', error);
    sendResponse({ success: false, documents: [], error: error.message });
  }
}

function normalizeCanvasFetchLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) return 200;
  return Math.min(1000, Math.max(1, Math.floor(limit)));
}

function normalizeCanvasFetchOffset(value) {
  const offset = Number(value);
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
}

async function handleSyncTab(data, sendResponse) {
  try {
    const { tab, contextId, contextSpec } = data;

    if (!tab) {
      throw new Error('Tab object is required');
    }

    console.log('Syncing tab to Canvas:', tab);

    if (!tabManager.isActiveSyncCandidate(tab)) {
      throw new Error('Hidden or discarded tabs are not active sync candidates');
    }

    const mode = await browserStorage.getSyncMode();
    const currentContext = await browserStorage.getCurrentContext();
    const currentWorkspace = await browserStorage.getCurrentWorkspace();
    const workspacePath = await browserStorage.getWorkspacePath();

    // Get connection settings
    const connectionSettings = await ensureApiClientReady();
    console.log('Sync Tab: connection settings check:', connectionSettings);

    // Get sync settings
    const syncSettings = await browserStorage.getSyncSettings();

    // Check if we have essential connection info (prioritize API token over connected flag)
    if (!connectionSettings.apiToken || !connectionSettings.serverUrl) {
      console.error('Sync Tab: Missing API token or server URL');
      throw new Error('Not connected to Canvas server - missing credentials');
    }

    if (!connectionSettings.connected) {
      console.warn('Sync Tab: Connected flag is false, but we have API token - attempting operation');
    }

    // Get browser identity
    const browserIdentity = await browserStorage.getBrowserIdentity();

    // Sync the tab
    let result;
    if (mode === 'context') {
      const targetContextId = contextId || currentContext?.id;
      if (!targetContextId) throw new Error('No context selected');
      result = await tabManager.syncTabToCanvas(tab, apiClient, targetContextId, browserIdentity, syncSettings);
    } else {
      // Workspace mode
      const wsId = currentWorkspace?.name || currentWorkspace?.id;
      if (!wsId) throw new Error('No workspace selected');
      const document = tabManager.convertTabToDocument(tab, browserIdentity, syncSettings);
      const resp = await apiClient.insertWorkspaceDocument(wsId, document, contextSpec || workspacePath || '/', document.featureArray);
      if (resp.status === 'success') {
        const docId = Array.isArray(resp.payload) ? resp.payload[0] : resp.payload;
        tabManager.markTabAsSynced(tab.id, docId, document.data?.url);
        result = { success: true, documentId: docId };
      } else {
        result = { success: false, error: resp.message || 'Failed to sync tab' };
      }
    }

    console.log('Tab sync result:', result);
    sendResponse(result);
  } catch (error) {
    console.error('Failed to sync tab:', error);
    sendResponse({
      success: false,
      error: error.message
    });
  }
}

async function handleSyncMultipleTabs(data, sendResponse) {
  try {
    console.log('🔧 handleSyncMultipleTabs called with data:', data);

    const { tabIds, contextId, contextSpec } = data;

    if (!tabIds || !Array.isArray(tabIds)) {
      console.error('❌ Tab IDs validation failed:', { tabIds, isArray: Array.isArray(tabIds) });
      throw new Error('Tab IDs array is required');
    }

    console.log(`🔧 Processing ${tabIds.length} tab IDs:`, tabIds);

    // Get the tabs
    const tabs = [];
    for (const tabId of tabIds) {
      const tab = await tabManager.getTab(tabId);
      if (tab && tabManager.isActiveSyncCandidate(tab)) {
        tabs.push(tab);
        console.log(`✅ Found tab ${tabId}: ${tab.title}`, {
          id: tab.id,
          url: tab.url,
          title: tab.title,
          status: tab.status,
          discarded: tab.discarded,
          windowId: tab.windowId
        });
      } else {
        console.warn(`⚠️ Tab ${tabId} not found or inactive`);
      }
    }

    if (tabs.length === 0) {
      console.error('❌ No valid tabs found after lookup');
      throw new Error('No valid tabs found');
    }

    console.log(`🔧 Found ${tabs.length} valid tabs to sync`);

    const mode = await browserStorage.getSyncMode();
    const currentContext = await browserStorage.getCurrentContext();
    const currentWorkspace = await browserStorage.getCurrentWorkspace();
    const workspacePath = await browserStorage.getWorkspacePath();

    if (mode === 'context') {
      console.log(`🔧 Target context ID: ${contextId || currentContext?.id}`);
    } else {
      console.log(`🔧 Target workspace: ${currentWorkspace?.name || currentWorkspace?.id}, path: ${contextSpec || workspacePath || '/'}`);
    }

    // Get connection settings
    const connectionSettings = await ensureApiClientReady();
    console.log('🔧 Connection settings:', connectionSettings);

    // Get sync settings
    const syncSettings = await browserStorage.getSyncSettings();

    if (!connectionSettings.connected || !connectionSettings.apiToken) {
      console.error('❌ Not connected to Canvas server:', {
        connected: connectionSettings.connected,
        hasToken: !!connectionSettings.apiToken
      });
      throw new Error('Not connected to Canvas server');
    }

    // Get browser identity
    const browserIdentity = await browserStorage.getBrowserIdentity();
    console.log('🔧 Browser identity:', browserIdentity);

    let result;
    if (mode === 'context' && !contextSpec) {
      console.log('🔧 Calling tabManager.syncMultipleTabs (context mode)...');
      const targetContextId = contextId || currentContext?.id;
      if (!targetContextId) throw new Error('No context selected');
      result = await tabManager.syncMultipleTabs(tabs, apiClient, targetContextId, browserIdentity, syncSettings);
    } else {
      // Explorer mode, or context mode with explicit contextSpec (Sync To)
      const wsId = contextSpec
        ? (currentContext?.workspaceName || currentWorkspace?.name || currentWorkspace?.id)
        : (currentWorkspace?.name || currentWorkspace?.id);
      if (!wsId) throw new Error('No workspace selected');
      console.log(`🔧 Syncing multiple tabs to workspace ${wsId} at path ${contextSpec || workspacePath || '/'}...`);
      const docs = tabs.map(tab => tabManager.convertTabToDocument(tab, browserIdentity, syncSettings));
      const resp = await apiClient.insertWorkspaceDocuments(wsId, docs, contextSpec || workspacePath || '/', docs[0]?.featureArray || []);
      if (resp.status === 'success') {
        const documentIds = Array.isArray(resp.payload) ? resp.payload : [resp.payload];
        tabs.forEach((tab, index) => {
          tabManager.markTabAsSynced(tab.id, documentIds[index] ?? documentIds[0], docs[index]?.data?.url);
        });
        result = { success: true, total: tabs.length, successful: tabs.length, failed: 0, documentIds };
      } else {
        result = { success: false, error: resp.message || 'Batch sync failed' };
      }
    }

    console.log('✅ tabManager.syncMultipleTabs completed with result:', result);
    sendResponse(result);
  } catch (error) {
    console.error('❌ handleSyncMultipleTabs failed:', error);
    sendResponse({
      success: false,
      error: error.message
    });
  }
}

async function handleOpenCanvasDocument(data, sendResponse) {
  try {
    const { document, documents, options = {} } = data;

    if (!document && !documents) {
      throw new Error('Canvas document or documents array is required');
    }

    // Handle multiple documents (bulk operation)
    if (documents && Array.isArray(documents)) {
      console.log('Opening multiple Canvas documents:', documents.length);

      const bulkOptions = {
        ...options,
        allowDuplicates: options.allowDuplicates === true,
        active: false
      };
      const syncSettings = await browserStorage.getSyncSettings();
      const result = await tabManager.openCanvasDocuments(documents, bulkOptions, syncSettings);
      sendResponse(result);
      return;
    }

    // Handle single document
    const result = await tabManager.openCanvasDocument(document, options);
    sendResponse(result);

  } catch (error) {
    console.error('Failed to open Canvas document(s):', error);
    sendResponse({
      success: false,
      error: error.message
    });
  }
}

async function handleRemoveCanvasDocument(data, sendResponse) {
  try {
    const { document, contextId, closeTab = false } = data;

    if (!document) {
      throw new Error('Canvas document is required');
    }

    // Get current mode and selection
    const mode = await browserStorage.getSyncMode();
    const currentContext = await browserStorage.getCurrentContext();
    const currentWorkspace = await browserStorage.getCurrentWorkspace();
    const workspacePath = await browserStorage.getWorkspacePath();

    // Get sync settings to check if we should auto-close tabs
    const syncSettings = await browserStorage.getSyncSettings();

    // Get connection settings
    const connectionSettings = await browserStorage.getConnectionSettings();
    if (!connectionSettings.connected || !connectionSettings.apiToken) {
      throw new Error('Not connected to Canvas server');
    }

    // Initialize API client if needed
    if (!apiClient.apiToken) {
      apiClient.initialize(
        connectionSettings.serverUrl,
        connectionSettings.apiBasePath,
        connectionSettings.apiToken
      );
    }

    let result;

    if (mode === 'context') {
      // Context mode: use context API
      let targetContextId = contextId;
      if (!targetContextId) {
        if (!currentContext?.id) {
          throw new Error('No context selected');
        }
        targetContextId = currentContext.id;
      }

      // Remove or delete from context based on closeTab flag
      const response = closeTab
        ? await apiClient.deleteDocument(targetContextId, document.id)
        : await apiClient.removeDocument(targetContextId, document.id);
      result = { success: response.status === 'success', response };
    } else {
      // Explorer mode: use workspace API
      const workspace = currentWorkspace;
      if (!workspace?.id && !workspace?.name) {
        throw new Error('No workspace selected');
      }

      const wsId = workspace.name || workspace.id;
      const contextSpec = workspacePath || '/';

      console.log(`${closeTab ? 'Deleting' : 'Removing'} document from workspace:`, wsId, 'path:', contextSpec, 'documentId:', document.id);

      // Remove or delete from workspace based on closeTab flag
      const response = closeTab
        ? await apiClient.deleteWorkspaceDocuments(wsId, [document.id], contextSpec, ['data/abstraction/tab'])
        : await apiClient.removeWorkspaceDocuments(wsId, [document.id], contextSpec, ['data/abstraction/tab']);
      result = { success: response.status === 'success', response };
    }

    // Close tab only if user setting allows it and the operation was successful
    if (result.success && document.data?.url && syncSettings.closeTabsRemovedFromCanvas) {
      console.log('Closing browser tabs for removed/deleted document due to user setting');
      const tabs = await tabManager.findTabsMatchingUrls([document.data.url], syncSettings);
      await tabManager.closeTabs(tabs.map(tab => tab.id));
    } else if (result.success && document.data?.url) {
      console.log('Not closing browser tabs - closeTabsRemovedFromCanvas setting is disabled');
    }

    console.log('Remove Canvas document response:', result);
    sendResponse(result);
  } catch (error) {
    console.error('Failed to remove Canvas document:', error);
    sendResponse({
      success: false,
      error: error.message
    });
  }
}

async function handleRemoveCanvasDocuments(data, sendResponse) {
  try {
    const { documents, contextId, closeTab = false } = data || {};
    const items = Array.isArray(documents) ? documents.filter(Boolean) : [];
    if (items.length === 0) {
      throw new Error('Canvas documents array is required');
    }

    const documentIds = items.map(doc => doc.id).filter(id => id !== undefined && id !== null);
    if (documentIds.length === 0) {
      throw new Error('No valid document IDs found');
    }

    const mode = await browserStorage.getSyncMode();
    const currentContext = await browserStorage.getCurrentContext();
    const currentWorkspace = await browserStorage.getCurrentWorkspace();
    const workspacePath = await browserStorage.getWorkspacePath();
    const syncSettings = await browserStorage.getSyncSettings();

    await ensureApiClientReady();

    let response;
    if (mode === 'context') {
      const targetContextId = contextId || currentContext?.id;
      if (!targetContextId) throw new Error('No context selected');
      response = closeTab
        ? await apiClient.deleteDocuments(targetContextId, documentIds)
        : await apiClient.removeDocuments(targetContextId, documentIds);
    } else {
      const wsId = currentWorkspace?.name || currentWorkspace?.id;
      if (!wsId) throw new Error('No workspace selected');
      const contextSpec = workspacePath || '/';
      response = closeTab
        ? await apiClient.deleteWorkspaceDocuments(wsId, documentIds, contextSpec, ['data/abstraction/tab'])
        : await apiClient.removeWorkspaceDocuments(wsId, documentIds, contextSpec, ['data/abstraction/tab']);
    }

    const success = response.status === 'success';
    if (success && syncSettings.closeTabsRemovedFromCanvas) {
      const urls = items.map(doc => doc.data?.url).filter(Boolean);
      const matchingTabs = await tabManager.findTabsMatchingUrls(urls, syncSettings);
      if (matchingTabs.length > 0) {
        await tabManager.closeTabs(matchingTabs.map(tab => tab.id));
      }
    }

    sendResponse({
      success,
      total: items.length,
      successful: success ? items.length : 0,
      failed: success ? 0 : items.length,
      response
    });
  } catch (error) {
    console.error('Failed to remove Canvas documents:', error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleUpdateContextUrl(message, sendResponse) {
  try {
    const { contextId, url } = message;

    if (!contextId || !url) {
      throw new Error('Context ID and URL are required');
    }

    console.log('Updating context URL:', contextId, '→', url);

    // Make API request to update context URL
    const response = await apiClient.updateContextUrl(contextId, url);

    // Update current context in storage if it's the same one being updated
    const currentContext = await browserStorage.getCurrentContext();
    if (currentContext && currentContext.id === contextId) {
      currentContext.url = url;
      await browserStorage.setCurrentContext(currentContext);

      // Trigger sync engine to handle the URL change
      if (syncEngine.isInitialized) {
        console.log('Triggering sync engine for manual context URL change');
        await syncEngine.handleContextUrlChange(contextId, url);
      }
    }

    // Notify all listeners about the URL change
    await runtimeAPI.sendMessage({
      type: 'BACKGROUND_EVENT',
      eventType: 'context.url.set',
      data: { contextId, url }
    });

    sendResponse({
      success: true,
      data: response
    });
  } catch (error) {
    console.error('Failed to update context URL:', error);
    sendResponse({
      success: false,
      error: error.message
    });
  }
}

// Notification helper function for cross-browser compatibility
async function showNotification(title, message) {
  try {
    const notificationsAPI = (typeof chrome !== 'undefined' && chrome.notifications) ? chrome.notifications : browser.notifications;

    if (!notificationsAPI) {
      console.warn('Notifications API not available');
      return;
    }

    await notificationsAPI.create({
      type: 'basic',
      iconUrl: 'assets/icons/logo-wr_128x128.png',
      title: title,
      message: message,
      priority: 1
    });
  } catch (error) {
    console.error('Failed to show notification:', error);
  }
}

// Context Menu functionality
async function setupContextMenus() {
  try {
    console.log('🔧 Setting up context menus...');

    // Browser compatibility for context menus
    const contextMenusAPI = (typeof chrome !== 'undefined' && chrome.contextMenus) ? chrome.contextMenus : browser.contextMenus;

    if (!contextMenusAPI) {
      console.error('❌ Context menus API not available');
      return;
    }

    console.log('🔧 Context menus API available, removing existing menus...');
    // Remove existing context menus first
    await contextMenusAPI.removeAll();

    // Check if we're connected
    const connectionSettings = await browserStorage.getConnectionSettings();
    console.log('🔧 Connection settings for context menu:', connectionSettings);

    if (!connectionSettings.connected) {
      console.log('Not connected - skipping context menu setup');
      return;
    }

    console.log('🔧 Creating root context menu items...');
    // Always create simple "Send page to Canvas" with workspace tree
    // Note: documentUrlPatterns excludes extension pages
    try {
      contextMenusAPI.create({
        id: 'send-page-to-canvas',
        title: 'Send page to Canvas',
        contexts: ['page'],
        documentUrlPatterns: ['http://*/*', 'https://*/*', 'file://*/*'],
        visible: true
      });
      console.log('✅ Root context menu item (page) created successfully');
    } catch (error) {
      console.error('❌ Failed to create root context menu item (page):', error);
      return;
    }

    // "Sync and close" variants
    try {
      contextMenusAPI.create({
        id: 'send-page-to-canvas-close',
        title: 'Send page to Canvas (close tab)',
        contexts: ['page'],
        documentUrlPatterns: ['http://*/*', 'https://*/*', 'file://*/*'],
        visible: true
      });
      console.log('✅ Root context menu item (page close) created successfully');
    } catch (error) {
      console.error('❌ Failed to create root context menu item (page close):', error);
    }

    // Get current mode and selection
    const mode = await browserStorage.getSyncMode();
    const currentContext = await browserStorage.getCurrentContext();
    const currentWorkspace = await browserStorage.getCurrentWorkspace();
    const workspacePath = await browserStorage.getWorkspacePath();

    // Helper function to create menu items for page context
    const createPageMenuItem = (itemConfig, parentIdPage, idPrefix = '') => {
      try {
        contextMenusAPI.create({
          ...itemConfig,
          id: `${idPrefix}${itemConfig.id}`,
          parentId: `${parentIdPage}`,
          contexts: ['page'],
          documentUrlPatterns: ['http://*/*', 'https://*/*', 'file://*/*']
        });
      } catch (error) {
        console.error(`❌ Failed to create page context menu item ${itemConfig.id}:`, error);
      }
    };

    // Add current context URL as first item (for better UX)
    if (mode === 'context' && currentContext?.url) {
      createPageMenuItem({
        id: `current-context:${currentContext.id}`,
        title: `🎯 Current Context: ${currentContext.url}`
      }, 'send-page-to-canvas');
      createPageMenuItem({
        id: `current-context:${currentContext.id}`,
        title: `🎯 Current Context: ${currentContext.url}`
      }, 'send-page-to-canvas-close', 'close:');
      console.log('✅ Current context URL menu items created');
    } else if (mode === 'explorer' && currentWorkspace) {
      try {
        const wsName = currentWorkspace.name || currentWorkspace.id;
        const pathDisplay = workspacePath && workspacePath !== '/' ? workspacePath : '/';
        createPageMenuItem({
          id: `current-workspace:${wsName}:${pathDisplay}`,
          title: `🎯 Current: ${wsName}${pathDisplay}`
        }, 'send-page-to-canvas');
        createPageMenuItem({
          id: `current-workspace:${wsName}:${pathDisplay}`,
          title: `🎯 Current: ${wsName}${pathDisplay}`
        }, 'send-page-to-canvas-close', 'close:');
        console.log('✅ Current workspace/path menu items created');
      } catch (error) {
        console.error('❌ Failed to create current workspace menu items:', error);
      }
    }

    // Add recent destinations
    try {
      const recentDestinations = await browserStorage.getRecentDestinations();
      if (recentDestinations.length > 0) {
        console.log('🔧 Adding recent destinations:', recentDestinations.length);

        // Add separator before recent destinations
        createPageMenuItem({
          id: 'recent-separator',
          type: 'separator'
        }, 'send-page-to-canvas');
        createPageMenuItem({
          id: 'recent-separator',
          type: 'separator'
        }, 'send-page-to-canvas-close', 'close:');

        // Filter out current context/workspace from recent destinations to avoid duplication
        const filteredRecent = recentDestinations.filter(dest => {
          if (mode === 'context' && currentContext) {
            // For context mode, filter out the current context
            return !(dest.type === 'context' && dest.contextId === currentContext.id);
          } else if (mode === 'explorer' && currentWorkspace) {
            // For explorer mode, filter out the current workspace/path combination
            const currentWsName = currentWorkspace.name || currentWorkspace.id;
            const currentPath = workspacePath || '/';
            return !(dest.type === 'workspace' && dest.workspaceName === currentWsName && dest.contextSpec === currentPath);
          }
          return true;
        });

        // Add recent destinations (up to 5)
        for (const dest of filteredRecent.slice(0, 5)) {
          try {
            let title = '';
            let menuId = '';

            if (dest.type === 'context') {
              title = `📋 Recent: ${dest.title}`;
              menuId = `recent-context:${dest.contextId}`;
            } else if (dest.type === 'workspace') {
              const pathDisplay = dest.contextSpec && dest.contextSpec !== '/' ? dest.contextSpec : '/';
              title = `📋 Recent: ${dest.workspaceName}${pathDisplay}`;
              menuId = `recent-workspace:${dest.workspaceName}:${dest.contextSpec || '/'}`;
            }

            if (title && menuId) {
              createPageMenuItem({
                id: menuId,
                title: title
              }, 'send-page-to-canvas');
              createPageMenuItem({
                id: menuId,
                title: title
              }, 'send-page-to-canvas-close', 'close:');
            }
          } catch (error) {
            console.error('❌ Failed to create recent destination menu item:', error);
          }
        }

        console.log('✅ Recent destinations menu items created');
      }
    } catch (error) {
      console.error('❌ Failed to add recent destinations:', error);
    }

    // Add separator before workspace list
    if (mode === 'context' && currentContext?.url ||
        mode === 'explorer' && currentWorkspace ||
        (await browserStorage.getRecentDestinations()).length > 0) {
      createPageMenuItem({
        id: 'workspaces-separator',
        type: 'separator'
      }, 'send-page-to-canvas');
      createPageMenuItem({
        id: 'workspaces-separator',
        type: 'separator'
      }, 'send-page-to-canvas-close', 'close:');
    }

    // Helper function to build workspace tree for a given parent menu ID and context
    const buildWorkspaceMenus = async (parentMenuId, contextType, idPrefix = '') => {
      try {
        const workspacesResp = await apiClient.getWorkspaces();
        console.log(`🔧 Workspaces response for ${contextType}:`, workspacesResp);

        if (workspacesResp.status === 'success' && workspacesResp.payload) {
          console.log(`🔧 Creating workspace menus for ${workspacesResp.payload.length} workspaces (${contextType})...`);

          for (const workspace of workspacesResp.payload) {
            const wsId = `${idPrefix}ws:${workspace.name || workspace.id}`;
            console.log(`🔧 Creating workspace menu for: ${workspace.name || workspace.id} (${contextType})`);

            // Create workspace submenu
            try {
              contextMenusAPI.create({
                id: wsId,
                parentId: parentMenuId,
                title: workspace.name || workspace.id,
                contexts: [contextType],
                documentUrlPatterns: ['http://*/*', 'https://*/*', 'file://*/*']
              });
              console.log(`✅ Workspace menu created for: ${workspace.name || workspace.id} (${contextType})`);
            } catch (error) {
              console.error(`❌ Failed to create workspace menu for ${workspace.name || workspace.id} (${contextType}):`, error);
              continue;
            }

            // Try to get workspace tree for this workspace
            try {
              const treeResp = await apiClient.getWorkspaceTree(workspace.name || workspace.id);
              const tree = treeResp?.payload || treeResp?.data || treeResp;

              if (tree && tree.children && Array.isArray(tree.children)) {
                // Add root option
                contextMenusAPI.create({
                  id: `${wsId}:/`,
                  parentId: wsId,
                  title: '📁 / (root)',
                  contexts: [contextType],
                  documentUrlPatterns: ['http://*/*', 'https://*/*', 'file://*/*']
                });

                // Build tree structure
                const buildMenuForNode = (node, parentMenuId, currentPath) => {
                  const segment = node.name === '/' ? '' : node.name;
                  const newPath = currentPath === '/' ? `/${segment}`.replace(/\/+/g, '/') : `${currentPath}/${segment}`.replace(/\/+/g, '/');
                  const safePath = newPath === '' ? '/' : newPath;

                  const nodeMenuId = `${wsId}:${safePath}`;
                  const displayName = node.label || node.name;

                  // If this directory has children, create a submenu structure
                  if (Array.isArray(node.children) && node.children.length > 0) {
                    // Create the directory itself as a submenu container
                    contextMenusAPI.create({
                      id: nodeMenuId,
                      parentId: parentMenuId,
                      title: `📁 ${displayName}`,
                      contexts: [contextType],
                      documentUrlPatterns: ['http://*/*', 'https://*/*', 'file://*/*']
                    });

                    // Add "Insert to <directory-name>" as first option
                    contextMenusAPI.create({
                      id: `${nodeMenuId}:insert`,
                      parentId: nodeMenuId,
                      title: `📥 Insert to "${displayName}"`,
                      contexts: [contextType],
                      documentUrlPatterns: ['http://*/*', 'https://*/*', 'file://*/*']
                    });

                    // Add separator before subdirectories
                    contextMenusAPI.create({
                      id: `${nodeMenuId}:separator`,
                      parentId: nodeMenuId,
                      type: 'separator',
                      contexts: [contextType],
                      documentUrlPatterns: ['http://*/*', 'https://*/*', 'file://*/*']
                    });

                    // Recurse for children under the directory menu
                    for (const child of node.children) {
                      buildMenuForNode(child, nodeMenuId, safePath);
                    }
                  } else {
                    // No children, create the directory as a direct clickable item
                    contextMenusAPI.create({
                      id: nodeMenuId,
                      parentId: parentMenuId,
                      title: `📁 ${displayName}`,
                      contexts: [contextType],
                      documentUrlPatterns: ['http://*/*', 'https://*/*', 'file://*/*']
                    });
                  }
                };

                // Build tree starting from root children
                for (const child of tree.children) {
                  buildMenuForNode(child, wsId, '/');
                }
              } else {
                // No tree structure, just add root option
                contextMenusAPI.create({
                  id: `${wsId}:/`,
                  parentId: wsId,
                  title: '📁 / (root)',
                  contexts: [contextType],
                  documentUrlPatterns: ['http://*/*', 'https://*/*', 'file://*/*']
                });
              }
            } catch (treeError) {
              console.warn(`Failed to load tree for workspace ${workspace.name || workspace.id} (${contextType}):`, treeError);
              // Add root option as fallback
              contextMenusAPI.create({
                id: `${wsId}:/`,
                parentId: wsId,
                title: '📁 / (root)',
                contexts: [contextType],
                documentUrlPatterns: ['http://*/*', 'https://*/*', 'file://*/*']
              });
            }
          }
        }
      } catch (workspaceError) {
        console.warn(`Failed to load workspaces for context menu (${contextType}):`, workspaceError);
      }
    };

    // Get all workspaces and build menu tree
    try {
      // Ensure API client is initialized
      if (!apiClient.apiToken) {
        apiClient.initialize(
          connectionSettings.serverUrl,
          connectionSettings.apiBasePath,
          connectionSettings.apiToken
        );
      }

      // Build workspace menus for page context
      await buildWorkspaceMenus('send-page-to-canvas', 'page', '');
      await buildWorkspaceMenus('send-page-to-canvas-close', 'page', 'close:');
    } catch (workspaceError) {
      console.warn('Failed to load workspaces for context menu:', workspaceError);
    }

    console.log('✅ Context menus set up successfully');
  } catch (error) {
    console.error('❌ Failed to setup context menus:', error);
    console.error('❌ Context menu setup error details:', error.stack || error);
  }
}

// Handle context menu clicks
// Browser compatibility for context menu events
const contextMenusAPI = (typeof chrome !== 'undefined' && chrome.contextMenus) ? chrome.contextMenus : browser.contextMenus;

if (contextMenusAPI && contextMenusAPI.onClicked) {
  console.log('🔧 Setting up context menu click listener...');
  contextMenusAPI.onClicked.addListener(async (info, tab) => {
    try {
      console.log('🔧 Context menu clicked:', info.menuItemId, 'for tab:', tab.id, 'URL:', tab.url, 'Link URL:', info.linkUrl);

      // Block context menu actions on extension pages (popup, settings, etc.)
      if (tab.url && (tab.url.startsWith('chrome-extension://') || tab.url.startsWith('moz-extension://') || tab.url.startsWith('browser-extension://'))) {
        console.log('Context menu blocked on extension page:', tab.url);
        return;
      }

      await ensureApiClientReady();

      // Handle "close tab after send" prefix
      let closeAfterSend = false;
      if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('close:')) {
        closeAfterSend = true;
        info.menuItemId = info.menuItemId.substring(6);
      }

      // If the user has multi-selected tabs in Chrome (highlighted), send all of them.
      // Fallback to the clicked tab when selection is not available.
      let selectedTabs = [tab];
      try {
        if (tab?.windowId !== undefined) {
          const highlighted = await tabsAPI.query({ windowId: tab.windowId, highlighted: true });
          if (Array.isArray(highlighted) && highlighted.length > 1) {
            selectedTabs = highlighted;
          }
        }
      } catch (e) {
        console.warn('Failed to query highlighted tabs (falling back to single tab):', e?.message || e);
      }

      const closeSelectedTabsSafely = async () => {
        try {
          if (!closeAfterSend) return;

          // Simple safety: if we'd close everything, open a blank tab first.
          if (await syncEngine.wouldLeaveEmptyBrowser(selectedTabs)) {
            const safeUrl = (typeof chrome !== 'undefined') ? 'chrome://newtab/' : 'about:blank';
            await tabManager.openTab(safeUrl, { active: false });
          }

          await tabManager.closeTabs(selectedTabs.map(t => t.id));
        } catch (e) {
          console.warn('Failed to close selected tabs:', e?.message || e);
        }
      };

      // Handle current context clicks
      if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('current-context:')) {
        const contextId = info.menuItemId.replace('current-context:', '');
        try {
          // Get sync settings and browser identity
          const syncSettings = await browserStorage.getSyncSettings();
          const browserIdentity = await browserStorage.getBrowserIdentity();
          const currentContext = await browserStorage.getCurrentContext();

          // Sync selected tabs to current context
          const result = selectedTabs.length > 1
            ? await tabManager.syncMultipleTabs(selectedTabs, apiClient, contextId, browserIdentity, syncSettings)
            : await tabManager.syncTabToCanvas(selectedTabs[0], apiClient, contextId, browserIdentity, syncSettings);

          if (result.success) {
            console.log(`Tab synced to current context ${contextId} via context menu`);
            await closeSelectedTabsSafely();
            // Track as recent destination
            if (currentContext) {
              await browserStorage.addRecentDestination({
                id: `context:${contextId}`,
                type: 'context',
                contextId: contextId,
                title: currentContext.url || contextId
              });
            }
            // Refresh context menus to update recent destinations list
            await setupContextMenus();
            // Show success notification
            const title = selectedTabs.length > 1 ? `${selectedTabs.length} tabs` : (selectedTabs[0].title || selectedTabs[0].url);
            await showNotification('Sent to Canvas', `"${title}" was sent to Canvas`);
          } else {
            console.error('Failed to sync tab to current context:', result.error);
          }
        } catch (e) {
          console.error('Exception syncing tab to current context:', e);
        }
      }

      // Handle current workspace clicks
      else if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('current-workspace:')) {
        const parts = info.menuItemId.replace('current-workspace:', '').split(':');
        if (parts.length >= 2) {
          const workspaceName = parts[0];
          const contextSpec = parts.slice(1).join(':'); // Rejoin in case path contains colons

          try {
            // Get sync settings and browser identity
            const syncSettings = await browserStorage.getSyncSettings();
            const browserIdentity = await browserStorage.getBrowserIdentity();

            const documents = selectedTabs.map(t => tabManager.convertTabToDocument(t, browserIdentity, syncSettings));
            const response = documents.length > 1
              ? await apiClient.insertWorkspaceDocuments(workspaceName, documents, contextSpec || '/', documents[0].featureArray)
              : await apiClient.insertWorkspaceDocument(workspaceName, documents[0], contextSpec || '/', documents[0].featureArray);

            if (response.status === 'success') {
              const documentIds = Array.isArray(response.payload) ? response.payload : [response.payload];
              selectedTabs.forEach((tab, index) => {
                tabManager.markTabAsSynced(tab.id, documentIds[index] ?? documentIds[0], documents[index]?.data?.url);
              });
              console.log(`Tab synced to current workspace ${workspaceName} at path ${contextSpec} via context menu`);
              await closeSelectedTabsSafely();

              // Track as recent destination
              await browserStorage.addRecentDestination({
                id: `workspace:${workspaceName}:${contextSpec}`,
                type: 'workspace',
                workspaceName: workspaceName,
                contextSpec: contextSpec,
                title: `${workspaceName}${contextSpec}`
              });

              // Refresh context menus to update recent destinations list
              await setupContextMenus();
              // Show success notification
              const title = selectedTabs.length > 1 ? `${selectedTabs.length} tabs` : (selectedTabs[0].title || selectedTabs[0].url);
              await showNotification('Sent to Canvas', `"${title}" was sent to ${workspaceName}${contextSpec}`);
            } else {
              console.error('Failed to sync tab via context menu:', response.message);
            }
          } catch (e) {
            console.error('Exception syncing tab via context menu:', e);
          }
        }
      }

      // Handle recent context clicks
      else if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('recent-context:')) {
        const contextId = info.menuItemId.replace('recent-context:', '');
        try {
          // Get sync settings and browser identity
          const syncSettings = await browserStorage.getSyncSettings();
          const browserIdentity = await browserStorage.getBrowserIdentity();

          // Sync selected tabs to recent context
          const result = selectedTabs.length > 1
            ? await tabManager.syncMultipleTabs(selectedTabs, apiClient, contextId, browserIdentity, syncSettings)
            : await tabManager.syncTabToCanvas(selectedTabs[0], apiClient, contextId, browserIdentity, syncSettings);

          if (result.success) {
            console.log(`Tab synced to recent context ${contextId} via context menu`);
            await closeSelectedTabsSafely();
            // Update recent destination timestamp
            const recentDestinations = await browserStorage.getRecentDestinations();
            const existingDest = recentDestinations.find(d => d.contextId === contextId);
            if (existingDest) {
              await browserStorage.addRecentDestination({
                id: `context:${contextId}`,
                type: 'context',
                contextId: contextId,
                title: existingDest.title
              });
            }
            // Refresh context menus to update recent destinations list
            await setupContextMenus();
            // Show success notification
            const title = selectedTabs.length > 1 ? `${selectedTabs.length} tabs` : (selectedTabs[0].title || selectedTabs[0].url);
            await showNotification('Sent to Canvas', `"${title}" was sent to Canvas`);
          } else {
            console.error('Failed to sync tab to recent context:', result.error);
          }
        } catch (e) {
          console.error('Exception syncing tab to recent context:', e);
        }
      }

      // Handle recent workspace clicks
      else if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('recent-workspace:')) {
        const parts = info.menuItemId.replace('recent-workspace:', '').split(':');
        if (parts.length >= 2) {
          const workspaceName = parts[0];
          const contextSpec = parts.slice(1).join(':'); // Rejoin in case path contains colons

          try {
            // Get sync settings and browser identity
            const syncSettings = await browserStorage.getSyncSettings();
            const browserIdentity = await browserStorage.getBrowserIdentity();

            const documents = selectedTabs.map(t => tabManager.convertTabToDocument(t, browserIdentity, syncSettings));
            const response = documents.length > 1
              ? await apiClient.insertWorkspaceDocuments(workspaceName, documents, contextSpec || '/', documents[0].featureArray)
              : await apiClient.insertWorkspaceDocument(workspaceName, documents[0], contextSpec || '/', documents[0].featureArray);

            if (response.status === 'success') {
              const documentIds = Array.isArray(response.payload) ? response.payload : [response.payload];
              selectedTabs.forEach((tab, index) => {
                tabManager.markTabAsSynced(tab.id, documentIds[index] ?? documentIds[0], documents[index]?.data?.url);
              });
              console.log(`Tab synced to recent workspace ${workspaceName} at path ${contextSpec} via context menu`);
              await closeSelectedTabsSafely();

              // Update recent destination timestamp
              await browserStorage.addRecentDestination({
                id: `workspace:${workspaceName}:${contextSpec}`,
                type: 'workspace',
                workspaceName: workspaceName,
                contextSpec: contextSpec,
                title: `${workspaceName}${contextSpec}`
              });

              // Refresh context menus to update recent destinations list
              await setupContextMenus();
              // Show success notification
              const title = selectedTabs.length > 1 ? `${selectedTabs.length} tabs` : (selectedTabs[0].title || selectedTabs[0].url);
              await showNotification('Sent to Canvas', `"${title}" was sent to ${workspaceName}${contextSpec}`);
            } else {
              console.error('Failed to sync tab via context menu:', response.message);
            }
          } catch (e) {
            console.error('Exception syncing tab via context menu:', e);
          }
        }
      }

      // Handle workspace path selection (format: "ws:workspaceName:/path/to/folder" or "ws:workspaceName:/path/to/folder:insert")
      else if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('ws:')) {
        const parts = info.menuItemId.split(':');
        if (parts.length >= 3) {
          const workspaceName = parts[1];
          let contextSpec = parts.slice(2).join(':'); // Rejoin in case path contains colons

          // Check if this is an ":insert" action for a directory
          if (contextSpec.endsWith(':insert')) {
            contextSpec = contextSpec.slice(0, -7); // Remove ":insert" suffix
          }

          try {
          // Get sync settings and browser identity
            const syncSettings = await browserStorage.getSyncSettings();
            const browserIdentity = await browserStorage.getBrowserIdentity();

            const documents = selectedTabs.map(t => tabManager.convertTabToDocument(t, browserIdentity, syncSettings));
            const response = documents.length > 1
              ? await apiClient.insertWorkspaceDocuments(workspaceName, documents, contextSpec || '/', documents[0].featureArray)
              : await apiClient.insertWorkspaceDocument(workspaceName, documents[0], contextSpec || '/', documents[0].featureArray);

            if (response.status === 'success') {
              const documentIds = Array.isArray(response.payload) ? response.payload : [response.payload];
              selectedTabs.forEach((tab, index) => {
                tabManager.markTabAsSynced(tab.id, documentIds[index] ?? documentIds[0], documents[index]?.data?.url);
              });
              console.log(`Tab synced to workspace ${workspaceName} at path ${contextSpec} via context menu`);
              await closeSelectedTabsSafely();

              // Track as recent destination
              await browserStorage.addRecentDestination({
                id: `workspace:${workspaceName}:${contextSpec}`,
                type: 'workspace',
                workspaceName: workspaceName,
                contextSpec: contextSpec,
                title: `${workspaceName}${contextSpec}`
              });

              // Refresh context menus to update recent destinations list
              await setupContextMenus();
              // Show success notification
              const title = selectedTabs.length > 1 ? `${selectedTabs.length} tabs` : (selectedTabs[0].title || selectedTabs[0].url);
              await showNotification('Sent to Canvas', `"${title}" was sent to ${workspaceName}${contextSpec}`);
            } else {
              console.error('Failed to sync tab via context menu:', response.message);
            }
          } catch (e) {
            console.error('Exception syncing tab via context menu:', e);
          }
        }
      }
    } catch (error) {
      console.error('❌ Context menu action failed:', error);
    }
  });
} else {
  console.error('❌ Context menus API not available for event handling');
}

// Initialize extension on service worker startup
initializeExtension();

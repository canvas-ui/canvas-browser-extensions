// Canvas Extension Popup JavaScript
// Handles popup UI interactions and communication with background service worker

// Import FuzzySearch for fuzzy search
import FuzzySearch from './fuse.js';

// SVG icon paths for action buttons
const ICON = {
  sync: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  syncTo: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><polyline points="9 14 12 11 15 14"/><line x1="12" y1="11" x2="12" y2="17"/>',
  syncClose: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'
};

function createSvgIcon(pathsStr, size = 14) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${pathsStr}</svg>`,
    'image/svg+xml'
  );
  return document.importNode(doc.documentElement, true);
}

// DOM elements
let connectionStatus, connectionText, contextId, contextUrl;
let searchInput, sendNewTabsToCanvas, openTabsAddedToCanvas, showSyncedTabs, showHiddenTabs, showAllCanvasTabs;
let browserToCanvasList, canvasToBrowserList;
let syncAllBtn, syncToAllBtn, closeAllBtn, openAllBtn, canvasPrevPageBtn, canvasNextPageBtn, settingsBtn, dockBtn, logoBtn, selectorBtn;
let browserBulkActions, canvasBulkActions;
let syncSelectedBtn, syncToSelectedBtn, syncCloseSelectedBtn, closeSelectedBtn, openSelectedBtn, removeSelectedBtn, deleteSelectedBtn;
let selectAllBrowser, selectAllCanvas;
let browserTabsHeader, canvasTabsHeader;
let toast;

// Context menu elements - REMOVED: Popup context menus don't work properly due to popup boundaries

// Tab elements
let browserToCanvasTab, canvasToBrowserTab;

// View containers and navigation
let viewContainer;

// Tree view elements
let treeBackBtn, treePathInput, pathSubmitBtn, pathCancelBtn;
let treeTitle, treeSubtitle, treeContainer;
let treeSearchInput, treeSearchClear;

// Selection view elements
let selectionBackBtn, contextsSelectionTab, workspacesSelectionTab;
let contextsList, workspacesList;

// Sync To panel elements
let syncToOverlay, syncToTree, syncToConfirmBtn, syncToPanelClose, syncToCount;

// State
let currentConnection = { connected: false, context: null, mode: 'explorer', workspace: null };
let currentWorkspacePath = '/';
let browserTabs = [];
let canvasTabs = [];
let allBrowserTabs = []; // Browser tabs available for the current Browser > Canvas filter
let rawBrowserTabs = [];
const syncedTabIds = new Set(); // Track which tabs are already synced
let showingSyncedTabs = false; // Track checkbox state
let showingHiddenTabs = false;
let showingAllCanvasTabs = false; // Track show all Canvas tabs checkbox state
let canvasPagination = { offset: 0, limit: 200, count: 0, totalCount: 0 };
const selectedBrowserTabs = new Set();
const selectedCanvasTabs = new Set();
let currentTab = 'browser-to-canvas';

let treeData = null; // Store tree data from API
let selectedPath = '/'; // Currently selected tree path
let currentSelectionTab = 'contexts'; // 'contexts' or 'workspaces'

// Sync To state
let syncToPendingTabIds = [];
const syncToSelectedPaths = new Set();

// Fuzzy search instances
let browserTabsFuse = null;
let canvasTabsFuse = null;
let currentSyncSettings = {};
let lastBrowserFuseKey = '';
let lastCanvasFuseKey = '';
const popupRequestStats = { count: 0, totalMs: 0 };

// Fuzzy search configuration
const fuseConfig = {
  keys: [
    { name: 'title', weight: 0.7 },
    { name: 'url', weight: 0.3 },
    { name: 'data.title', weight: 0.7 },
    { name: 'data.url', weight: 0.3 }
  ],
  threshold: 0.4, // More lenient threshold for better fuzzy matching
  location: 0,
  distance: 100,
  minMatchCharLength: 1,
  includeScore: true,
  includeMatches: true,
  ignoreLocation: true
};

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  document.body.dataset.host = isPopupView() ? 'popup' : 'panel';
  initializeElements();
  setupEventListeners();
  await loadInitialData();
  startSessionInfoPolling();
});

function isPopupView() {
  try {
    const ext = (typeof browser !== 'undefined' && browser.extension) ? browser.extension : chrome.extension;
    if (ext?.getViews) {
      const popups = ext.getViews({ type: 'popup' });
      return Array.isArray(popups) && popups.includes(window);
    }
  } catch {
    // ignore
  }

  // Fallback: our popup is fixed-size; side panel/sidebar typically isn't.
  return window.innerWidth <= 520 && window.innerHeight <= 720;
}

function closePopupIfPossible() {
  if (isPopupView()) window.close();
}

// Listen for messages from service worker (cross-browser compatible)
const runtime = (typeof browser !== 'undefined') ? browser.runtime : chrome.runtime;
runtime.onMessage.addListener((message) => {
  console.log('Popup received message:', message);

  // Handle background events from service worker
  if (message.type === 'BACKGROUND_EVENT') {
    switch (message.eventType) {
    case 'settings.saved':
      console.log('Refreshing popup after settings save');
      loadInitialData();
      break;

    case 'tabs.refresh':
      console.log('Refreshing tabs due to context change');
      loadTabs();
      break;

    case 'context.changed':
      console.log('Context changed:', message.data);
      // Update context display
      if (message.data.contextId && message.data.url) {
        // Update current connection and refresh display properly
        if (currentConnection.context) {
          currentConnection.context.id = message.data.contextId;
          currentConnection.context.url = message.data.url;
        }
        // Refresh the entire status display to ensure proper formatting
        updateConnectionStatus(currentConnection);
      }
      break;

    case 'context.url.set':
      console.log('Context URL set:', message.data);
      // Update context display when URL changes via CLI
      if (message.data.contextId && message.data.url) {
        // Update current connection and refresh display properly
        if (currentConnection.context && currentConnection.context.id === message.data.contextId) {
          currentConnection.context.url = message.data.url;
        }
        // Refresh the entire status display to ensure proper formatting
        updateConnectionStatus(currentConnection);
      }
      // Refresh tabs to show updated context
      loadTabs();
      break;

    case 'websocket.context.joined':
      console.log('Joined context:', message.data);
      break;

    case 'auth.session.expired':
      console.warn('Session expired — prompting user to reconnect');
      currentConnection.connected = false;
      updateConnectionStatus(currentConnection);
      showSessionExpiredBanner();
      break;

    case 'auth.session.renewed':
      console.log('Session token renewed automatically');
      currentConnection.connected = true;
      removeSessionExpiredBanner();
      updateConnectionStatus(currentConnection);
      refreshSessionInfo();
      break;

    default:
      console.log('Unknown background event:', message.eventType, message.data);
    }
    return;
  }

  // Handle direct message types (legacy)
  switch (message.type) {
  case 'settings.saved':
    console.log('Refreshing popup after settings save');
    loadInitialData();
    break;

  case 'tabs.refresh':
    console.log('Refreshing tabs due to context change');
    loadTabs();
    break;

  case 'context.changed':
    console.log('Context changed:', message.data);
    // Update context display
    if (message.data.contextId && message.data.url) {
      // Update current connection and refresh display properly
      if (currentConnection.context) {
        currentConnection.context.id = message.data.contextId;
        currentConnection.context.url = message.data.url;
      }
      // Refresh the entire status display to ensure proper formatting
      updateConnectionStatus(currentConnection);
    }
    break;

  case 'context.url.set':
    console.log('Context URL set:', message.data);
    // Update context display when URL changes via CLI
    if (message.data.contextId && message.data.url) {
      // Update current connection and refresh display properly
      if (currentConnection.context && currentConnection.context.id === message.data.contextId) {
        currentConnection.context.url = message.data.url;
      }
      // Refresh the entire status display to ensure proper formatting
      updateConnectionStatus(currentConnection);
    }
    // Refresh tabs to show updated context
    loadTabs();
    break;

  case 'websocket.context.joined':
    console.log('Joined context:', message.data);
    break;

  default:
    console.log('Unknown message type:', message.type, message.data);
  }
});

function initializeElements() {
  // View containers
  viewContainer = document.getElementById('viewContainer');

  // Header elements
  connectionStatus = document.getElementById('connectionStatus');
  connectionText = document.getElementById('connectionText');
  contextId = document.getElementById('contextId');
  contextUrl = document.getElementById('contextUrl');
  logoBtn = document.getElementById('logoBtn');

  // Search and settings
  searchInput = document.getElementById('searchInput');
  sendNewTabsToCanvas = document.getElementById('sendNewTabsToCanvas');
  openTabsAddedToCanvas = document.getElementById('openTabsAddedToCanvas');
  showSyncedTabs = document.getElementById('showSyncedTabs');
  showHiddenTabs = document.getElementById('showHiddenTabs');
  showAllCanvasTabs = document.getElementById('showAllCanvasTabs');
  selectorBtn = document.getElementById('selectorBtn');
  settingsBtn = document.getElementById('settingsBtn');
  dockBtn = document.getElementById('dockBtn');
  if (dockBtn && !isPopupView()) dockBtn.style.display = 'none';

  // Tab navigation
  browserToCanvasTab = document.getElementById('browserToCanvasTab');
  canvasToBrowserTab = document.getElementById('canvasToBrowserTab');

  // Tab lists
  browserToCanvasList = document.getElementById('browserToCanvasList');
  canvasToBrowserList = document.getElementById('canvasToBrowserList');

  // Action buttons
  syncAllBtn = document.getElementById('syncAllBtn');
  syncToAllBtn = document.getElementById('syncToAllBtn');
  closeAllBtn = document.getElementById('closeAllBtn');
  openAllBtn = document.getElementById('openAllBtn');
  canvasPrevPageBtn = document.getElementById('canvasPrevPageBtn');
  canvasNextPageBtn = document.getElementById('canvasNextPageBtn');

  // Bulk actions
  browserBulkActions = document.getElementById('browserBulkActions');
  canvasBulkActions = document.getElementById('canvasBulkActions');
  syncSelectedBtn = document.getElementById('syncSelectedBtn');
  syncToSelectedBtn = document.getElementById('syncToSelectedBtn');
  syncCloseSelectedBtn = document.getElementById('syncCloseSelectedBtn');
  closeSelectedBtn = document.getElementById('closeSelectedBtn');
  openSelectedBtn = document.getElementById('openSelectedBtn');
  removeSelectedBtn = document.getElementById('removeSelectedBtn');
  deleteSelectedBtn = document.getElementById('deleteSelectedBtn');

  // Select all checkboxes
  selectAllBrowser = document.getElementById('selectAllBrowser');
  selectAllCanvas = document.getElementById('selectAllCanvas');

  // Tab count headers
  browserTabsHeader = document.getElementById('browserTabsHeader');
  canvasTabsHeader = document.getElementById('canvasTabsHeader');

  // Tree view elements
  treeBackBtn = document.getElementById('treeBackBtn');
  treePathInput = document.getElementById('treePathInput');
  pathSubmitBtn = document.getElementById('pathSubmitBtn');
  pathCancelBtn = document.getElementById('pathCancelBtn');
  treeTitle = document.getElementById('treeTitle');
  treeSubtitle = document.getElementById('treeSubtitle');
  treeContainer = document.getElementById('treeContainer');
  treeSearchInput = document.getElementById('treeSearchInput');
  treeSearchClear = document.getElementById('treeSearchClear');

  // Selection view elements
  selectionBackBtn = document.getElementById('selectionBackBtn');
  contextsSelectionTab = document.getElementById('contextsSelectionTab');
  workspacesSelectionTab = document.getElementById('workspacesSelectionTab');
  contextsList = document.getElementById('contextsList');
  workspacesList = document.getElementById('workspacesList');

  // Sync To panel elements
  syncToOverlay = document.getElementById('syncToOverlay');
  syncToTree = document.getElementById('syncToTree');
  syncToConfirmBtn = document.getElementById('syncToConfirmBtn');
  syncToPanelClose = document.getElementById('syncToPanelClose');
  syncToCount = document.getElementById('syncToCount');

  toast = document.getElementById('toast');
}

function setupEventListeners() {
  // Logo click - open Canvas server webui
  logoBtn.addEventListener('click', openCanvasWebUI);

  // Selector button - navigate to selection view
  selectorBtn.addEventListener('click', () => navigateToView('selection'));

  // Settings button
  settingsBtn.addEventListener('click', openSettingsPage);
  dockBtn?.addEventListener('click', handleDockClick);

  // Context URL click - navigate to tree view
  contextUrl.addEventListener('click', handleContextUrlClick);

  // Tree view navigation
  treeBackBtn.addEventListener('click', () => navigateToView('main'));
  pathSubmitBtn.addEventListener('click', handlePathSubmit);
  pathCancelBtn.addEventListener('click', () => navigateToView('main'));
  treePathInput.addEventListener('keydown', handleTreePathKeydown);
  treeSearchInput.addEventListener('input', () => {
    const query = treeSearchInput.value.trim();
    treeSearchClear.style.display = query ? 'inline-flex' : 'none';
    filterTreeView(query);
  });
  treeSearchClear.addEventListener('click', clearTreeSearch);

  // Selection view navigation
  selectionBackBtn.addEventListener('click', handleSelectionBackClick);
  contextsSelectionTab.addEventListener('click', () => switchSelectionTab('contexts'));
  workspacesSelectionTab.addEventListener('click', () => switchSelectionTab('workspaces'));

  // Tab navigation
  browserToCanvasTab.addEventListener('click', () => switchTab('browser-to-canvas'));
  canvasToBrowserTab.addEventListener('click', () => switchTab('canvas-to-browser'));

  // Search
  searchInput.addEventListener('input', handleSearch);

  // Sync settings toggles
  sendNewTabsToCanvas.addEventListener('change', handleSyncSettingChange);
  openTabsAddedToCanvas.addEventListener('change', handleSyncSettingChange);
  showSyncedTabs.addEventListener('change', handleShowSyncedChange);
  showHiddenTabs.addEventListener('change', handleShowHiddenChange);
  showAllCanvasTabs.addEventListener('change', handleShowAllCanvasChange);
  canvasPrevPageBtn.addEventListener('click', () => void loadCanvasPage(canvasPagination.offset - canvasPagination.limit));
  canvasNextPageBtn.addEventListener('click', () => void loadCanvasPage(canvasPagination.offset + canvasPagination.limit));

  // Action buttons
  syncAllBtn.addEventListener('click', () => handleSyncAll());
  syncToAllBtn.addEventListener('click', () => handleSyncToAll());
  closeAllBtn.addEventListener('click', () => handleCloseAll());
  openAllBtn.addEventListener('click', () => handleOpenAll());

  // Bulk actions
  syncSelectedBtn.addEventListener('click', () => handleSyncSelected());
  syncToSelectedBtn.addEventListener('click', () => handleSyncToSelected());
  syncCloseSelectedBtn.addEventListener('click', () => handleSyncAndCloseSelected());
  closeSelectedBtn.addEventListener('click', () => handleCloseSelected());

  // Sync To panel
  syncToPanelClose.addEventListener('click', () => closeSyncToPanel());
  syncToConfirmBtn.addEventListener('click', () => handleSyncToConfirm());
  openSelectedBtn.addEventListener('click', () => handleOpenSelected());
  removeSelectedBtn.addEventListener('click', () => handleRemoveSelected());
  deleteSelectedBtn.addEventListener('click', () => handleDeleteSelected());

  // Select all checkboxes
  selectAllBrowser.addEventListener('change', handleSelectAllBrowser);
  selectAllCanvas.addEventListener('change', handleSelectAllCanvas);

  // Event delegation for browser tab actions
  browserToCanvasList.addEventListener('click', handleBrowserTabAction);

  // Event delegation for Canvas tab actions
  canvasToBrowserList.addEventListener('click', handleCanvasTabAction);

  // Event delegation for selection actions
  contextsList.addEventListener('click', handleSelectionActionClick);
  workspacesList.addEventListener('click', handleSelectionActionClick);

  // Event delegation for checkboxes
  browserToCanvasList.addEventListener('change', handleBrowserTabCheckbox);
  canvasToBrowserList.addEventListener('change', handleCanvasTabCheckbox);

  // Event delegation for favicon error handling
  browserToCanvasList.addEventListener('error', handleImageError, true);
  canvasToBrowserList.addEventListener('error', handleImageError, true);

  // Context menu event listeners - REMOVED
}

// Tab switching functionality
function switchTab(tabName) {
  console.log('Switching to tab:', tabName);

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });

  // Update tab content
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.remove('active');
  });

  // Activate selected tab
  const targetTab = document.querySelector(`[data-tab="${tabName}"]`);
  const targetContent = document.getElementById(tabName);

  if (targetTab && targetContent) {
    targetTab.classList.add('active');
    targetContent.classList.add('active');
    currentTab = tabName;

    // Clear selections when switching tabs
    clearSelections();

    // Apply search filter to current tab if there's a search query
    if (searchInput.value.trim()) {
      handleSearch({ target: { value: searchInput.value } });
    }
  }
}

function clearSelections() {
  selectedBrowserTabs.clear();
  selectedCanvasTabs.clear();
  browserBulkActions.style.display = 'none';
  canvasBulkActions.style.display = 'none';

  // Uncheck all checkboxes
  document.querySelectorAll('.tab-checkbox input[type="checkbox"]').forEach(checkbox => {
    checkbox.checked = false;
  });
}

async function loadInitialData() {
  try {
    console.log('Loading initial data...');

    // Get connection status
    const response = await sendMessageToBackground('GET_CONNECTION_STATUS');
    console.log('Connection status response:', response);

    currentConnection = response;
    if (currentConnection.mode === 'explorer' && typeof response.workspacePath === 'string') {
      currentWorkspacePath = response.workspacePath || '/';
    }

    // If in context mode but missing workspace info, try to load it
    if (currentConnection.mode === 'context' && currentConnection.context &&
        !currentConnection.context.workspaceName && !currentConnection.context.workspace &&
        !currentConnection.workspace) {
      console.log('Context mode detected but missing workspace info, attempting to load...');
      try {
        const workspacesResponse = await sendMessageToBackground('GET_WORKSPACES');
        if (workspacesResponse.success && workspacesResponse.workspaces && workspacesResponse.workspaces.length > 0) {
          // Prefer "universe" workspace if available, otherwise use first workspace
          let workspace = workspacesResponse.workspaces.find(ws => ws.name === 'universe');
          if (!workspace) {
            workspace = workspacesResponse.workspaces[0];
          }
          currentConnection.workspace = workspace;
          console.log('Added workspace info to current connection (preferred universe):', currentConnection.workspace);
        }
      } catch (error) {
        console.warn('Could not load workspace information on popup init:', error);
      }
    }

    updateConnectionStatus(currentConnection);

    // Initialize checkbox states to ensure proper defaults
    showSyncedTabs.checked = false; // Default to showing only unsynced tabs
    showingSyncedTabs = false;
    showHiddenTabs.checked = false;
    showingHiddenTabs = false;

    // Initialize section header based on checkbox state
    const sectionHeader = document.querySelector('#browser-to-canvas .section-header h3');
    if (sectionHeader) {
      sectionHeader.textContent = showingSyncedTabs ? 'Browser Tabs' : 'Unsynced Browser Tabs';
    }

    // Initialize Canvas section header based on checkbox state
    showingAllCanvasTabs = showAllCanvasTabs?.checked || false;

    // Load sync settings
    await loadSyncSettings();

    // Load tabs if connected (or always load for debugging)
    console.log('Loading tabs...');
    await loadTabs();
  } catch (error) {
    console.error('Failed to load initial data:', error);
  }
}

function updateConnectionStatus(connection) {
  console.log('Popup: Updating connection status with:', connection);

  if (connection.connected) {
    console.log('Popup: Setting status to CONNECTED');
    connectionStatus.className = 'status-dot connected';
    const expiredBanner = document.getElementById('session-expired-banner');
    if (expiredBanner) expiredBanner.remove();

    // Show user info if available
    if (connection.user && connection.user.name) {
      // Extract server URL without protocol
      let displayServerUrl = '';
      if (connection.settings && connection.settings.serverUrl) {
        try {
          const url = new URL(connection.settings.serverUrl);
          displayServerUrl = url.hostname + (url.port ? ':' + url.port : '');
        } catch {
          // If URL parsing fails, use the original value
          displayServerUrl = connection.settings.serverUrl.replace(/^https?:\/\//, '');
        }
      }

      connectionText.innerHTML = `Connected <span style="color: #71717a;">(${escapeHtml(connection.user.name)}@${escapeHtml(displayServerUrl)})</span>`;
    } else {
      connectionText.textContent = 'Connected';
    }

    // Context mode header
    if ((connection.mode === 'context') && connection.context) {
      console.log('Popup: Context mode, context:', connection.context);
      console.log('Popup: Context mode, workspace info:', connection.workspace);

      // Create green dot indicator for bound state
      contextId.textContent = '';
      const boundIndicator = createSecureElement('span', {
        className: 'status-dot connected',
        style: 'margin-right: 6px;'
      });
      contextId.appendChild(boundIndicator);
      contextId.appendChild(document.createTextNode(`Bound to context ID: ${escapeHtml(connection.context.id)}`));

      // Get workspace name from context or use fallback
      const workspaceName = connection.context.workspaceName || connection.context.workspace ||
                           (connection.workspace ? getWorkspaceName(connection.workspace) : null);
      const contextPath = connection.context.url || '/';

      console.log('Popup: Resolved workspace name:', workspaceName, 'context path:', contextPath);

      // Format URL as workspace.name://path
      if (workspaceName) {
        contextUrl.textContent = formatContextUrl(workspaceName, contextPath);
      } else {
        contextUrl.textContent = contextPath;
      }
      contextUrl.classList.add('clickable');
    // Explorer mode header
    } else if ((connection.mode === 'explorer') && connection.workspace) {
      const wsName = getWorkspaceName(connection.workspace);
      console.log('Popup: Explorer mode, workspace:', wsName);

      // Create gray dot indicator for unbound state (explorer mode is not bound - no dynamic updates)
      contextId.textContent = '';
      const unboundIndicator = createSecureElement('span', {
        className: 'status-dot unbound',
        style: 'margin-right: 6px;'
      });
      contextId.appendChild(unboundIndicator);
      contextId.appendChild(document.createTextNode(`Workspace: ${escapeHtml(wsName)}`));

      // Format URL as workspace.name://path
      const workspacePath = currentWorkspacePath || '/';
      contextUrl.textContent = formatContextUrl(wsName, workspacePath);
      contextUrl.classList.add('clickable');
    } else {
      console.log('Popup: No context or workspace selected');

      // Create gray button indicator for unbound state
      contextId.textContent = '';
      const unboundIndicator = createSecureElement('span', {
        className: 'status-dot unbound',
        style: 'margin-right: 6px;'
      });
      contextId.appendChild(unboundIndicator);
      contextId.appendChild(document.createTextNode('-'));
      contextUrl.textContent = 'Not bound';
      contextUrl.classList.remove('clickable');
    }
  } else {
    console.log('Popup: Setting status to DISCONNECTED');
    connectionStatus.className = 'status-dot disconnected';
    connectionText.textContent = 'Disconnected';

    // Create gray button indicator for unbound state when disconnected
    contextId.textContent = '';
    const unboundIndicator = createSecureElement('span', {
      className: 'status-dot unbound',
      style: 'margin-right: 6px;'
    });
    contextId.appendChild(unboundIndicator);
    contextId.appendChild(document.createTextNode('-'));
    contextUrl.textContent = 'No context';
    contextUrl.classList.remove('clickable');
  }
}

// Filter out internal browser tabs that should never be shown or interacted with
function isInternalTab(tab) {
  if (!tab || !tab.url) return true;

  const excludedProtocols = [
    'chrome://',
    'chrome-extension://',
    'chrome-search://',
    'chrome-devtools://',
    'moz-extension://',
    'edge://',
    'opera://',
    'brave://',
    'about:',
    'file://',
    'data:',
    'blob:',
    'javascript:',
    'view-source:',
    'wyciwyg://',
    'resource://'
  ];

  const excludedUrls = [
    'chrome://newtab/',
    'chrome://new-tab-page/',
    'about:newtab',
    'about:blank',
    'edge://newtab/',
    'opera://startpage/'
  ];

  // Check protocols
  for (const protocol of excludedProtocols) {
    if (tab.url.startsWith(protocol)) {
      console.log(`🚫 Filtering internal tab (${protocol}): ${tab.title}`);
      return true;
    }
  }

  // Check specific URLs
  for (const url of excludedUrls) {
    if (tab.url === url) {
      console.log(`🚫 Filtering internal tab (${url}): ${tab.title}`);
      return true;
    }
  }

  return false;
}

async function loadTabs() {
  const startedAt = performance.now();
  const requestCountBefore = popupRequestStats.count;
  try {
    console.log('Loading tabs...');

    const [allTabsResponse, docsResponse] = await Promise.all([
      sendMessageToBackground('GET_ALL_TABS'),
      fetchCurrentDocumentList()
    ]);
    applyCanvasDocumentResponse(docsResponse);

    if (allTabsResponse.success) {
      rawBrowserTabs = allTabsResponse.tabs || [];

      // Hidden/discarded tabs are managed state, not active Browser > Canvas sync candidates.
      refreshBrowserTabFilter();
      const discardedCount = rawBrowserTabs.filter(tab => tab.discarded).length;
      const hiddenCount = rawBrowserTabs.filter(tab => !tab.discarded && tab.hidden).length;
      const stashedCount = rawBrowserTabs.filter(tab => !tab.discarded && !tab.hidden && tab.stashed).length;
      const internalCount = rawBrowserTabs.filter(tab => !tab.discarded && !tab.hidden && !tab.stashed && isInternalTab(tab)).length;

      console.log(`All browser tabs loaded: ${allBrowserTabs.length} usable, ${discardedCount} discarded, ${hiddenCount} hidden, ${stashedCount} stashed, ${internalCount} internal (filtered out)`);

      markSyncedBrowserTabs(canvasTabs);

      // Load pin state for all tabs
      await loadPinStates();

      // Filter tabs based on showSyncedTabs setting
      updateBrowserTabsFilter();
      renderBrowserTabs();
    } else {
      console.error('Failed to get browser tabs:', allTabsResponse.error);
    }

    if (docsResponse?.success) {
      console.log('Canvas documents loaded:', canvasTabs.length, canvasPagination);
      renderCanvasTabs();
    } else if (currentConnection.connected) {
      console.error('Failed to get Canvas documents:', docsResponse?.error);
      canvasTabs = [];
      renderCanvasTabs();
    } else {
      console.log('Not connected - skipping documents');
      canvasTabs = [];
      renderCanvasTabs();
    }

    // Initialize fuzzy search instances with the loaded data
    initializeFuseInstances();

    // If there's an active search, re-apply it with the new data
    if (searchInput && searchInput.value.trim()) {
      handleSearch({ target: { value: searchInput.value } });
    }
  } catch (error) {
    console.error('Failed to load tabs:', error);
  } finally {
    const durationMs = Math.round(performance.now() - startedAt);
    const requestCount = popupRequestStats.count - requestCountBefore;
    console.info(`Popup Timing: loadTabs ${durationMs}ms (${requestCount} background request${requestCount === 1 ? '' : 's'})`);
  }
}

async function fetchCurrentDocumentList() {
  if (!currentConnection.connected) {
    return { success: true, documents: [] };
  }

  const request = {
    limit: canvasPagination.limit,
    offset: canvasPagination.offset
  };

  if (currentConnection.mode === 'context' && currentConnection.context) {
    return await sendMessageToBackground('GET_CANVAS_DOCUMENTS', request);
  }

  if (currentConnection.mode === 'explorer' && currentConnection.workspace) {
    return await sendMessageToBackground('GET_WORKSPACE_DOCUMENTS', { ...request, contextSpec: currentWorkspacePath || '/' });
  }

  return { success: true, documents: [] };
}

function applyCanvasDocumentResponse(response) {
  if (!response?.success) return;
  canvasTabs = response.documents || [];
  canvasPagination = {
    ...canvasPagination,
    count: response.count ?? canvasTabs.length,
    totalCount: response.totalCount ?? canvasTabs.length,
    offset: response.offset ?? canvasPagination.offset,
    limit: response.limit ?? canvasPagination.limit
  };
  updateCanvasPaginationButtons();
}

function updateCanvasPaginationButtons() {
  if (canvasPrevPageBtn) canvasPrevPageBtn.disabled = canvasPagination.offset <= 0;
  if (canvasNextPageBtn) {
    const nextOffset = canvasPagination.offset + canvasPagination.count;
    canvasNextPageBtn.disabled = canvasPagination.totalCount <= 0 || nextOffset >= canvasPagination.totalCount;
  }
}

function normalizeCanvasFetchLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) return 200;
  return Math.min(1000, Math.max(1, Math.floor(limit)));
}

async function loadCanvasPage(offset) {
  canvasPagination.offset = Math.max(0, offset);
  selectedCanvasTabs.clear();
  const response = await fetchCurrentDocumentList();
  applyCanvasDocumentResponse(response);
  if (!response.success) {
    showToast(`Failed to load Canvas tabs: ${response.error}`, 'error');
  }
  renderCanvasTabs();
  initializeFuseInstances();
  updateTabCountHeaders();
}

function markSyncedBrowserTabs(documents) {
  const syncedUrls = new Set(
    (documents || [])
      .map(doc => normalizeTabUrl(doc.data?.url))
      .filter(Boolean)
  );

  syncedTabIds.clear();
  allBrowserTabs.forEach(tab => {
    if (syncedUrls.has(normalizeTabUrl(tab.url))) {
      syncedTabIds.add(tab.id);
    }
  });

  console.log('Synced tab IDs:', Array.from(syncedTabIds));
}

function refreshBrowserTabFilter() {
  allBrowserTabs = rawBrowserTabs.filter(tab => {
    if (isInternalTab(tab)) return false;
    if (showingHiddenTabs) return true;
    return tab.discarded !== true && tab.hidden !== true && tab.stashed !== true;
  });
}

function applyOpenedCanvasDocuments(response, documents = []) {
  const results = Array.isArray(response?.results)
    ? response.results.map(item => item.result)
    : [response];

  results.forEach((result, index) => {
    const tab = result?.tab;
    const document = documents[index] || result?.document;
    if (!tab?.id) return;

    const existingIndex = allBrowserTabs.findIndex(item => item.id === tab.id);
    if (existingIndex >= 0) {
      allBrowserTabs[existingIndex] = { ...allBrowserTabs[existingIndex], ...tab };
    } else {
      allBrowserTabs.push(tab);
    }
    const rawIndex = rawBrowserTabs.findIndex(item => item.id === tab.id);
    if (rawIndex >= 0) {
      rawBrowserTabs[rawIndex] = { ...rawBrowserTabs[rawIndex], ...tab };
    } else {
      rawBrowserTabs.push(tab);
    }
    if (document?.id) syncedTabIds.add(tab.id);
  });

  updateBrowserTabsFilter();
  renderBrowserTabs();
  renderCanvasTabs();
  initializeFuseInstances();
}

function applyRemovedCanvasDocuments(documentIds) {
  const ids = new Set(documentIds.map(String));
  canvasTabs = canvasTabs.filter(doc => !ids.has(String(doc.id)));
  selectedCanvasTabs.forEach(id => {
    if (ids.has(String(id))) selectedCanvasTabs.delete(id);
  });
  renderCanvasTabs();
  initializeFuseInstances();
}

function applyClosedBrowserTabs(tabIds) {
  const ids = new Set(tabIds.map(Number));
  allBrowserTabs = allBrowserTabs.filter(tab => !ids.has(tab.id));
  tabIds.forEach(tabId => {
    syncedTabIds.delete(tabId);
    selectedBrowserTabs.delete(tabId);
  });
  updateBrowserTabsFilter();
  renderBrowserTabs();
  renderCanvasTabs();
  initializeFuseInstances();
}

async function loadPinStates() {
  try {
    console.log('Loading pin states for tabs...');
    const pinResponse = await sendMessageToBackground('GET_PINNED_TABS');

    if (pinResponse.success) {
      const pinnedUrls = new Set(pinResponse.pinnedTabs || []);
      console.log('Pinned tab URLs:', Array.from(pinnedUrls));

      // Add pin state to each tab
      allBrowserTabs.forEach(tab => {
        tab.isPinned = pinnedUrls.has(tab.url);
      });
    } else {
      console.error('Failed to get pinned tabs:', pinResponse.error);
      // Default to not pinned for all tabs
      allBrowserTabs.forEach(tab => {
        tab.isPinned = false;
      });
    }
  } catch (error) {
    console.error('Failed to load pin states:', error);
    // Default to not pinned for all tabs
    allBrowserTabs.forEach(tab => {
      tab.isPinned = false;
    });
  }
}

function updateBrowserTabsFilter() {
  if (showingSyncedTabs) {
    // Show all tabs (both synced and unsynced)
    browserTabs = [...allBrowserTabs];
    console.log(`Browser tabs filter: Showing ALL tabs (${browserTabs.length} total)`);
  } else {
    // Show only unsynced tabs
    browserTabs = allBrowserTabs.filter(tab => !syncedTabIds.has(tab.id));
    const syncedCount = allBrowserTabs.length - browserTabs.length;
    console.log(`Browser tabs filter: Showing UNSYNCED only (${browserTabs.length} unsynced, ${syncedCount} synced hidden)`);
  }
}

function getFilteredCanvasTabs() {
  if (showingAllCanvasTabs) {
    // Show all Canvas tabs
    return canvasTabs;
  } else {
    // Show only Canvas tabs that are NOT already open in browser
    const openUrls = new Set(allBrowserTabs.map(tab => normalizeTabUrl(tab.url)));
    const filteredTabs = canvasTabs.filter(doc => {
      const url = doc.data?.url;
      return url && !openUrls.has(normalizeTabUrl(url));
    });
    console.log(`Filtered Canvas tabs: ${filteredTabs.length} of ${canvasTabs.length} total (hiding tabs already open in browser)`);
    return filteredTabs;
  }
}

async function loadSyncSettings() {
  try {
    console.log('Loading sync settings from background...');

    // Get sync settings from background service worker
    const response = await sendMessageToBackground('GET_SYNC_SETTINGS');
    console.log('Loaded sync settings:', response);

    if (response.success) {
      const settings = response.settings;
      currentSyncSettings = settings || {};

      // Update checkbox states to match saved settings
      sendNewTabsToCanvas.checked = settings.sendNewTabsToCanvas || false;
      openTabsAddedToCanvas.checked = settings.openTabsAddedToCanvas || false;
      canvasPagination.limit = normalizeCanvasFetchLimit(settings.canvasTabsFetchLimit);
      canvasPagination.offset = 0;

      console.log('Applied sync settings to UI:', {
        sendNewTabsToCanvas: sendNewTabsToCanvas.checked,
        openTabsAddedToCanvas: openTabsAddedToCanvas.checked,
        canvasTabsFetchLimit: canvasPagination.limit
      });
    } else {
      console.warn('Failed to load sync settings:', response.error);
      // Set defaults
      sendNewTabsToCanvas.checked = false;
      openTabsAddedToCanvas.checked = false;
    }
  } catch (error) {
    console.error('Failed to load sync settings:', error);
    // Set defaults on error
    sendNewTabsToCanvas.checked = false;
    openTabsAddedToCanvas.checked = false;
  }
}

function updateTabCountHeaders() {
  const searchQuery = searchInput?.value?.trim();
  const isSearching = searchQuery && searchQuery.length > 0;

  // Update browser tabs header
  if (isSearching) {
    const visibleBrowserTabs = browserToCanvasList.querySelectorAll('.tab-item:not([style*="display: none"])').length;
    const totalBrowserTabs = browserTabs.length;
    const headerText = showingSyncedTabs ? 'Browser Tabs' : 'Unsynced Browser Tabs';
    browserTabsHeader.textContent = `${headerText} (${visibleBrowserTabs}/${totalBrowserTabs})`;
  } else {
    const headerText = showingSyncedTabs ? 'Browser Tabs' : 'Unsynced Browser Tabs';
    browserTabsHeader.textContent = `${headerText} (${browserTabs.length})`;
  }

  // Update canvas tabs header
  const filteredCanvasTabs = getFilteredCanvasTabs();
  const totalCount = canvasPagination.totalCount || filteredCanvasTabs.length;
  const fetchedCount = canvasPagination.count || canvasTabs.length;
  const pageCount = `${fetchedCount}/${totalCount}`;
  if (isSearching) {
    const visibleCanvasTabs = canvasToBrowserList.querySelectorAll('.tab-item:not([style*="display: none"])').length;
    const totalCanvasTabs = filteredCanvasTabs.length;
    canvasTabsHeader.textContent = `Canvas Context Tabs (${visibleCanvasTabs}/${totalCanvasTabs}, fetched ${pageCount})`;
  } else {
    canvasTabsHeader.textContent = `Canvas Context Tabs (${filteredCanvasTabs.length}, fetched ${pageCount})`;
  }
  updateCanvasPaginationButtons();
}

function updateWindowGroupVisibility() {
  const groups = browserToCanvasList.querySelectorAll('.window-group');
  groups.forEach(group => {
    const items = group.querySelectorAll('.tab-item');
    const anyVisible = Array.from(items).some(item => item.style.display !== 'none');
    group.style.display = anyVisible ? 'block' : 'none';
  });
}

function groupBrowserTabsByWindow(tabs) {
  const byWindow = new Map();
  for (const tab of tabs) {
    const windowId = Number.isInteger(tab.windowId) ? tab.windowId : -1;
    const list = byWindow.get(windowId) || [];
    list.push(tab);
    byWindow.set(windowId, list);
  }

  const groups = [];
  for (const [windowId, windowTabs] of byWindow.entries()) {
    groups.push({ windowId, tabs: windowTabs });
  }
  return groups;
}

function getUnsyncedTabIdsForWindow(windowId) {
  return allBrowserTabs
    .filter(tab => tab.windowId === windowId && !syncedTabIds.has(tab.id))
    .map(tab => tab.id);
}

function renderBrowserTabs() {
  console.log('Rendering browser tabs, count:', browserTabs.length);

  if (browserTabs.length === 0) {
    const emptyDiv = createSecureElement('div', { className: 'empty-state' });
    if (showingSyncedTabs) {
      emptyDiv.textContent = 'No browser tabs found';
    } else {
      emptyDiv.appendChild(document.createTextNode('All tabs are already synced!'));
      emptyDiv.appendChild(document.createElement('br'));
      const smallText = createSecureElement('small', {}, 'Check "Show Synced" to see all tabs');
      emptyDiv.appendChild(smallText);
    }
    browserToCanvasList.textContent = '';
    browserToCanvasList.appendChild(emptyDiv);
    updateTabCountHeaders();
    return;
  }

  // Clear existing content
  browserToCanvasList.textContent = '';

  const groups = groupBrowserTabsByWindow(browserTabs);
  groups.sort((a, b) => {
    const aActive = a.tabs.some(t => t.active);
    const bActive = b.tabs.some(t => t.active);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return a.windowId - b.windowId;
  });

  for (const group of groups) {
    const { windowId } = group;
    const windowUnsyncedIds = getUnsyncedTabIdsForWindow(windowId);
    const canSync = currentConnection.connected && windowUnsyncedIds.length > 0;
    const isActiveWindow = group.tabs.some(t => t.active);

    const groupElement = createSecureElement('div', {
      className: 'window-group',
      'data-window-id': windowId
    });

    const groupHeader = createSecureElement('div', { className: 'window-group-header' });
    const titleText = `Window ${windowId}${isActiveWindow ? ' (current)' : ''} · ${windowUnsyncedIds.length} unsynced`;
    const groupTitle = createSecureElement('div', { className: 'window-group-title' }, titleText);

    const groupActions = createSecureElement('div', { className: 'window-group-actions' });

    const syncWindowBtn = createSecureElement('button', {
      className: 'action-btn icon-btn small secondary',
      'data-action': 'sync-window',
      'data-window-id': windowId,
      title: 'Sync all unsynced tabs in this window'
    });
    syncWindowBtn.appendChild(createSvgIcon(ICON.sync, 12));
    syncWindowBtn.disabled = !canSync;

    const syncToWindowBtn = createSecureElement('button', {
      className: 'action-btn icon-btn small primary',
      'data-action': 'sync-to-window',
      'data-window-id': windowId,
      title: 'Sync window tabs to specific paths...'
    });
    syncToWindowBtn.appendChild(createSvgIcon(ICON.syncTo, 12));
    syncToWindowBtn.disabled = !canSync;

    const syncCloseWindowBtn = createSecureElement('button', {
      className: 'action-btn icon-btn small warning',
      'data-action': 'sync-close-window',
      'data-window-id': windowId,
      title: 'Sync and close all unsynced tabs in this window'
    });
    syncCloseWindowBtn.appendChild(createSvgIcon(ICON.syncClose, 12));
    syncCloseWindowBtn.disabled = !canSync;

    const closeWindowBtn = createSecureElement('button', {
      className: 'action-btn icon-btn small danger',
      'data-action': 'close-window',
      'data-window-id': windowId,
      title: 'Close this window'
    });
    closeWindowBtn.appendChild(createSvgIcon(ICON.close, 12));

    groupActions.appendChild(syncWindowBtn);
    groupActions.appendChild(syncToWindowBtn);
    groupActions.appendChild(syncCloseWindowBtn);
    groupActions.appendChild(closeWindowBtn);

    groupHeader.appendChild(groupTitle);
    groupHeader.appendChild(groupActions);

    const groupList = createSecureElement('div', { className: 'window-group-list' });

    // Create tabs using secure DOM methods
    group.tabs.forEach(tab => {
      const isSynced = syncedTabIds.has(tab.id);
      const tabClass = isSynced ? 'tab-item synced' : 'tab-item';
      const isPinned = tab.isPinned || false;

      // Create tab element
      const tabElement = createSecureElement('div', {
        className: tabClass,
        'data-tab-id': tab.id
      });

      // Create checkbox label
      const checkboxLabel = createSecureElement('label', { className: 'tab-checkbox' });
      const checkbox = createSecureElement('input', {
        type: 'checkbox',
        'data-tab-id': tab.id
      });

      // Preserve selection state
      if (selectedBrowserTabs.has(tab.id)) {
        checkbox.checked = true;
      }

      const checkmark = createSecureElement('span', { className: 'checkmark' });
      checkboxLabel.appendChild(checkbox);
      checkboxLabel.appendChild(checkmark);

      // Create favicon
      const faviconImg = createSecureElement('img', {
        src: tab.favIconUrl || '../assets/icons/logo-br_64x64.png',
        className: 'tab-favicon',
        'data-fallback': '../assets/icons/logo-br_64x64.png'
      });

      // Create tab info
      const tabInfo = createSecureElement('div', { className: 'tab-info' });
      const tabTitle = createSecureElement('div', { className: 'tab-title' }, escapeHtml(tab.title));
      const tabUrl = createSecureElement('div', { className: 'tab-url' }, escapeHtml(tab.url));
      tabInfo.appendChild(tabTitle);
      tabInfo.appendChild(tabUrl);

      // Create tab actions
      const tabActions = createSecureElement('div', { className: 'tab-actions' });

      // Pin button with secure SVG creation
      const pinButtonClass = isPinned ? 'action-btn small pin-btn pinned' : 'action-btn small pin-btn';
      const pinButtonTitle = isPinned ? 'Unpin tab (will close on context change)' : 'Pin tab (keep open on context change)';
      const pinButton = createSecureElement('button', {
        className: pinButtonClass,
        'data-action': 'pin',
        'data-tab-id': tab.id,
        title: pinButtonTitle
      });

      // Create SVG for pin button securely using DOM methods
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.setAttribute('width', '16');
      svg.setAttribute('height', '16');
      svg.setAttribute('fill', 'currentColor');
      svg.setAttribute('viewBox', '0 0 16 16');

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      if (isPinned) {
        svg.setAttribute('class', 'bi bi-pin-fill');
        path.setAttribute('d', 'M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A6 6 0 0 1 5 6.708V2.277a3 3 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354');
      } else {
        svg.setAttribute('class', 'bi bi-pin-angle-fill');
        path.setAttribute('d', 'M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a6 6 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707s.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a6 6 0 0 1 1.013.16l3.134-3.133a3 3 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146');
      }
      svg.appendChild(path);
      pinButton.appendChild(svg);

      // Sync button
      const syncButton = createSecureElement('button', {
        className: 'action-btn icon-btn small primary',
        'data-action': 'sync',
        'data-tab-id': tab.id,
        title: isSynced ? 'Already synced to Canvas' : 'Sync to Canvas (Ctrl+click: sync & close)'
      });
      syncButton.appendChild(createSvgIcon(ICON.sync, 12));
      if (isSynced) syncButton.disabled = true;

      // Sync To button
      const syncToButton = createSecureElement('button', {
        className: 'action-btn icon-btn small primary',
        'data-action': 'sync-to',
        'data-tab-id': tab.id,
        title: 'Sync to specific paths...'
      });
      syncToButton.appendChild(createSvgIcon(ICON.syncTo, 12));
      if (isSynced) syncToButton.disabled = true;

      // Close button
      const closeButton = createSecureElement('button', {
        className: 'action-btn icon-btn small danger',
        'data-action': 'close',
        'data-tab-id': tab.id,
        title: 'Close tab'
      });
      closeButton.appendChild(createSvgIcon(ICON.close, 12));

      tabActions.appendChild(pinButton);
      tabActions.appendChild(syncButton);
      tabActions.appendChild(syncToButton);
      tabActions.appendChild(closeButton);

      // Assemble tab element
      tabElement.appendChild(checkboxLabel);
      tabElement.appendChild(faviconImg);
      tabElement.appendChild(tabInfo);
      tabElement.appendChild(tabActions);

      groupList.appendChild(tabElement);
    });

    groupElement.appendChild(groupHeader);
    groupElement.appendChild(groupList);
    browserToCanvasList.appendChild(groupElement);
  }

  // Setup checkbox listeners
  browserToCanvasList.querySelectorAll('input[type="checkbox"]:not([disabled])').forEach(checkbox => {
    checkbox.addEventListener('change', handleBrowserTabSelection);
  });

  updateTabCountHeaders();
  updateSelectAllCheckboxState();
  updateWindowGroupVisibility();
}

function renderCanvasTabs() {
  const filteredCanvasTabs = getFilteredCanvasTabs();

  if (filteredCanvasTabs.length === 0) {
    const emptyDiv = createSecureElement('div', { className: 'empty-state' });
    if (showingAllCanvasTabs) {
      emptyDiv.textContent = 'No context tabs found';
    } else {
      emptyDiv.appendChild(document.createTextNode('No new context tabs to open'));
      emptyDiv.appendChild(document.createElement('br'));
      const smallText = createSecureElement('small', {}, 'All context tabs are already open in browser');
      emptyDiv.appendChild(smallText);
    }
    canvasToBrowserList.textContent = '';
    canvasToBrowserList.appendChild(emptyDiv);
    updateTabCountHeaders();
    return;
  }

  // Clear existing content
  canvasToBrowserList.textContent = '';

  // Create tabs using secure DOM methods
  filteredCanvasTabs.forEach(tab => {
    // Create tab element
    const tabElement = createSecureElement('div', {
      className: 'tab-item',
      'data-document-id': tab.id
    });

    // Create checkbox label
    const checkboxLabel = createSecureElement('label', { className: 'tab-checkbox' });
    const checkbox = createSecureElement('input', {
      type: 'checkbox',
      'data-document-id': tab.id
    });

    // Preserve selection state
    if (selectedCanvasTabs.has(tab.id)) {
      checkbox.checked = true;
    }

    const checkmark = createSecureElement('span', { className: 'checkmark' });
    checkboxLabel.appendChild(checkbox);
    checkboxLabel.appendChild(checkmark);

    // Create favicon
    const faviconImg = createSecureElement('img', {
      src: tab.data?.favIconUrl || '../assets/icons/logo-br_64x64.png',
      className: 'tab-favicon',
      'data-fallback': '../assets/icons/logo-br_64x64.png'
    });

    // Create tab info
    const tabInfo = createSecureElement('div', { className: 'tab-info' });
    const tabTitle = createSecureElement('div', { className: 'tab-title' }, escapeHtml(tab.data?.title || 'Untitled'));
    const tabUrl = createSecureElement('div', { className: 'tab-url' }, escapeHtml(tab.data?.url || 'No URL'));
    tabInfo.appendChild(tabTitle);
    tabInfo.appendChild(tabUrl);

    // Create tab actions
    const tabActions = createSecureElement('div', { className: 'tab-actions' });

    // Open button
    const openButton = createSecureElement('button', {
      className: 'action-btn small primary',
      'data-action': 'open',
      'data-document-id': tab.id,
      title: 'Open in browser'
    }, '↙');

    // Remove button
    const removeButton = createSecureElement('button', {
      className: 'action-btn small warning',
      'data-action': 'remove',
      'data-document-id': tab.id,
      title: 'Remove from context'
    }, '⊖');

    // Delete button
    const deleteButton = createSecureElement('button', {
      className: 'action-btn small danger',
      'data-action': 'delete',
      'data-document-id': tab.id,
      title: 'Delete from database'
    }, '🗑');

    tabActions.appendChild(openButton);
    tabActions.appendChild(removeButton);
    tabActions.appendChild(deleteButton);

    // Assemble tab element
    tabElement.appendChild(checkboxLabel);
    tabElement.appendChild(faviconImg);
    tabElement.appendChild(tabInfo);
    tabElement.appendChild(tabActions);

    canvasToBrowserList.appendChild(tabElement);
  });

  updateTabCountHeaders();
  updateSelectAllCheckboxState();
  updateBulkActionVisibility();
}

// Event handlers
async function openSettingsPage() {
  try {
    const runtime = (typeof browser !== 'undefined') ? browser.runtime : chrome.runtime;
    const tabs = (typeof browser !== 'undefined') ? browser.tabs : chrome.tabs;
    await tabs.create({ url: runtime.getURL('settings/settings.html') });
    closePopupIfPossible();
  } catch (error) {
    console.error('Failed to open settings page:', error);
  }
}

async function handleDockClick() {
  try {
    // Chrome/Chromium: must be called directly from a user gesture.
    if (typeof chrome !== 'undefined' && chrome.sidePanel?.open) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (chrome.sidePanel?.setOptions && activeTab?.id != null) {
        await chrome.sidePanel.setOptions({ tabId: activeTab.id, path: 'popup/popup.html', enabled: true });
      }

      if (activeTab?.id != null) {
        await chrome.sidePanel.open({ tabId: activeTab.id });
      } else {
        const win = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({ windowId: win.id });
      }

      closePopupIfPossible();
      return;
    }

    // Firefox: open sidebar directly (also user gesture friendly).
    const sidebarAction =
      (typeof browser !== 'undefined' && browser.sidebarAction) ||
      (typeof chrome !== 'undefined' && chrome.sidebarAction);

    if (sidebarAction?.open) {
      await sidebarAction.open();
      closePopupIfPossible();
      return;
    }

    showToast('Sidebar/side panel not supported in this browser', 'warning');
    closePopupIfPossible();
  } catch (error) {
    console.error('Failed to open sidebar:', error);
    showToast(`Failed to open sidebar: ${error.message}`, 'error');
  }
}

async function openCanvasWebUI() {
  try {
    console.log('Opening Canvas server webui...');

    // Get connection settings to build the webui URL
    const response = await sendMessageToBackground('GET_CONNECTION_SETTINGS');

    if (response.success && response.settings) {
      const { serverUrl } = response.settings;

      if (serverUrl) {
        let targetUrl = serverUrl;

        // Determine target URL based on current mode
        if (currentConnection.connected) {
          if (currentConnection.mode === 'context' && currentConnection.context) {
            // If bound in contexts, point to canvasurl/contexts/context.id
            targetUrl = `${serverUrl}/contexts/${currentConnection.context.id}`;
            console.log('Opening Canvas webui for context:', currentConnection.context.id);
          } else if (currentConnection.mode === 'explorer' && currentConnection.workspace) {
            // Explorer mode: /workspaces/:ws/path/<path> (default tree shorthand)
            const workspaceName = getWorkspaceName(currentConnection.workspace);
            const contextPath = currentWorkspacePath && currentWorkspacePath !== '/' ? currentWorkspacePath : null;

            if (contextPath) {
              targetUrl = `${serverUrl}/workspaces/${workspaceName}/path${contextPath}`;
              console.log('Opening Canvas webui for workspace:', workspaceName, 'at path:', contextPath);
            } else {
              targetUrl = `${serverUrl}/workspaces/${workspaceName}`;
              console.log('Opening Canvas webui for workspace:', workspaceName, 'at root');
            }
          }
        }

        console.log('Opening Canvas webui at:', targetUrl);
        const tabs = (typeof browser !== 'undefined') ? browser.tabs : chrome.tabs;
        await tabs.create({ url: targetUrl });
        closePopupIfPossible();
      } else {
        console.error('No server URL configured');
        // Could show a toast message here
      }
    } else {
      console.error('Failed to get connection settings:', response.error);
    }
  } catch (error) {
    console.error('Failed to open Canvas webui:', error);
  }
}

function handleSearch(event) {
  const query = event.target.value.trim();
  console.log('Fuzzy searching for:', query);

  // Clear search if empty
  if (!query) {
    clearSearch();
    return;
  }

  // Perform fuzzy search based on current tab
  if (currentTab === 'browser-to-canvas') {
    performFuzzySearch(query, 'browser');
  } else if (currentTab === 'canvas-to-browser') {
    performFuzzySearch(query, 'canvas');
  }
}

function performFuzzySearch(query, type) {
  let results = [];
  let container, fuse;

  if (type === 'browser') {
    container = browserToCanvasList;
    fuse = browserTabsFuse;
  } else if (type === 'canvas') {
    container = canvasToBrowserList;
    fuse = canvasTabsFuse;
  } else {
    return;
  }

  // Perform fuzzy search if Fuse instance exists
  if (fuse && query) {
    const searchResults = fuse.search(query);
    console.log(`Fuzzy search results for "${query}":`, searchResults);

    // Extract the items from search results
    results = searchResults.map(result => ({
      item: result.item,
      score: result.score,
      matches: result.matches
    }));
  }

  // Apply search results to UI
  applySearchResults(container, results, type);

  // Update tab count headers after search
  updateTabCountHeaders();
  updateSelectAllCheckboxState();
}

function applySearchResults(container, results, type) {
  const tabItems = container.querySelectorAll('.tab-item');

  if (results.length === 0) {
    // No search results - hide all items and show search empty state
    tabItems.forEach(item => {
      item.style.display = 'none';
      item.removeAttribute('data-search-match');
    });

    // Show search-specific empty state
    showSearchEmptyState(container, searchInput.value);
    if (type === 'browser') updateWindowGroupVisibility();
    return;
  }

  // Hide any existing empty state
  hideEmptyState(container);

  // Create a set of matching item IDs for quick lookup
  const matchingIds = new Set();
  results.forEach(result => {
    const item = result.item;
    if (type === 'browser') {
      matchingIds.add(item.id);
    } else if (type === 'canvas') {
      matchingIds.add(item.id);
    }
  });

  // Show/hide items based on search results and auto-select visible ones
  tabItems.forEach(item => {
    const itemId = type === 'browser'
      ? parseInt(item.dataset.tabId)
      : parseInt(item.dataset.documentId);

    if (matchingIds.has(itemId)) {
      item.style.display = 'flex';
      item.setAttribute('data-search-match', 'true');

      // Auto-select search results for immediate syncing
      const checkbox = item.querySelector('input[type="checkbox"]');
      if (checkbox && !checkbox.disabled) {
        checkbox.checked = true;
        // Update selection sets
        if (type === 'browser') {
          selectedBrowserTabs.add(itemId);
        } else if (type === 'canvas') {
          selectedCanvasTabs.add(itemId);
        }
      }

      // Add search highlighting if available
      const searchResult = results.find(r =>
        (type === 'browser' ? r.item.id : r.item.id) === itemId
      );
      highlightSearchMatches(item, searchResult);
    } else {
      item.style.display = 'none';
      item.removeAttribute('data-search-match');

      // Uncheck hidden items
      const checkbox = item.querySelector('input[type="checkbox"]');
      if (checkbox) {
        checkbox.checked = false;
        // Remove from selection sets
        if (type === 'browser') {
          selectedBrowserTabs.delete(itemId);
        } else if (type === 'canvas') {
          selectedCanvasTabs.delete(itemId);
        }
      }
    }
  });

  // Update bulk action visibility
  updateBulkActionVisibility();

  // Update tab count headers and select-all state after applying search results
  updateTabCountHeaders();
  updateSelectAllCheckboxState();
  if (type === 'browser') updateWindowGroupVisibility();
}

function showSearchEmptyState(container, query) {
  let emptyState = container.querySelector('.empty-state');

  if (!emptyState) {
    emptyState = document.createElement('div');
    emptyState.className = 'empty-state search-empty';
    container.appendChild(emptyState);
  }

  emptyState.className = 'empty-state search-empty';
  emptyState.textContent = `No tabs match "${query}"`;
  emptyState.style.display = 'block';
}

function hideEmptyState(container) {
  const emptyState = container.querySelector('.empty-state');
  if (emptyState) {
    emptyState.style.display = 'none';
  }
}

function highlightSearchMatches(itemElement, searchResult) {
  if (!searchResult || !searchResult.matches) return;

  // Remove existing highlights
  clearHighlights(itemElement);

  // Apply highlights based on FuzzySearch matches
  searchResult.matches.forEach(match => {
    const key = match.key;
    let targetElement = null;

    if (key === 'title' || key === 'data.title') {
      targetElement = itemElement.querySelector('.tab-title');
    } else if (key === 'url' || key === 'data.url') {
      targetElement = itemElement.querySelector('.tab-url');
    }

    if (targetElement && match.indices) {
      highlightText(targetElement, match.indices, match.value);
    }
  });
}

function highlightText(element, indices, text) {
  if (!element || !indices || !text) return;

  // Clear existing content
  element.textContent = '';

  let lastIndex = 0;

  // Sort indices by start position
  const sortedIndices = indices.sort((a, b) => a[0] - b[0]);

  sortedIndices.forEach(([start, end]) => {
    // Add text before highlight as text node
    if (start > lastIndex) {
      const textBefore = document.createTextNode(text.substring(lastIndex, start));
      element.appendChild(textBefore);
    }

    // Add highlighted text as mark element
    const mark = createSecureElement('mark', { className: 'search-highlight' }, text.substring(start, end + 1));
    element.appendChild(mark);

    lastIndex = end + 1;
  });

  // Add remaining text as text node
  if (lastIndex < text.length) {
    const remainingText = document.createTextNode(text.substring(lastIndex));
    element.appendChild(remainingText);
  }
}

function clearHighlights(element) {
  const highlights = element.querySelectorAll('.search-highlight');
  highlights.forEach(highlight => {
    const parent = highlight.parentNode;
    parent.replaceChild(document.createTextNode(highlight.textContent), highlight);
    parent.normalize();
  });
}

function clearSearch() {
  console.log('Clearing search');

  // Show all items in the current tab
  const container = currentTab === 'browser-to-canvas'
    ? browserToCanvasList
    : canvasToBrowserList;

  const tabItems = container.querySelectorAll('.tab-item');
  tabItems.forEach(item => {
    item.style.display = 'flex';
    item.removeAttribute('data-search-match');
    clearHighlights(item);

    // Clear auto-selections from search when clearing search
    const checkbox = item.querySelector('input[type="checkbox"]');
    if (checkbox && !checkbox.disabled) {
      checkbox.checked = false;
    }
  });

  // Clear selection sets when clearing search
  if (currentTab === 'browser-to-canvas') {
    selectedBrowserTabs.clear();
  } else if (currentTab === 'canvas-to-browser') {
    selectedCanvasTabs.clear();
  }

  // Update bulk action visibility
  updateBulkActionVisibility();

  // Show original empty state if no items
  if (tabItems.length === 0) {
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) {
      emptyState.className = 'empty-state';
      if (currentTab === 'browser-to-canvas') {
        emptyState.textContent = 'No syncable tabs found';
      } else {
        emptyState.textContent = 'No context tabs to open';
      }
      emptyState.style.display = 'block';
    }
  } else {
    hideEmptyState(container);
  }

  // Update tab count headers after clearing search
  updateTabCountHeaders();
  updateSelectAllCheckboxState();
  if (currentTab === 'browser-to-canvas') updateWindowGroupVisibility();
}

function initializeFuseInstances() {
  console.log('Initializing FuzzySearch search instances...');

  // Initialize browser tabs fuzzy search
  const browserFuseKey = createListSignature(browserTabs, tab => `${tab.id}:${tab.url}:${tab.title || ''}`);
  if (browserFuseKey !== lastBrowserFuseKey) {
    lastBrowserFuseKey = browserFuseKey;
    browserTabsFuse = browserTabs && browserTabs.length > 0 ? new FuzzySearch(browserTabs, fuseConfig) : null;
  }
  if (browserTabsFuse) {
    console.log('Browser tabs FuzzySearch instance created with', browserTabs.length, 'items');
  }

  // Initialize Canvas documents fuzzy search
  const filteredCanvasTabs = getFilteredCanvasTabs();
  const canvasFuseKey = createListSignature(filteredCanvasTabs, doc => `${doc.id}:${doc.data?.url || ''}:${doc.data?.title || ''}`);
  if (canvasFuseKey !== lastCanvasFuseKey) {
    lastCanvasFuseKey = canvasFuseKey;
    canvasTabsFuse = filteredCanvasTabs && filteredCanvasTabs.length > 0 ? new FuzzySearch(filteredCanvasTabs, fuseConfig) : null;
  }
  if (canvasTabsFuse) {
    console.log('Canvas tabs FuzzySearch instance created with', filteredCanvasTabs.length, 'items');
  }
}

// Context URL editing handlers
function handleContextUrlClick() {
  // Only allow editing if connected and we have a context or workspace
  if (!currentConnection.connected) return;
  if (currentConnection.mode === 'context' && !currentConnection.context) return;
  if (currentConnection.mode === 'explorer' && !currentConnection.workspace) return;

  // Don't allow editing if showing placeholder text
  const currentText = contextUrl.textContent;
  if (currentText === 'No context' || currentText === 'No context bound' || currentText === 'Not bound') {
    return;
  }

  // Navigate to tree view for path selection
  navigateToTreeView();
}

// ===================================
// VIEW NAVIGATION FUNCTIONS
// ===================================

function navigateToView(viewName) {
  console.log('Navigating to view:', viewName);
  viewContainer.setAttribute('data-current-view', viewName);

  // Initialize view-specific data when navigating
  if (viewName === 'tree') {
    initializeTreeView();
  } else if (viewName === 'selection') {
    initializeSelectionView();
  }
}

async function navigateToTreeView() {
  // Set up initial path based on current mode
  if (currentConnection.mode === 'context' && currentConnection.context) {
    selectedPath = currentConnection.context.url || '/';
    const workspaceName = currentConnection.context.workspaceName || currentConnection.context.workspace || 'unknown';
    treeTitle.textContent = `Bound context: ${currentConnection.context.id}@${workspaceName}`;
    treeSubtitle.textContent = 'Select a path in the context tree';
  } else if (currentConnection.mode === 'explorer' && currentConnection.workspace) {
    selectedPath = currentWorkspacePath || '/';
    const wsName = getWorkspaceName(currentConnection.workspace);
    treeTitle.textContent = `Workspace Tree: ${wsName}`;
    treeSubtitle.textContent = 'Select a path in the workspace tree';
  }

  // Set input value to show formatted URL for consistency
  if (currentConnection.mode === 'context' && currentConnection.context) {
    const workspaceName = currentConnection.context.workspaceName || currentConnection.context.workspace ||
                         (currentConnection.workspace ? getWorkspaceName(currentConnection.workspace) : null);
    if (workspaceName) {
      treePathInput.value = formatContextUrl(workspaceName, selectedPath);
    } else {
      treePathInput.value = selectedPath;
    }
  } else if (currentConnection.mode === 'explorer' && currentConnection.workspace) {
    const wsName = getWorkspaceName(currentConnection.workspace);
    treePathInput.value = formatContextUrl(wsName, selectedPath);
  } else {
    treePathInput.value = selectedPath;
  }

  // Navigate to tree view
  navigateToView('tree');
}

async function initializeTreeView() {
  console.log('Initializing tree view...');

  try {
    // Load tree data from API
    if (currentConnection.mode === 'context' && currentConnection.context) {
      const response = await sendMessageToBackground('GET_CONTEXT_TREE', { contextId: currentConnection.context.id });
      if (response.success) {
        treeData = response.tree;
        renderTreeView();
      } else {
        throw new Error(response.error || 'Failed to load context tree');
      }
    } else if (currentConnection.mode === 'explorer' && currentConnection.workspace) {
      const wsId = currentConnection.workspace.name || currentConnection.workspace.id;
      const response = await sendMessageToBackground('GET_WORKSPACE_TREE', { workspaceIdOrName: wsId });
      if (response.success) {
        treeData = response.tree;
        renderTreeView();
      } else {
        throw new Error(response.error || 'Failed to load workspace tree');
      }
    }
  } catch (error) {
    console.error('Failed to initialize tree view:', error);
    const errorDiv = createSecureElement('div', { className: 'empty-state' }, `Failed to load tree: ${error.message}`);
    treeContainer.textContent = '';
    treeContainer.appendChild(errorDiv);
  }
}

function renderTreeView() {
  if (!treeData) {
    const emptyDiv = createSecureElement('div', { className: 'empty-state' }, 'No tree data available');
    treeContainer.textContent = '';
    treeContainer.appendChild(emptyDiv);
    return;
  }

  console.log('Rendering tree view with data:', treeData);
  console.log('Tree data structure:', JSON.stringify(treeData, null, 2));

  if (treeSearchInput) {
    treeSearchInput.value = '';
    treeSearchClear.style.display = 'none';
  }

  const treeHtml = renderTreeNode(treeData, '', 0);
  treeContainer.textContent = '';
  setSecureHtml(treeContainer, treeHtml);

  // Add event listeners to tree nodes
  setupTreeEventListeners();
}

function renderTreeNode(node, parentPath, level) {
  // Build the correct path for this node
  const currentPath = level === 0 ? '/' : (parentPath === '/' ? `/${node.name}` : `${parentPath}/${node.name}`);
  const isSelected = selectedPath === currentPath;
  const hasChildren = node.children && node.children.length > 0;
  const isRoot = level === 0;

  console.log(`Rendering node: ${node.name || 'root'}, level: ${level}, parentPath: "${parentPath}", currentPath: "${currentPath}"`);

  let html = '';

  if (isRoot) {
    // Render root node - always represents '/'
    html += `
      <div class="tree-node ${isSelected ? 'selected' : ''}" data-path="/" data-level="0" data-node-id="${node.id || 'root'}">
        <div class="expand-btn"></div>
        <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        ${node.color && node.color !== '#fff' ? `<div class="color-indicator" style="background-color: ${node.color}"></div>` : ''}
        <span class="node-label">/</span>
      </div>
    `;
  }

  if (hasChildren) {
    if (isRoot) {
      html += '<div class="tree-children">';
    }

    for (const child of node.children) {
      // FIXED: Pass the currentPath as parentPath for children (not building path again)
      const childPath = currentPath === '/' ? `/${child.name}` : `${currentPath}/${child.name}`;
      const childSelected = selectedPath === childPath;
      const childHasChildren = child.children && child.children.length > 0;

      console.log(`Child: ${child.name}, parentPath: "${currentPath}", childPath: "${childPath}"`);

      html += `
        <div class="tree-node ${childSelected ? 'selected' : ''}" data-path="${childPath}" data-level="${level + 1}" data-node-id="${child.id || child.name}" style="padding-left: ${(level + 1) * 20}px">
          <button class="expand-btn" ${!childHasChildren ? 'style="visibility: hidden;"' : ''}>
            ${childHasChildren ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>' : ''}
          </button>
          <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          ${child.color && child.color !== '#fff' ? `<div class="color-indicator" style="background-color: ${child.color}"></div>` : ''}
          <span class="node-label">${child.label || child.name}</span>
        </div>
      `;

      if (childHasChildren) {
        html += '<div class="tree-children" style="display: none;">';
        // FIXED: Pass currentPath as the parentPath for recursive call, not childPath
        html += renderTreeNode(child, currentPath, level + 1);
        html += '</div>';
      }
    }

    if (isRoot) {
      html += '</div>';
    }
  }

  return html;
}

function setupTreeEventListeners() {
  // Add click listeners to tree nodes
  treeContainer.addEventListener('click', (event) => {
    const treeNode = event.target.closest('.tree-node');
    if (treeNode) {
      const path = treeNode.dataset.path;
      selectTreePath(path);
    }

    // Handle expand/collapse
    const expandBtn = event.target.closest('.expand-btn');
    if (expandBtn && expandBtn.querySelector('svg')) {
      event.stopPropagation();
      const treeNode = expandBtn.closest('.tree-node');
      const children = treeNode.nextElementSibling;
      if (children && children.classList.contains('tree-children')) {
        const isExpanded = children.style.display !== 'none';
        children.style.display = isExpanded ? 'none' : 'block';
        const svg = expandBtn.querySelector('svg');
        svg.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
      }
    }
  });
}

function filterTreeView(query) {
  // Clear previous search state
  treeContainer.querySelectorAll('.tree-node').forEach(node => {
    node.classList.remove('hidden-by-search', 'search-match');
    const label = node.querySelector('.node-label');
    if (label && label.dataset.originalText !== undefined) {
      label.textContent = label.dataset.originalText;
      delete label.dataset.originalText;
    }
  });
  treeContainer.querySelectorAll('.tree-children[data-search-opened]').forEach(tc => {
    tc.style.display = 'none';
    tc.removeAttribute('data-search-opened');
    const prevNode = tc.previousElementSibling;
    if (prevNode && prevNode.classList.contains('tree-node')) {
      const svg = prevNode.querySelector('.expand-btn svg');
      if (svg) svg.style.transform = '';
    }
  });
  const prevNoResults = treeContainer.querySelector('.tree-no-results');
  if (prevNoResults) prevNoResults.remove();

  if (!query) return;

  const lowerQuery = query.toLowerCase();
  const allNodes = Array.from(treeContainer.querySelectorAll('.tree-node'));

  // Collect paths whose label matches the query
  const matchingPaths = new Set();
  allNodes.forEach(node => {
    const label = node.querySelector('.node-label');
    if (label && label.textContent.toLowerCase().includes(lowerQuery)) {
      matchingPaths.add(node.dataset.path);
    }
  });

  // Build visible set: matching nodes + all ancestor paths
  const visiblePaths = new Set(matchingPaths);
  visiblePaths.add('/');
  matchingPaths.forEach(path => {
    const parts = path.split('/').filter(Boolean);
    let ancestor = '';
    for (const part of parts) {
      ancestor = ancestor ? `${ancestor}/${part}` : `/${part}`;
      visiblePaths.add(ancestor);
    }
  });

  // Apply visibility and highlight matching labels
  allNodes.forEach(node => {
    const path = node.dataset.path;
    const label = node.querySelector('.node-label');

    if (!visiblePaths.has(path)) {
      node.classList.add('hidden-by-search');
      return;
    }

    node.classList.add('search-match');

    if (matchingPaths.has(path) && label && label.textContent !== '/') {
      const original = label.textContent;
      const lowerText = original.toLowerCase();
      const idx = lowerText.indexOf(lowerQuery);
      if (idx !== -1) {
        label.dataset.originalText = original;
        label.textContent = '';
        if (idx > 0) label.appendChild(document.createTextNode(original.slice(0, idx)));
        const mark = document.createElement('mark');
        mark.className = 'search-highlight';
        mark.textContent = original.slice(idx, idx + lowerQuery.length);
        label.appendChild(mark);
        if (idx + lowerQuery.length < original.length) {
          label.appendChild(document.createTextNode(original.slice(idx + lowerQuery.length)));
        }
      }
    }
  });

  // Expand collapsed tree-children containers that contain visible nodes
  treeContainer.querySelectorAll('.tree-children').forEach(tc => {
    if (tc.style.display === 'none' && tc.querySelector('.tree-node:not(.hidden-by-search)')) {
      tc.style.display = 'block';
      tc.setAttribute('data-search-opened', 'true');
      const prevNode = tc.previousElementSibling;
      if (prevNode && prevNode.classList.contains('tree-node')) {
        const svg = prevNode.querySelector('.expand-btn svg');
        if (svg) svg.style.transform = 'rotate(90deg)';
      }
    }
  });

  if (matchingPaths.size === 0) {
    const noResults = document.createElement('div');
    noResults.className = 'tree-no-results';
    noResults.textContent = `No folders matching "${query}"`;
    treeContainer.appendChild(noResults);
  }
}

function clearTreeSearch() {
  treeContainer.querySelectorAll('.tree-node').forEach(node => {
    node.classList.remove('hidden-by-search', 'search-match');
    const label = node.querySelector('.node-label');
    if (label && label.dataset.originalText !== undefined) {
      label.textContent = label.dataset.originalText;
      delete label.dataset.originalText;
    }
  });
  treeContainer.querySelectorAll('.tree-children[data-search-opened]').forEach(tc => {
    tc.style.display = 'none';
    tc.removeAttribute('data-search-opened');
    const prevNode = tc.previousElementSibling;
    if (prevNode && prevNode.classList.contains('tree-node')) {
      const svg = prevNode.querySelector('.expand-btn svg');
      if (svg) svg.style.transform = '';
    }
  });
  const noResults = treeContainer.querySelector('.tree-no-results');
  if (noResults) noResults.remove();
  if (treeSearchInput) {
    treeSearchInput.value = '';
    treeSearchClear.style.display = 'none';
  }
}

function selectTreePath(path) {
  console.log('Selected tree path:', path);
  console.log('Tree node that was clicked:', document.querySelector(`[data-path="${path}"]`));
  selectedPath = path;

  // Always format as absolute URL for display consistency
  let formattedPath = path;
  if (currentConnection.mode === 'context' && currentConnection.context) {
    const workspaceName = currentConnection.context.workspaceName || currentConnection.context.workspace ||
                         (currentConnection.workspace ? getWorkspaceName(currentConnection.workspace) : null);
    if (workspaceName) {
      formattedPath = formatContextUrl(workspaceName, path);
    }
  } else if (currentConnection.mode === 'explorer' && currentConnection.workspace) {
    const wsName = getWorkspaceName(currentConnection.workspace);
    formattedPath = formatContextUrl(wsName, path);
  }

  treePathInput.value = formattedPath;

  // Update selected state in UI
  document.querySelectorAll('.tree-node').forEach(node => {
    node.classList.remove('selected');
  });

  const selectedNode = document.querySelector(`[data-path="${path}"]`);
  if (selectedNode) {
    selectedNode.classList.add('selected');
    console.log('Selected node data:', {
      path: selectedNode.dataset.path,
      nodeId: selectedNode.dataset.nodeId,
      level: selectedNode.dataset.level
    });
  }
}

async function handlePathSubmit() {
  const newPath = treePathInput.value.trim() || '/';
  console.log('Submitting path:', newPath);

  try {
    if (currentConnection.mode === 'context' && currentConnection.context) {
      // For context mode: extract relative path if full URL is provided
      let pathToSend = newPath;
      const parsed = parseContextUrl(newPath);
      if (parsed.workspaceName) {
        // Full URL provided, send relative path to backend
        pathToSend = parsed.path;
      }

      // Update context URL - use direct message format for cross-browser compatibility
      const response = await sendDirectMessageToBackground({
        type: 'context.url.update',
        contextId: currentConnection.context.id,
        url: pathToSend
      });

      if (response.success) {
        currentConnection.context.url = pathToSend;

        // Update display with properly formatted URL
        const workspaceName = currentConnection.context.workspaceName ||
                             currentConnection.context.workspace ||
                             (currentConnection.workspace ? getWorkspaceName(currentConnection.workspace) : null);

        if (workspaceName) {
          contextUrl.textContent = formatContextUrl(workspaceName, pathToSend);
        } else {
          contextUrl.textContent = pathToSend;
        }

        currentWorkspacePath = pathToSend; // Update for display consistency
        console.log('Context URL updated successfully');
      } else {
        throw new Error(response.error || 'Failed to update context URL');
      }
    } else if (currentConnection.mode === 'explorer' && currentConnection.workspace) {
      // For workspace mode: extract relative path if full URL is provided
      let pathToSend = newPath;
      const parsed = parseContextUrl(newPath);
      if (parsed.workspaceName) {
        // Full URL provided, use relative path only
        pathToSend = parsed.path;
      }

      // Try to insert the path in the workspace tree (creates path if it doesn't exist)
      try {
        const wsId = currentConnection.workspace.name || currentConnection.workspace.id;
        const insertResponse = await sendMessageToBackground('INSERT_WORKSPACE_PATH', {
          path: pathToSend,
          workspaceIdOrName: wsId,
          autoCreateLayers: true
        });

        if (insertResponse.success) {
          console.log('Workspace path inserted/created successfully');
        } else {
          console.warn('Failed to insert workspace path:', insertResponse.error);
          // Continue anyway - the path might already exist
        }
      } catch (insertError) {
        console.warn('Error inserting workspace path:', insertError);
        // Continue anyway - the path might already exist
      }

      // Update workspace path (must be relative)
      currentWorkspacePath = pathToSend;

      // Update display with properly formatted URL
      const wsName = getWorkspaceName(currentConnection.workspace);
      contextUrl.textContent = formatContextUrl(wsName, pathToSend);

      // Persist the workspace path
      await sendMessageToBackground('SET_MODE_AND_SELECTION', {
        mode: 'explorer',
        workspace: currentConnection.workspace,
        workspacePath: currentWorkspacePath
      });

      console.log('Workspace path updated successfully');
    }

    // Refresh tabs with new path and navigate back to main view
    canvasPagination.offset = 0;
    await loadTabs();
    navigateToView('main');

  } catch (error) {
    console.error('Failed to submit path:', error);
    alert('Failed to update path: ' + error.message);
  }
}

function handleTreePathKeydown(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    handlePathSubmit();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    navigateToView('main');
  }
}

// ===================================
// SELECTION VIEW FUNCTIONS
// ===================================

async function initializeSelectionView() {
  console.log('Initializing selection view...');

  // Load contexts and workspaces
  await loadContextsAndWorkspaces();

  // Render the current tab
  renderSelectionTab();
}

function switchSelectionTab(tabName) {
  currentSelectionTab = tabName;

  // Update tab buttons
  document.querySelectorAll('.selection-tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });

  document.querySelectorAll('.selection-tab-content').forEach(content => {
    content.classList.remove('active');
  });

  // Activate selected tab
  const targetTab = document.querySelector(`[data-selection-tab="${tabName}"]`);
  const targetContent = document.getElementById(`${tabName}-selection`);

  if (targetTab && targetContent) {
    targetTab.classList.add('active');
    targetContent.classList.add('active');
  }

  renderSelectionTab();
}

async function loadContextsAndWorkspaces() {
  try {
    // Load contexts
    const contextsResponse = await sendMessageToBackground('GET_CONTEXTS');
    if (contextsResponse.success) {
      console.log('Loaded contexts:', contextsResponse.contexts);
      renderContextsList(contextsResponse.contexts || []);
    } else {
      console.error('Failed to load contexts:', contextsResponse.error);
      const errorDiv = createSecureElement('div', { className: 'empty-state' }, `Failed to load contexts: ${contextsResponse.error}`);
      contextsList.textContent = '';
      contextsList.appendChild(errorDiv);
    }

    // Load workspaces
    const workspacesResponse = await sendMessageToBackground('GET_WORKSPACES');
    if (workspacesResponse.success) {
      console.log('Loaded workspaces:', workspacesResponse.workspaces);
      renderWorkspacesList(workspacesResponse.workspaces || []);
    } else {
      console.error('Failed to load workspaces:', workspacesResponse.error);
      const errorDiv = createSecureElement('div', { className: 'empty-state' }, `Failed to load workspaces: ${workspacesResponse.error}`);
      workspacesList.textContent = '';
      workspacesList.appendChild(errorDiv);
    }
  } catch (error) {
    console.error('Failed to load contexts and workspaces:', error);
    const errorDiv1 = createSecureElement('div', { className: 'empty-state' }, `Error: ${error.message}`);
    contextsList.textContent = '';
    contextsList.appendChild(errorDiv1);

    const errorDiv2 = createSecureElement('div', { className: 'empty-state' }, `Error: ${error.message}`);
    workspacesList.textContent = '';
    workspacesList.appendChild(errorDiv2);
  }
}

function renderContextsList(contexts) {
  if (!contexts || contexts.length === 0) {
    const emptyDiv = createSecureElement('div', { className: 'empty-state' }, 'No contexts available');
    contextsList.textContent = '';
    contextsList.appendChild(emptyDiv);
    return;
  }

  const contextsHtml = contexts.map(context => `
    <div class="selection-item" data-context-id="${context.id}">
      <div class="selection-item-info">
        <div class="selection-item-name">${context.name || context.id}</div>
        <div class="selection-item-id">${context.id}</div>
        ${context.url ? `<div class="selection-item-url">${context.url}</div>` : ''}
      </div>
      <div class="selection-item-actions">
        <button class="selection-action-btn bind-context-btn" data-context-id="${context.id}" data-context-name="${escapeHtml(context.name || context.id)}" data-context-url="${escapeHtml(context.url || '')}">
          Bind
        </button>
      </div>
    </div>
  `).join('');

  contextsList.textContent = '';
  setSecureHtml(contextsList, contextsHtml);
}

function renderWorkspacesList(workspaces) {
  if (!workspaces || workspaces.length === 0) {
    const emptyDiv = createSecureElement('div', { className: 'empty-state' }, 'No workspaces available');
    workspacesList.textContent = '';
    workspacesList.appendChild(emptyDiv);
    return;
  }

  // Filter workspaces to only show those with status "active"
  const activeWorkspaces = workspaces.filter(workspace => workspace.status === 'active');

  if (activeWorkspaces.length === 0) {
    const emptyDiv = createSecureElement('div', { className: 'empty-state' }, 'No active workspaces available');
    workspacesList.textContent = '';
    workspacesList.appendChild(emptyDiv);
    return;
  }

  const workspacesHtml = activeWorkspaces.map(workspace => `
    <div class="selection-item" data-workspace-id="${workspace.id}">
      <div class="selection-item-info">
        <div class="selection-item-name">${workspace.label || workspace.name || workspace.id}</div>
        <div class="selection-item-id">${workspace.id}</div>
        ${workspace.description ? `<div class="selection-item-url">${workspace.description}</div>` : ''}
      </div>
      <div class="selection-item-actions">
        <button class="selection-action-btn open-workspace-btn"
                data-workspace-id="${workspace.id}"
                data-workspace-name="${escapeHtml(workspace.name || workspace.label)}"
                data-workspace-label="${escapeHtml(workspace.label || workspace.name)}">
          Open Workspace
        </button>
      </div>
    </div>
  `).join('');

  workspacesList.textContent = '';
  setSecureHtml(workspacesList, workspacesHtml);
}

function renderSelectionTab() {
  // Tab content is already rendered, just ensure current tab is visible
  console.log('Selection tab rendered:', currentSelectionTab);
}

async function bindToContext(contextId, contextName, contextUrl) {
  try {
    console.log('Binding to context:', contextId, 'with URL:', contextUrl);

    // Get the full context object from the contexts list to access workspaceName
    const contextsResponse = await sendMessageToBackground('GET_CONTEXTS');
    let selectedContext = null;

    if (contextsResponse.success && contextsResponse.contexts) {
      selectedContext = contextsResponse.contexts.find(ctx => ctx.id === contextId);
    }

    if (!selectedContext) {
      throw new Error('Context not found in available contexts');
    }

    console.log('Full context object from API:', selectedContext);

    // Use the context data directly from the API response
    const contextData = {
      id: selectedContext.id,
      name: selectedContext.name || contextName,
      url: selectedContext.url,
      path: selectedContext.path,
      workspaceName: selectedContext.workspaceName,
      workspaceId: selectedContext.workspaceId,
      workspace: selectedContext.workspaceName
    };

    console.log('Context data for binding:', contextData);

    const response = await sendMessageToBackground('BIND_CONTEXT', { context: contextData });

    if (response.success) {
      console.log('Bound to context successfully');

      // Set full context object from response to include all properties
      currentConnection.mode = 'context';
      currentConnection.context = response.context;
      canvasPagination.offset = 0;

      // Persist mode and selection to storage
      await sendMessageToBackground('SET_MODE_AND_SELECTION', {
        mode: 'context',
        context: response.context
      });

      // Update header with proper formatting
      updateConnectionStatus(currentConnection);

      showToast(`Bound to context: ${contextId}`, 'success');

      // Navigate back to main view
      navigateToView('main');
    } else {
      console.error('Failed to bind context:', response.error);
      showToast(`Failed to bind context: ${response.error}`, 'error');
    }
  } catch (error) {
    console.error('Error in bindToContext:', error);
    showToast(`Error binding context: ${error.message}`, 'error');
  }
}

async function openWorkspace(workspaceId, workspaceName, workspaceLabel) {
  try {
    console.log('Opening workspace:', workspaceId, 'name:', workspaceName);

    const workspaceData = {
      id: workspaceId,
      name: workspaceName, // Now correctly using the actual workspace name
      label: workspaceLabel || workspaceName
    };

    const response = await sendMessageToBackground('OPEN_WORKSPACE', { workspace: workspaceData });

    if (response.success) {
      console.log('Opened workspace successfully');

      // Update current connection
      currentConnection.mode = 'explorer';
      currentConnection.workspace = workspaceData;
      currentConnection.context = null;
      currentWorkspacePath = '/'; // Default to root
      canvasPagination.offset = 0;

      // Update connection status display
      updateConnectionStatus(currentConnection);

      // Navigate to tree view to show the workspace tree
      await navigateToTreeView();
    } else {
      throw new Error(response.error || 'Failed to open workspace');
    }
  } catch (error) {
    console.error('Failed to open workspace:', error);
    alert('Failed to open workspace: ' + error.message);
  }
}

// Event delegation handlers
function handleSelectionActionClick(event) {
  const button = event.target;

  if (button.classList.contains('bind-context-btn')) {
    const contextId = button.dataset.contextId;
    const contextName = button.dataset.contextName;
    const contextUrl = button.dataset.contextUrl;
    bindToContext(contextId, contextName, contextUrl);
  } else if (button.classList.contains('open-workspace-btn')) {
    const workspaceId = button.dataset.workspaceId;
    const workspaceName = button.dataset.workspaceName;
    const workspaceLabel = button.dataset.workspaceLabel;
    openWorkspace(workspaceId, workspaceName, workspaceLabel);
  }
}

function handleSelectionBackClick() {
  // Determine where to go back based on current connection state
  if (currentConnection.context || currentConnection.workspace) {
    // If we have a context or workspace, go to tree view
    navigateToTreeView();
  } else {
    // Otherwise go back to main view
    navigateToView('main');
  }
}

async function handleSyncSettingChange(event) {
  try {
    const settingName = event.target.id;
    const settingValue = event.target.checked;

    console.log('Sync setting changed:', settingName, '=', settingValue);

    // Map checkbox IDs to setting names
    const settingMap = {
      'sendNewTabsToCanvas': 'sendNewTabsToCanvas',
      'openTabsAddedToCanvas': 'openTabsAddedToCanvas'
    };

    const actualSettingName = settingMap[settingName];
    if (!actualSettingName) {
      console.warn('Unknown sync setting:', settingName);
      return;
    }

    // Create partial settings object
    const settingsUpdate = {
      [actualSettingName]: settingValue
    };

    console.log('Saving sync setting update:', settingsUpdate);

    // Save to background service worker
    const response = await sendMessageToBackground('SET_SYNC_SETTINGS', settingsUpdate);

    if (response.success) {
      console.log('Sync setting saved successfully:', actualSettingName, '=', settingValue);
      currentSyncSettings = { ...currentSyncSettings, ...settingsUpdate };
    } else {
      console.error('Failed to save sync setting:', response.error);
      // Revert checkbox state on failure
      event.target.checked = !settingValue;
    }
  } catch (error) {
    console.error('Failed to save sync setting:', error);
    // Revert checkbox state on failure
    event.target.checked = !event.target.checked;
  }
}

function handleShowSyncedChange(event) {
  showingSyncedTabs = event.target.checked;
  console.log('Show synced tabs toggled:', showingSyncedTabs);

  // Update the section header
  const sectionHeader = document.querySelector('#browser-to-canvas .section-header h3');
  if (sectionHeader) {
    sectionHeader.textContent = showingSyncedTabs ? 'Browser Tabs' : 'Unsynced Browser Tabs';
  }

  // Update filter and re-render browser tabs
  updateBrowserTabsFilter();
  renderBrowserTabs();
}

function handleShowHiddenChange(event) {
  showingHiddenTabs = event.target.checked;
  console.log('Show hidden/stashed tabs toggled:', showingHiddenTabs);
  refreshBrowserTabFilter();
  markSyncedBrowserTabs(canvasTabs);
  updateBrowserTabsFilter();
  renderBrowserTabs();
  initializeFuseInstances();
}

function handleShowAllCanvasChange(event) {
  showingAllCanvasTabs = event.target.checked;
  console.log('Show all Canvas tabs toggled:', showingAllCanvasTabs);

  // Re-render Canvas tabs with new filter
  renderCanvasTabs();

  // Reinitialize fuzzy search with filtered data
  initializeFuseInstances();
}

function handleBrowserTabSelection(event) {
  const tabId = parseInt(event.target.dataset.tabId);
  if (event.target.checked) {
    selectedBrowserTabs.add(tabId);
  } else {
    selectedBrowserTabs.delete(tabId);
  }

  updateBulkActionVisibility();
}

function updateBulkActionVisibility() {
  // Show/hide bulk actions for browser tabs
  if (selectedBrowserTabs.size > 0) {
    browserBulkActions.style.display = 'flex';
  } else {
    browserBulkActions.style.display = 'none';
  }

  // Show/hide bulk actions for Canvas tabs
  if (selectedCanvasTabs.size > 0) {
    canvasBulkActions.style.display = 'flex';
  } else {
    canvasBulkActions.style.display = 'none';
  }
}

// Tab action handlers (now called via event delegation)
async function handleSyncTab(tabId, shouldCloseAfterSync = false) {
  try {
    console.log('Syncing tab:', tabId, shouldCloseAfterSync ? '(will close after sync)' : '');

    // Find the tab
    const tab = browserTabs.find(t => t.id === tabId);
    if (!tab) {
      console.error('Tab not found:', tabId);
      return;
    }

    const response = await sendMessageToBackground('SYNC_TAB', { tab });
    console.log('Sync tab response:', response);

    if (response.success) {
      // If Ctrl was held, close the tab after successful sync
      if (shouldCloseAfterSync) {
        console.log('Closing tab after sync as requested:', tabId);
        await handleCloseTab(tabId);
      } else {
        await loadTabs(); // Refresh lists only if not closing
      }
    }
  } catch (error) {
    console.error('Failed to sync tab:', error);
  }
}

async function handleCloseTab(tabId) {
  try {
    console.log('Closing tab:', tabId);

    const response = await sendMessageToBackground('CLOSE_TAB', { tabId });
    console.log('Close tab response:', response);

    if (response.success) {
      await loadTabs(); // Refresh lists
    }
  } catch (error) {
    console.error('Failed to close tab:', error);
  }
}

async function handlePinTab(tabId) {
  try {
    console.log('Toggling pin for tab:', tabId);

    const response = await sendMessageToBackground('TOGGLE_PIN_TAB', { tabId });
    console.log('Pin tab response:', response);

    if (response.success) {
      await loadTabs(); // Refresh lists to update pin state
    }
  } catch (error) {
    console.error('Failed to toggle pin tab:', error);
  }
}

async function handleFocusTab(tabId) {
  try {
    console.log('Focusing tab:', tabId);

    const response = await sendMessageToBackground('FOCUS_TAB', { tabId });
    console.log('Focus tab response:', response);

    if (!response.success) {
      console.error('Failed to focus tab:', response.error);
    }
  } catch (error) {
    console.error('Failed to focus tab:', error);
  }
}

async function handleOpenCanvasTab(documentId) {
  try {
    console.log('Opening Canvas document:', documentId);

    // Find the Canvas document
    const document = canvasTabs.find(doc => doc.id === documentId);
    if (!document) {
      console.error('Canvas document not found:', documentId);
      return;
    }

    const response = await sendMessageToBackground('OPEN_CANVAS_DOCUMENT', { document });
    console.log('Open Canvas document response:', response);

    if (response.success) {
      console.log('Canvas document opened successfully');
      showToast(`Opened: ${document.data?.title || 'Tab'}`, 'success');
      applyOpenedCanvasDocuments(response, [document]);
    } else {
      console.error('Failed to open Canvas document:', response.error);
      showToast(`Failed to open: ${response.error || 'Unknown error'}`, 'error');
    }
  } catch (error) {
    console.error('Failed to open Canvas tab:', error);
    showToast(`Error opening tab: ${error.message}`, 'error');
  }
}

async function handleRemoveCanvasTab(documentId) {
  try {
    console.log('Removing Canvas document:', documentId);

    // Find the Canvas document
    const document = canvasTabs.find(doc => doc.id === documentId);
    if (!document) {
      console.error('Canvas document not found:', documentId);
      return;
    }

    const response = await sendMessageToBackground('REMOVE_CANVAS_DOCUMENT', {
      document,
      closeTab: false
    });
    console.log('Remove Canvas document response:', response);

    if (response.success) {
      applyRemovedCanvasDocuments([document.id]);
    } else {
      console.error('Failed to remove Canvas document:', response.error);
    }
  } catch (error) {
    console.error('Failed to remove from context:', error);
  }
}

async function handleDeleteCanvasTab(documentId) {
  try {
    console.log('Deleting Canvas document:', documentId);

    // Find the Canvas document
    const document = canvasTabs.find(doc => doc.id === documentId);
    if (!document) {
      console.error('Canvas document not found:', documentId);
      return;
    }

    // Use the removeDocument API with deleteFromDatabase option
    const response = await sendMessageToBackground('REMOVE_CANVAS_DOCUMENT', {
      document,
      closeTab: true
    });
    console.log('Delete Canvas document response:', response);

    if (response.success) {
      applyRemovedCanvasDocuments([document.id]);
    } else {
      console.error('Failed to delete Canvas document:', response.error);
    }
  } catch (error) {
    console.error('Failed to delete from database:', error);
  }
}

// Event delegation handlers
function handleBrowserTabAction(event) {
  console.log('Browser tab action event triggered:', event.target);

  const button = event.target.closest('button[data-action]');
  console.log('Found button:', button);

  // Check if it's a button action
  if (button) {
    event.preventDefault();
    event.stopPropagation();

    const action = button.dataset.action;
    if (action === 'sync-window' || action === 'sync-close-window' || action === 'close-window' || action === 'sync-to-window') {
      const windowId = parseInt(button.dataset.windowId);
      if (!Number.isInteger(windowId)) {
        console.error('No windowId found for action:', action);
        return;
      }
      if (action === 'close-window') {
        handleCloseWindow(windowId);
      } else if (action === 'sync-to-window') {
        const tabIds = getUnsyncedTabIdsForWindow(windowId);
        if (tabIds.length > 0) openSyncToPanel(tabIds);
      } else {
        handleSyncWindow(windowId, action === 'sync-close-window');
      }
      return;
    }

    const tabId = parseInt(button.dataset.tabId);

    console.log('Action:', action, 'TabId:', tabId);

    if (!tabId) {
      console.error('No tabId found for action:', action);
      return;
    }

    switch (action) {
    case 'sync': {
      console.log('Calling handleSyncTab with tabId:', tabId);
      const shouldCloseAfterSync = event.ctrlKey || event.metaKey;
      handleSyncTab(tabId, shouldCloseAfterSync);
      break;
    }
    case 'sync-to':
      openSyncToPanel([tabId]);
      break;
    case 'close':
      console.log('Calling handleCloseTab with tabId:', tabId);
      handleCloseTab(tabId);
      break;
    case 'pin':
      console.log('Calling handlePinTab with tabId:', tabId);
      handlePinTab(tabId);
      break;
    default:
      console.warn('Unknown browser tab action:', action);
    }
    return;
  }

  // Check if it's a click on the tab info area (for focusing)
  const tabInfo = event.target.closest('.tab-info');
  const tabItem = event.target.closest('.tab-item');

  if (tabInfo && tabItem) {
    const tabId = parseInt(tabItem.dataset.tabId);

    console.log('Tab info clicked, focusing tab:', tabId);

    if (tabId) {
      event.preventDefault();
      event.stopPropagation();
      handleFocusTab(tabId);
    }
  }
}

function handleCanvasTabAction(event) {
  console.log('Canvas tab action event triggered:', event.target);

  const button = event.target.closest('button[data-action]');
  console.log('Found button:', button);

  // Check if it's a button action
  if (button) {
    event.preventDefault();
    event.stopPropagation();

    const action = button.dataset.action;
    const documentId = parseInt(button.dataset.documentId);

    console.log('Action:', action, 'DocumentId:', documentId);

    if (!documentId) {
      console.error('No documentId found for action:', action);
      return;
    }

    switch (action) {
    case 'open':
      console.log('Calling handleOpenCanvasTab with documentId:', documentId);
      handleOpenCanvasTab(documentId);
      break;
    case 'remove':
      console.log('Calling handleRemoveCanvasTab with documentId:', documentId);
      handleRemoveCanvasTab(documentId);
      break;
    case 'delete':
      console.log('Calling handleDeleteCanvasTab with documentId:', documentId);
      handleDeleteCanvasTab(documentId);
      break;
    default:
      console.warn('Unknown Canvas tab action:', action);
    }
    return;
  }

  // Check if it's a click on the tab info area (for opening)
  const tabInfo = event.target.closest('.tab-info');
  const tabItem = event.target.closest('.tab-item');

  if (tabInfo && tabItem) {
    const documentId = parseInt(tabItem.dataset.documentId);

    console.log('Canvas tab info clicked, opening tab:', documentId);

    if (documentId) {
      event.preventDefault();
      event.stopPropagation();
      handleOpenCanvasTab(documentId);
    }
  }
}

function handleBrowserTabCheckbox(event) {
  const checkbox = event.target.closest('input[type="checkbox"][data-tab-id]');
  if (!checkbox) return;

  const tabId = parseInt(checkbox.dataset.tabId);
  if (!tabId) return;

  if (checkbox.checked) {
    selectedBrowserTabs.add(tabId);
  } else {
    selectedBrowserTabs.delete(tabId);
  }

  updateBulkActionVisibility();
  updateSelectAllCheckboxState();
}

function handleCanvasTabCheckbox(event) {
  const checkbox = event.target.closest('input[type="checkbox"][data-document-id]');
  if (!checkbox) return;

  const documentId = parseInt(checkbox.dataset.documentId);
  if (!documentId) return;

  if (checkbox.checked) {
    selectedCanvasTabs.add(documentId);
  } else {
    selectedCanvasTabs.delete(documentId);
  }

  updateBulkActionVisibility();
  updateSelectAllCheckboxState();
}

function handleSelectAllBrowser() {
  const isChecked = selectAllBrowser.checked;
  const visibleCheckboxes = browserToCanvasList.querySelectorAll('.tab-item:not([style*="display: none"]) input[type="checkbox"]:not([disabled])');

  visibleCheckboxes.forEach(checkbox => {
    const tabId = parseInt(checkbox.dataset.tabId);
    if (tabId) {
      checkbox.checked = isChecked;
      if (isChecked) {
        selectedBrowserTabs.add(tabId);
      } else {
        selectedBrowserTabs.delete(tabId);
      }
    }
  });

  updateBulkActionVisibility();
}

function handleSelectAllCanvas() {
  const isChecked = selectAllCanvas.checked;
  const visibleCheckboxes = canvasToBrowserList.querySelectorAll('.tab-item:not([style*="display: none"]) input[type="checkbox"]:not([disabled])');

  visibleCheckboxes.forEach(checkbox => {
    const documentId = parseInt(checkbox.dataset.documentId);
    if (documentId) {
      checkbox.checked = isChecked;
      if (isChecked) {
        selectedCanvasTabs.add(documentId);
      } else {
        selectedCanvasTabs.delete(documentId);
      }
    }
  });

  updateBulkActionVisibility();
}

function updateSelectAllCheckboxState() {
  // Update browser select-all checkbox state
  const visibleBrowserCheckboxes = browserToCanvasList.querySelectorAll('.tab-item:not([style*="display: none"]) input[type="checkbox"]:not([disabled])');
  const checkedBrowserCheckboxes = browserToCanvasList.querySelectorAll('.tab-item:not([style*="display: none"]) input[type="checkbox"]:checked:not([disabled])');
  if (visibleBrowserCheckboxes.length > 0) {
    selectAllBrowser.checked = visibleBrowserCheckboxes.length === checkedBrowserCheckboxes.length;
    selectAllBrowser.indeterminate = checkedBrowserCheckboxes.length > 0 && checkedBrowserCheckboxes.length < visibleBrowserCheckboxes.length;
  } else {
    selectAllBrowser.checked = false;
    selectAllBrowser.indeterminate = false;
  }

  // Update canvas select-all checkbox state
  const visibleCanvasCheckboxes = canvasToBrowserList.querySelectorAll('.tab-item:not([style*="display: none"]) input[type="checkbox"]:not([disabled])');
  const checkedCanvasCheckboxes = canvasToBrowserList.querySelectorAll('.tab-item:not([style*="display: none"]) input[type="checkbox"]:checked:not([disabled])');
  if (visibleCanvasCheckboxes.length > 0) {
    selectAllCanvas.checked = visibleCanvasCheckboxes.length === checkedCanvasCheckboxes.length;
    selectAllCanvas.indeterminate = checkedCanvasCheckboxes.length > 0 && checkedCanvasCheckboxes.length < visibleCanvasCheckboxes.length;
  } else {
    selectAllCanvas.checked = false;
    selectAllCanvas.indeterminate = false;
  }
}

// Event delegation for favicon error handling
function handleImageError(event) {
  const img = event.target;
  if (img && img.tagName === 'IMG' && img.classList.contains('tab-favicon')) {
    console.log('Favicon failed to load, using fallback:', img.src);
    const fallback = img.dataset.fallback || '../assets/icons/logo-br_64x64.png';
    if (img.src !== fallback) {
      img.src = fallback;
    }
  }
}

// URL formatting utilities
function formatContextUrl(workspaceName, contextPath) {
  if (!workspaceName || !contextPath) {
    return contextPath || '-';
  }

  // If contextPath already contains '://', extract the path part
  if (contextPath.includes('://')) {
    const pathPart = contextPath.split('://')[1] || '/';
    return `${workspaceName}://${pathPart}`;
  }

  // Ensure path starts with '/' then remove it for the final URL format
  const normalizedPath = contextPath.startsWith('/') ? contextPath : `/${contextPath}`;
  const pathWithoutLeadingSlash = normalizedPath.substring(1);
  // If path is just "/", pathWithoutLeadingSlash will be empty, which is correct for "workspace://"
  return `${workspaceName}://${pathWithoutLeadingSlash}`;
}

function parseContextUrl(contextUrl) {
  if (!contextUrl || !contextUrl.includes('://')) {
    return { workspaceName: null, path: contextUrl || '/' };
  }

  const [workspaceName, path] = contextUrl.split('://');
  return {
    workspaceName: workspaceName || null,
    path: path ? `/${path}` : '/' // Ensure path always starts with '/' for internal use
  };
}

function getWorkspaceName(workspace) {
  // Prioritize workspace.name specifically, only fall back to label, never use ID for URL
  if (!workspace) return 'unknown';

  // Ensure we're using the actual name, not ID
  const name = workspace.name || workspace.label;

  // Validate that name is not a UUID (in case there are still issues)
  if (name && !isUUID(name)) {
    return name;
  }

  return workspace.label || 'unknown';
}

function isUUID(str) {
  if (!str) return false;
  // UUID pattern: 8-4-4-4-12 hex chars with dashes
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidPattern.test(str);
}

// Utility functions
function createListSignature(items, mapItem) {
  return (items || []).map(mapItem).join('|');
}

function normalizeTabUrl(rawUrl) {
  const removeUtmParameters = currentSyncSettings?.removeUtmParameters !== false;
  if (!removeUtmParameters || !rawUrl || typeof rawUrl !== 'string') return rawUrl;

  try {
    const url = new URL(rawUrl);
    for (const key of Array.from(url.searchParams.keys())) {
      if (key.toLowerCase().startsWith('utm_')) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

async function sendMessageToBackground(type, data = null) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    // Cross-browser compatibility: Firefox uses 'browser', Chrome uses 'chrome'
    const runtime = (typeof browser !== 'undefined') ? browser.runtime : chrome.runtime;

    runtime.sendMessage({ type, data }, (response) => {
      const durationMs = Math.round(performance.now() - startedAt);
      popupRequestStats.count += 1;
      popupRequestStats.totalMs += durationMs;
      console.info(`Popup Timing: ${type} ${durationMs}ms`);
      const lastError = (typeof browser !== 'undefined') ? browser.runtime.lastError : chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// Special function for direct message sending (for messages that need specific format)
async function sendDirectMessageToBackground(message) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    // Cross-browser compatibility: Firefox uses 'browser', Chrome uses 'chrome'
    const runtime = (typeof browser !== 'undefined') ? browser.runtime : chrome.runtime;

    runtime.sendMessage(message, (response) => {
      const durationMs = Math.round(performance.now() - startedAt);
      popupRequestStats.count += 1;
      popupRequestStats.totalMs += durationMs;
      console.info(`Popup Timing: ${message?.type || 'direct'} ${durationMs}ms`);
      const lastError = (typeof browser !== 'undefined') ? browser.runtime.lastError : chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Secure DOM helper functions to replace unsafe innerHTML usage
function setSecureHtml(element, content) {
  // Clear existing content
  element.textContent = '';

  if (typeof content === 'string') {
    // Use DOMParser for secure HTML parsing - this is safe and handles complex HTML
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${content}</div>`, 'text/html');
    const container = doc.body.firstChild;

    // Security check: Remove any script tags or event handlers
    sanitizeHtmlContent(container);

    // Move all child nodes to the target element
    while (container.firstChild) {
      element.appendChild(container.firstChild);
    }
  } else if (content instanceof Node) {
    element.appendChild(content);
  }
}

// Sanitize HTML content to remove dangerous elements and attributes
function sanitizeHtmlContent(element) {
  // Remove script tags
  const scripts = element.querySelectorAll('script');
  scripts.forEach(script => script.remove());

  // Remove style tags
  const styles = element.querySelectorAll('style');
  styles.forEach(style => style.remove());

  // Remove all event handler attributes
  const allElements = element.querySelectorAll('*');
  allElements.forEach(el => {
    // Remove event handler attributes
    const attributes = [...el.attributes];
    attributes.forEach(attr => {
      if (attr.name.toLowerCase().startsWith('on')) {
        el.removeAttribute(attr.name);
      }
      // Remove javascript: urls
      if (attr.value && attr.value.toLowerCase().includes('javascript:')) {
        el.removeAttribute(attr.name);
      }
    });
  });
}

function createSecureElement(tagName, properties = {}, textContent = '') {
  const element = document.createElement(tagName);

  // Set properties safely
  Object.entries(properties).forEach(([key, value]) => {
    if (key === 'textContent') {
      element.textContent = value;
    } else if (key === 'className') {
      element.className = value;
    } else if (key.startsWith('data-')) {
      element.setAttribute(key, value);
    } else {
      element[key] = value;
    }
  });

  if (textContent) {
    element.textContent = textContent;
  }

  return element;
}

// Bulk action handlers
async function handleSyncAll() {
  try {
    console.log('🔧 handleSyncAll: Starting sync all operation');

    // Use ALL browser tabs, not just the currently filtered ones
    const allSyncableTabs = allBrowserTabs.filter(tab => {
      // Only sync tabs that aren't already synced and are syncable
      return !syncedTabIds.has(tab.id);
    });

    console.log('🔧 handleSyncAll: Tab filtering results:', {
      totalBrowserTabs: allBrowserTabs.length,
      syncedTabIds: Array.from(syncedTabIds),
      unsyncedTabs: allSyncableTabs.length
    });

    console.log('🔧 handleSyncAll: Sample tab data:', allBrowserTabs.slice(0, 2).map(tab => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      status: tab.status,
      discarded: tab.discarded,
      windowId: tab.windowId,
      active: tab.active
    })));

    if (allSyncableTabs.length === 0) {
      console.log('❌ handleSyncAll: No browser tabs to sync');
      return;
    }

    console.log(`🔧 handleSyncAll: Syncing ${allSyncableTabs.length} unsynced browser tabs out of ${allBrowserTabs.length} total`);
    console.log('🔧 handleSyncAll: Tab details:', allSyncableTabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url })));

    const tabIds = allSyncableTabs.map(tab => tab.id);
    console.log('🔧 handleSyncAll: Sending message to background with tabIds:', tabIds);

    const response = await sendMessageToBackground('SYNC_MULTIPLE_TABS', { tabIds });
    console.log('🔧 handleSyncAll: Received response from background:', response);

    if (response.success) {
      console.log(`Synced ${response.successful}/${response.total} tabs`);
      await loadTabs(); // Refresh lists
    } else {
      console.error('Failed to sync all tabs:', response.error);
    }
  } catch (error) {
    console.error('Failed to sync all tabs:', error);
  }
}

async function handleCloseAll() {
  try {
    console.log('Closing all browser tabs');

    if (browserTabs.length === 0) {
      console.log('No browser tabs to close');
      return;
    }

    const tabIds = browserTabs.map(tab => tab.id);
    await closeTabs(tabIds);

    console.log('All browser tabs closed');
  } catch (error) {
    console.error('Failed to close all tabs:', error);
  }
}

async function handleOpenAll() {
  try {
    console.log('Opening all Canvas tabs');

    const filteredCanvasTabs = getFilteredCanvasTabs();

    if (filteredCanvasTabs.length === 0) {
      console.log('No Canvas tabs to open');
      showToast('No tabs to open', 'info');
      return;
    }

    console.log(`Opening ${filteredCanvasTabs.length} Canvas tabs`);

    // Open tabs with better error handling using batch operation
    let opened = 0;
    let failed = 0;

    try {
      console.log('Opening all Canvas tabs in batch:', filteredCanvasTabs.length);

      // Use batch operation for multiple documents
      const response = await sendMessageToBackground('OPEN_CANVAS_DOCUMENT', {
        documents: filteredCanvasTabs
      });

      if (response.success) {
        opened = response.successful || 0;
        failed = response.failed || 0;
        const openedUrls = response.openedUrls || [];
        console.log(`Batch open completed: ${opened} opened, ${failed} failed`);
        console.log('Opened URLs:', openedUrls);

        if (opened > 0) {
          showToast(`Opened ${opened} of ${filteredCanvasTabs.length} tabs`, 'success');
          applyOpenedCanvasDocuments(response, filteredCanvasTabs);
        }
        if (failed > 0) {
          showToast(`${failed} tabs failed to open`, 'warning');
        }
      } else {
        failed = filteredCanvasTabs.length;
        console.error('Batch open failed:', response.error);
        showToast(`Failed to open tabs: ${response.error}`, 'error');
      }
    } catch (error) {
      failed = filteredCanvasTabs.length;
      console.error('Error in batch open:', error);
      showToast(`Error opening tabs: ${error.message}`, 'error');
    }

    console.log(`Opened ${opened} tabs, ${failed} failed`);
  } catch (error) {
    console.error('Failed to open all Canvas tabs:', error);
    showToast(`Error opening all tabs: ${error.message}`, 'error');
  }
}

async function closeTabs(tabIds) {
  if (!tabIds.length) return;
  const response = await sendMessageToBackground('CLOSE_TABS', { tabIds });
  if (!response?.success) throw new Error(response?.error || 'Failed to close tabs');
  applyClosedBrowserTabs(tabIds);
}

async function handleSyncWindow(windowId, closeAfterSync = false) {
  try {
    const tabIds = getUnsyncedTabIdsForWindow(windowId);
    console.log(`${closeAfterSync ? 'Syncing+closing' : 'Syncing'} window ${windowId} tabs:`, tabIds);

    if (tabIds.length === 0) return;

    const response = await sendMessageToBackground('SYNC_MULTIPLE_TABS', { tabIds });
    console.log('Sync window response:', response);

    if (!response.success) {
      console.error('Failed to sync window tabs:', response.error);
      return;
    }

    if (closeAfterSync) {
      await closeTabs(tabIds);
      selectedBrowserTabs.forEach(id => {
        if (tabIds.includes(id)) selectedBrowserTabs.delete(id);
      });
    } else {
      await loadTabs();
    }
  } catch (error) {
    console.error('Failed to sync window tabs:', error);
  }
}

async function handleCloseWindow(windowId) {
  try {
    console.log('Closing window:', windowId);
    const response = await sendMessageToBackground('CLOSE_WINDOW', { windowId });
    console.log('Close window response:', response);
    if (response?.success) {
      // Window is gone; refresh list state.
      selectedBrowserTabs.clear();
      await loadTabs();
    } else {
      console.error('Failed to close window:', response?.error);
    }
  } catch (error) {
    console.error('Failed to close window:', error);
  }
}

async function handleSyncSelected() {
  try {
    const selectedIds = Array.from(selectedBrowserTabs);
    console.log('Syncing selected tabs:', selectedIds);

    if (selectedIds.length === 0) {
      console.log('No tabs selected for syncing');
      return;
    }

    const response = await sendMessageToBackground('SYNC_MULTIPLE_TABS', { tabIds: selectedIds });
    console.log('Sync selected response:', response);

    if (response.success) {
      console.log(`Synced ${response.successful}/${response.total} selected tabs`);
      // Don't clear selections to allow multiple operations
      await loadTabs(); // Refresh lists
    } else {
      console.error('Failed to sync selected tabs:', response.error);
    }
  } catch (error) {
    console.error('Failed to sync selected tabs:', error);
  }
}

async function handleSyncAndCloseSelected() {
  try {
    const selectedIds = Array.from(selectedBrowserTabs);
    console.log('Syncing+closing selected tabs:', selectedIds);

    if (selectedIds.length === 0) {
      return;
    }

    const response = await sendMessageToBackground('SYNC_MULTIPLE_TABS', { tabIds: selectedIds });
    console.log('Sync+close selected response:', response);

    if (!response.success) {
      console.error('Failed to sync selected tabs:', response.error);
      return;
    }

    await closeTabs(selectedIds);
    selectedBrowserTabs.clear();
  } catch (error) {
    console.error('Failed to sync+close selected tabs:', error);
  }
}

async function handleCloseSelected() {
  try {
    const selectedIds = Array.from(selectedBrowserTabs);
    console.log('Closing selected tabs:', selectedIds);

    if (selectedIds.length === 0) {
      console.log('No tabs selected for closing');
      return;
    }

    await closeTabs(selectedIds);

    console.log('Selected browser tabs closed');
  } catch (error) {
    console.error('Failed to close selected tabs:', error);
  }
}

async function handleOpenSelected() {
  try {
    const selectedIds = Array.from(selectedCanvasTabs);
    console.log('Opening selected Canvas tabs:', selectedIds);

    if (selectedIds.length === 0) {
      console.log('No Canvas tabs selected for opening');
      showToast('No tabs selected', 'warning');
      return;
    }

    // Collect all selected documents
    console.log('🔧 Selected IDs:', selectedIds);
    console.log('🔧 Available canvasTabs:', canvasTabs.length);

    const documentsToOpen = selectedIds
      .map(documentId => {
        const doc = canvasTabs.find(doc => doc.id === documentId);
        if (!doc) {
          console.warn(`🔧 Document not found for ID: ${documentId}`);
        }
        return doc;
      })
      .filter(doc => doc !== undefined);

    console.log('🔧 Documents to open:', documentsToOpen.map(doc => ({
      id: doc.id,
      title: doc.data?.title,
      url: doc.data?.url
    })));

    if (documentsToOpen.length > 0) {
      console.log('Opening selected documents in batch:', documentsToOpen.length);

      // Use batch operation for multiple documents
      const response = await sendMessageToBackground('OPEN_CANVAS_DOCUMENT', {
        documents: documentsToOpen
      });

      console.log('🔧 Batch open response:', response);

      if (response.success) {
        console.log(`Successfully opened ${response.successful}/${response.total} documents`);
        showToast(`Opened ${response.successful} of ${response.total} tabs`, 'success');
        if (response.successful > 0) {
          applyOpenedCanvasDocuments(response, documentsToOpen);
        }
      } else {
        console.error('Failed to open documents:', response.error);
        showToast(`Failed to open tabs: ${response.error}`, 'error');
      }
    }

    console.log('Selected Canvas tabs opened');
    selectedCanvasTabs.clear();
  } catch (error) {
    console.error('Failed to open selected Canvas tabs:', error);
    showToast(`Error opening tabs: ${error.message}`, 'error');
  }
}

async function handleRemoveSelected() {
  try {
    const selectedIds = Array.from(selectedCanvasTabs);
    console.log('Removing selected Canvas tabs:', selectedIds);

    if (selectedIds.length === 0) {
      console.log('No Canvas tabs selected for removal');
      return;
    }

    const documents = selectedIds
      .map(documentId => canvasTabs.find(doc => doc.id === documentId))
      .filter(Boolean);
    const response = await sendMessageToBackground('REMOVE_CANVAS_DOCUMENTS', {
      documents,
      closeTab: false
    });
    if (!response.success) throw new Error(response.error || 'Failed to remove selected Canvas tabs');

    console.log('Selected Canvas tabs removed');
    applyRemovedCanvasDocuments(selectedIds);
  } catch (error) {
    console.error('Failed to remove selected Canvas tabs:', error);
  }
}

async function handleDeleteSelected() {
  try {
    const selectedIds = Array.from(selectedCanvasTabs);
    console.log('Deleting selected Canvas tabs:', selectedIds);

    if (selectedIds.length === 0) {
      console.log('No Canvas tabs selected for deletion');
      return;
    }

    const documents = selectedIds
      .map(documentId => canvasTabs.find(doc => doc.id === documentId))
      .filter(Boolean);
    const response = await sendMessageToBackground('REMOVE_CANVAS_DOCUMENTS', {
      documents,
      closeTab: true
    });
    if (!response.success) throw new Error(response.error || 'Failed to delete selected Canvas tabs');

    console.log('Selected Canvas tabs deleted');
    applyRemovedCanvasDocuments(selectedIds);
  } catch (error) {
    console.error('Failed to delete selected Canvas tabs:', error);
  }
}

// Add showToast function
function showToast(message, type = 'info') {
  if (!toast) return console.log(message); // Fallback

  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.style.display = 'block';

  setTimeout(() => {
    toast.style.display = 'none';
  }, 5000);
}

function removeSessionExpiredBanner() {
  const existing = document.getElementById('session-expired-banner');
  if (existing) existing.remove();
}

function showSessionExpiredBanner(text = 'Session expired — tabs are no longer being synced.') {
  const existing = document.getElementById('session-expired-banner');
  if (existing) return;

  const banner = document.createElement('div');
  banner.id = 'session-expired-banner';
  banner.style.cssText = 'background:#7f1d1d;color:#fecaca;padding:8px 12px;font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:8px;';

  const msg = document.createElement('span');
  msg.textContent = text;
  banner.appendChild(msg);

  const btn = document.createElement('button');
  btn.textContent = 'Reconnect';
  btn.style.cssText = 'background:#dc2626;color:#fff;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px;white-space:nowrap;';
  btn.addEventListener('click', openSettingsPage);
  banner.appendChild(btn);

  const container = document.getElementById('viewContainer');
  if (container) container.prepend(banner);
}

// ---- Session expiry awareness ----------------------------------------------
// JWT sessions are auto-renewed by the service worker; this only surfaces state
// to the user. If a renewal can't happen (offline near expiry), warn proactively.
let sessionInfoTimer = null;

function formatDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function showSessionWarningBanner(text) {
  // Reuse the expired banner slot but with a softer (amber) treatment.
  let banner = document.getElementById('session-expired-banner');
  if (banner && banner.dataset.kind !== 'warning') return; // don't override a hard-expired banner
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'session-expired-banner';
    banner.dataset.kind = 'warning';
    banner.style.cssText = 'background:#78350f;color:#fde68a;padding:8px 12px;font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:8px;';
    const msg = document.createElement('span');
    msg.className = 'session-warning-msg';
    banner.appendChild(msg);
    const btn = document.createElement('button');
    btn.textContent = 'Reconnect';
    btn.style.cssText = 'background:#d97706;color:#fff;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px;white-space:nowrap;';
    btn.addEventListener('click', openSettingsPage);
    banner.appendChild(btn);
    const container = document.getElementById('viewContainer');
    if (container) container.prepend(banner);
  }
  const msgEl = banner.querySelector('.session-warning-msg');
  if (msgEl) msgEl.textContent = text;
}

async function refreshSessionInfo() {
  try {
    const info = await sendMessageToBackground('GET_SESSION_INFO');
    if (!info?.success || !info.connected) return;

    // Non-expiring API token, or auto-renew handles JWTs comfortably: nothing to show.
    if (info.tokenType !== 'jwt' || info.expiresInMs == null) return;

    // Only warn if expiry is imminent AND auto-renew hasn't kicked in yet
    // (e.g. the browser was offline). Otherwise stay quiet.
    const WARN_THRESHOLD_MS = 6 * 60 * 1000;
    const existingHardBanner = document.getElementById('session-expired-banner')?.dataset.kind !== 'warning'
      && document.getElementById('session-expired-banner');
    if (info.expiresInMs <= 0) {
      if (!existingHardBanner) showSessionExpiredBanner();
    } else if (info.expiresInMs <= WARN_THRESHOLD_MS) {
      showSessionWarningBanner(`Session expires in ${formatDuration(info.expiresInMs)}. Renewing…`);
    } else {
      // Plenty of time left — clear any stale warning banner.
      const banner = document.getElementById('session-expired-banner');
      if (banner && banner.dataset.kind === 'warning') banner.remove();
    }
  } catch (error) {
    console.warn('Failed to refresh session info:', error);
  }
}

function startSessionInfoPolling() {
  if (sessionInfoTimer) clearInterval(sessionInfoTimer);
  refreshSessionInfo();
  // Light cadence; the SW does the actual renewal, this is purely informational.
  sessionInfoTimer = setInterval(refreshSessionInfo, 60 * 1000);
}

// ===================================
// SYNC TO PANEL
// ===================================

function handleSyncToAll() {
  const tabIds = browserTabs.filter(t => !syncedTabIds.has(t.id)).map(t => t.id);
  if (tabIds.length > 0) openSyncToPanel(tabIds);
}

function handleSyncToSelected() {
  const tabIds = Array.from(selectedBrowserTabs);
  if (tabIds.length > 0) openSyncToPanel(tabIds);
}

async function openSyncToPanel(tabIds) {
  syncToPendingTabIds = tabIds;
  syncToSelectedPaths.clear();
  updateSyncToConfirmBtn();

  try {
    if (currentConnection.mode === 'context' && currentConnection.context) {
      const response = await sendMessageToBackground('GET_CONTEXT_TREE', { contextId: currentConnection.context.id });
      if (response.success) treeData = response.tree;
    } else if (currentConnection.mode === 'explorer' && currentConnection.workspace) {
      const wsId = currentConnection.workspace.name || currentConnection.workspace.id;
      const response = await sendMessageToBackground('GET_WORKSPACE_TREE', { workspaceIdOrName: wsId });
      if (response.success) treeData = response.tree;
    }
  } catch (error) {
    console.error('Failed to load tree for Sync To:', error);
  }

  renderSyncToTree();
  syncToOverlay.classList.add('open');
}

function closeSyncToPanel() {
  syncToOverlay.classList.remove('open');
  syncToPendingTabIds = [];
  syncToSelectedPaths.clear();
}

function updateSyncToConfirmBtn() {
  const count = syncToSelectedPaths.size;
  syncToCount.textContent = `${count} path${count !== 1 ? 's' : ''} selected`;
  syncToConfirmBtn.disabled = count === 0;
  syncToConfirmBtn.textContent = count > 0 ? `Sync to ${count} path${count !== 1 ? 's' : ''}` : 'Sync';
}

async function handleSyncToConfirm() {
  const paths = Array.from(syncToSelectedPaths);
  const tabIds = syncToPendingTabIds;
  if (paths.length === 0 || tabIds.length === 0) return;

  closeSyncToPanel();

  try {
    for (const path of paths) {
      const response = await sendMessageToBackground('SYNC_MULTIPLE_TABS', { tabIds, contextSpec: path });
      if (!response.success) {
        console.error(`Failed to sync to path ${path}:`, response.error);
      }
    }
    showToast(`Synced ${tabIds.length} tab(s) to ${paths.length} path(s)`, 'success');
    await loadTabs();
  } catch (error) {
    console.error('Sync To failed:', error);
    showToast('Sync To failed: ' + error.message, 'error');
  }
}

function renderSyncToTree() {
  if (!treeData) {
    const emptyDiv = createSecureElement('div', { className: 'empty-state' }, 'No tree data available');
    syncToTree.textContent = '';
    syncToTree.appendChild(emptyDiv);
    return;
  }

  const html = renderSyncToTreeNode(treeData, '', 0);
  syncToTree.textContent = '';
  setSecureHtml(syncToTree, html);
  setupSyncToTreeListeners();
}

function renderSyncToTreeNode(node, parentPath, level) {
  const currentPath = level === 0 ? '/' : (parentPath === '/' ? `/${node.name}` : `${parentPath}/${node.name}`);
  const hasChildren = node.children && node.children.length > 0;
  const isChecked = syncToSelectedPaths.has(currentPath);
  const isRoot = level === 0;

  let html = '';

  if (isRoot) {
    html += `
      <div class="tree-node ${isChecked ? 'checked' : ''}" data-path="/" style="padding-left: 4px">
        <input type="checkbox" class="tree-checkbox" data-path="/" ${isChecked ? 'checked' : ''}>
        <div class="expand-btn"></div>
        <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        ${node.color && node.color !== '#fff' ? `<div class="color-indicator" style="background-color: ${node.color}"></div>` : ''}
        <span class="node-label">/</span>
      </div>
    `;
  }

  if (hasChildren) {
    if (isRoot) html += '<div class="tree-children">';

    for (const child of node.children) {
      const childPath = currentPath === '/' ? `/${child.name}` : `${currentPath}/${child.name}`;
      const childChecked = syncToSelectedPaths.has(childPath);
      const childHasChildren = child.children && child.children.length > 0;

      html += `
        <div class="tree-node ${childChecked ? 'checked' : ''}" data-path="${childPath}" style="padding-left: ${(level + 1) * 20 + 4}px">
          <input type="checkbox" class="tree-checkbox" data-path="${childPath}" ${childChecked ? 'checked' : ''}>
          <button class="expand-btn" ${!childHasChildren ? 'style="visibility: hidden;"' : ''}>
            ${childHasChildren ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>' : ''}
          </button>
          <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          ${child.color && child.color !== '#fff' ? `<div class="color-indicator" style="background-color: ${child.color}"></div>` : ''}
          <span class="node-label">${child.label || child.name}</span>
        </div>
      `;

      if (childHasChildren) {
        html += '<div class="tree-children" style="display: none;">';
        html += renderSyncToTreeNode(child, currentPath, level + 1);
        html += '</div>';
      }
    }

    if (isRoot) html += '</div>';
  }

  return html;
}

function setupSyncToTreeListeners() {
  syncToTree.addEventListener('click', (event) => {
    const expandBtn = event.target.closest('.expand-btn');
    if (expandBtn && expandBtn.querySelector('svg')) {
      event.stopPropagation();
      const node = expandBtn.closest('.tree-node');
      const children = node.nextElementSibling;
      if (children && children.classList.contains('tree-children')) {
        const isExpanded = children.style.display !== 'none';
        children.style.display = isExpanded ? 'none' : 'block';
        expandBtn.querySelector('svg').style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
      }
      return;
    }

    const treeNode = event.target.closest('.tree-node');
    if (!treeNode) return;

    const path = treeNode.dataset.path;
    const cb = treeNode.querySelector('.tree-checkbox');
    if (!cb) return;

    if (!event.target.closest('.tree-checkbox')) {
      cb.checked = !cb.checked;
    }

    if (cb.checked) {
      syncToSelectedPaths.add(path);
      treeNode.classList.add('checked');
    } else {
      syncToSelectedPaths.delete(path);
      treeNode.classList.remove('checked');
    }
    updateSyncToConfirmBtn();
  });
}

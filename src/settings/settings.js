// Canvas Extension Settings JavaScript
// Handles settings page interactions and configuration management

// DOM elements
let browserIdentity, serverUrl, apiBasePath, apiToken;
let authModeToken, authModeCredentials, apiTokenGroup, credentialsGroup, authEmail, authPassword;
let testConnectionBtn, connectBtn, disconnectBtn;
let statusDot, statusText, statusDetails;
let userInfo, userName, userServer;
let syncModeSection, syncModeSelect;
let explorerSettings, workspaceSelect;
let contextSettings, contextSelect, bindContextBtn;
let currentContext, boundContextId, boundContextUrl;
let openTabsAddedToCanvas, closeTabsRemovedFromCanvas, sendNewTabsToCanvas, removeClosedTabsFromCanvas;
let removeUtmParameters;
let contextUnloadBehavior, stashOptions, stashDiscardTabs, firefoxHideStashedTabs, chromiumStashGroupName, canvasTabsFetchLimit;
let preferredTreeType, treeOverridesGroup, treeOverridesList;
let syncOnlyCurrentBrowser, syncOnlyTaggedTabs, syncTagFilter;
let resetSettingsBtn;
let refreshTabSyncDebugBtn, copyTabSyncDebugBtn, tabSyncDebugSummary, tabSyncDebugOutput;
let toast;
let saveIndicator, statusDotPanel, statusTextPanel, syncDisconnectedNotice;
let autoSaveTimer = null;

// State
let currentAuthMode = 'token';
let isConnected = false;
let isBoundToContext = false;
let availableContexts = [];
let availableWorkspaces = [];
let settings = {};
let currentMode = 'explorer';
let treeOverrides = {}; // { [workspaceId]: 'context' | 'directory' }
let lastTabSyncDebug = null;

// Initialize settings page
document.addEventListener('DOMContentLoaded', async () => {
  initializeElements();
  setupEventListeners();
  setupStorageListeners();
  try {
    const extApi = (typeof browser !== 'undefined' && browser.runtime) ? browser : (typeof chrome !== 'undefined' ? chrome : null);
    const version = extApi?.runtime?.getManifest?.().version;
    const versionEl = document.getElementById('extVersion');
    if (version && versionEl) {
      versionEl.textContent = `Version ${version}`;
    }
  } catch {
    // ignore
  }
  await loadSettings();
  await checkInitialConnection();
  await refreshTabSyncDebug();
});

function initializeElements() {
  // Connection settings
  browserIdentity = document.getElementById('browserIdentity');
  serverUrl = document.getElementById('serverUrl');
  apiBasePath = document.getElementById('apiBasePath');
  apiToken = document.getElementById('apiToken');
  authModeToken = document.getElementById('authModeToken');
  authModeCredentials = document.getElementById('authModeCredentials');
  apiTokenGroup = document.getElementById('apiTokenGroup');
  credentialsGroup = document.getElementById('credentialsGroup');
  authEmail = document.getElementById('authEmail');
  authPassword = document.getElementById('authPassword');

  // Connection controls

  testConnectionBtn = document.getElementById('testConnectionBtn');
  connectBtn = document.getElementById('connectBtn');
  disconnectBtn = document.getElementById('disconnectBtn');

  // Connection status (header pill + panel)
  statusDot = document.getElementById('statusDot');
  statusText = document.getElementById('statusText');
  statusDotPanel = document.getElementById('statusDotPanel');
  statusTextPanel = document.getElementById('statusTextPanel');
  statusDetails = document.getElementById('statusDetails');
  saveIndicator = document.getElementById('saveIndicator');
  syncDisconnectedNotice = document.getElementById('syncDisconnectedNotice');
  userInfo = document.getElementById('userInfo');
  userName = document.getElementById('userName');
  userServer = document.getElementById('userServer');

  // Sync mode and per-mode settings
  syncModeSection = document.getElementById('syncModeSection');
  syncModeSelect = document.getElementById('syncModeSelect');
  explorerSettings = document.getElementById('explorerSettings');
  workspaceSelect = document.getElementById('workspaceSelect');
  contextSettings = document.getElementById('contextSettings');
  contextSelect = document.getElementById('contextSelect');
  bindContextBtn = document.getElementById('bindContextBtn');
  currentContext = document.getElementById('currentContext');
  boundContextId = document.getElementById('boundContextId');
  boundContextUrl = document.getElementById('boundContextUrl');

  // Sync settings
  openTabsAddedToCanvas = document.getElementById('openTabsAddedToCanvas');
  closeTabsRemovedFromCanvas = document.getElementById('closeTabsRemovedFromCanvas');
  sendNewTabsToCanvas = document.getElementById('sendNewTabsToCanvas');
  removeClosedTabsFromCanvas = document.getElementById('removeClosedTabsFromCanvas');
  removeUtmParameters = document.getElementById('removeUtmParameters');
  contextUnloadBehavior = document.getElementById('contextUnloadBehavior');
  stashOptions = document.getElementById('stashOptions');
  stashDiscardTabs = document.getElementById('stashDiscardTabs');
  firefoxHideStashedTabs = document.getElementById('firefoxHideStashedTabs');
  chromiumStashGroupName = document.getElementById('chromiumStashGroupName');
  canvasTabsFetchLimit = document.getElementById('canvasTabsFetchLimit');
  preferredTreeType = document.getElementById('preferredTreeType');
  treeOverridesGroup = document.getElementById('treeOverridesGroup');
  treeOverridesList = document.getElementById('treeOverridesList');

  // Sync filtering options
  syncOnlyCurrentBrowser = document.getElementById('syncOnlyCurrentBrowser');
  syncOnlyTaggedTabs = document.getElementById('syncOnlyTaggedTabs');
  syncTagFilter = document.getElementById('syncTagFilter');

  // Action buttons
  resetSettingsBtn = document.getElementById('resetSettingsBtn');
  refreshTabSyncDebugBtn = document.getElementById('refreshTabSyncDebugBtn');
  copyTabSyncDebugBtn = document.getElementById('copyTabSyncDebugBtn');
  tabSyncDebugSummary = document.getElementById('tabSyncDebugSummary');
  tabSyncDebugOutput = document.getElementById('tabSyncDebugOutput');

  // Toast
  toast = document.getElementById('toast');
}

function setupEventListeners() {
  // Auth mode toggle
  authModeToken.addEventListener('change', handleAuthModeChange);
  authModeCredentials.addEventListener('change', handleAuthModeChange);

  // Connection buttons
  testConnectionBtn.addEventListener('click', handleTestConnection);
  connectBtn.addEventListener('click', handleConnect);
  disconnectBtn.addEventListener('click', handleDisconnect);

  // Context buttons
  bindContextBtn.addEventListener('click', handleBindContext);

  // Mode change
  syncModeSelect.addEventListener('change', handleModeChange);

  // Workspace selection change
  workspaceSelect.addEventListener('change', async () => {
    if (currentMode === 'explorer') {
      const wsId = workspaceSelect.value;
      let selectedWorkspace = null;
      if (wsId) {
        selectedWorkspace = availableWorkspaces.find(w => w.id === wsId) || null;
      }
      // Reset path to root when changing workspace and trigger path change behavior
      await sendMessageToBackground('SET_MODE_AND_SELECTION', { mode: 'explorer', workspace: selectedWorkspace, workspacePath: '/' });
      showToast(`Switched to workspace: ${selectedWorkspace?.label || selectedWorkspace?.name || wsId}`, 'success');
    }
  });

  // Settings buttons
  resetSettingsBtn.addEventListener('click', handleResetSettings);
  refreshTabSyncDebugBtn.addEventListener('click', refreshTabSyncDebug);
  copyTabSyncDebugBtn.addEventListener('click', copyTabSyncDebug);

  // Tab navigation
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Auto-generate browser identity if empty
  browserIdentity.addEventListener('blur', handleBrowserIdentityBlur);

  // Sync filtering options
  syncOnlyTaggedTabs.addEventListener('change', () => {
    syncTagFilter.disabled = !syncOnlyTaggedTabs.checked;
    if (!syncOnlyTaggedTabs.checked) {
      syncTagFilter.value = '';
    }
  });

  contextUnloadBehavior.addEventListener('change', updateUnloadOptionsVisibility);

  // Auto-save every sync setting on change
  const syncControls = [
    openTabsAddedToCanvas, closeTabsRemovedFromCanvas, sendNewTabsToCanvas,
    removeClosedTabsFromCanvas, removeUtmParameters, contextUnloadBehavior,
    stashDiscardTabs, firefoxHideStashedTabs, syncOnlyCurrentBrowser, syncOnlyTaggedTabs,
    preferredTreeType
  ];
  syncControls.forEach((el) => el?.addEventListener('change', scheduleAutoSave));

  // Text/number inputs: save on change (blur/enter), debounced on input
  [chromiumStashGroupName, syncTagFilter, canvasTabsFetchLimit].forEach((el) => {
    el?.addEventListener('change', scheduleAutoSave);
    el?.addEventListener('input', scheduleAutoSave);
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}

// ---- Auto-save -------------------------------------------------------------
function collectSyncSettings() {
  return {
    openTabsAddedToCanvas: openTabsAddedToCanvas.checked,
    closeTabsRemovedFromCanvas: closeTabsRemovedFromCanvas.checked,
    sendNewTabsToCanvas: sendNewTabsToCanvas.checked,
    removeClosedTabsFromCanvas: removeClosedTabsFromCanvas.checked,
    removeUtmParameters: removeUtmParameters?.checked ?? true,
    contextUnloadBehavior: contextUnloadBehavior.value,
    stashDiscardTabs: stashDiscardTabs.checked,
    firefoxHideStashedTabs: firefoxHideStashedTabs.checked,
    chromiumStashGroupName: chromiumStashGroupName.value.trim() || 'Stashed',
    canvasTabsFetchLimit: normalizeCanvasTabsFetchLimit(canvasTabsFetchLimit.value),
    syncOnlyCurrentBrowser: syncOnlyCurrentBrowser.checked,
    syncOnlyTaggedTabs: syncOnlyTaggedTabs.checked,
    syncTagFilter: syncTagFilter.value.trim(),
    preferredTreeType: preferredTreeType.value || 'context',
    workspaceTreeOverrides: { ...treeOverrides }
  };
}

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(autoSaveSyncSettings, 350);
}

async function autoSaveSyncSettings() {
  const payload = collectSyncSettings();
  settings.syncSettings = { ...settings.syncSettings, ...payload };
  try {
    const res = await sendMessageToBackground('SET_SYNC_SETTINGS', payload);
    if (res?.success) {
      flashSaved();
    } else {
      showToast(`Failed to save: ${res?.error || 'unknown error'}`, 'error');
    }
  } catch (error) {
    showToast(`Failed to save: ${error.message}`, 'error');
  }
}

function flashSaved() {
  if (!saveIndicator) return;
  saveIndicator.classList.add('show');
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => saveIndicator.classList.remove('show'), 1500);
}



function handleAuthModeChange() {
  currentAuthMode = authModeCredentials.checked ? 'credentials' : 'token';
  updateAuthModeVisibility(currentAuthMode);
}

function updateAuthModeVisibility(mode) {
  if (apiTokenGroup) apiTokenGroup.style.display = mode === 'credentials' ? 'none' : 'block';
  if (credentialsGroup) credentialsGroup.style.display = mode === 'credentials' ? 'block' : 'none';
}

async function loadSettings() {
  try {
    console.log('Loading settings from background service worker...');

    // Get connection status and settings from background
    const response = await sendMessageToBackground('GET_CONNECTION_STATUS');
    console.log('Loaded settings response:', response);

    // Get sync settings separately
    const syncResponse = await sendMessageToBackground('GET_SYNC_SETTINGS');
    console.log('Loaded sync settings response:', syncResponse);

    // Get mode and selection
    const modeSelResponse = await sendMessageToBackground('GET_MODE_AND_SELECTION');
    console.log('Loaded mode/selection response:', modeSelResponse);

    // Use actual saved settings, with defaults only as fallback
    const savedConnectionSettings = response.settings || {};
    const savedSyncSettings = syncResponse.success ? syncResponse.settings : {};

    settings = {
      connectionSettings: {
        serverUrl: savedConnectionSettings.serverUrl || 'https://my.cnvs.ai',
        apiBasePath: savedConnectionSettings.apiBasePath || '/rest/v2',
        apiToken: savedConnectionSettings.apiToken || '',
        authMode: savedConnectionSettings.authMode || 'token',
        email: savedConnectionSettings.email || '',
        connected: savedConnectionSettings.connected || false
      },
      syncSettings: {
        openTabsAddedToCanvas: savedSyncSettings.openTabsAddedToCanvas || false,
        closeTabsRemovedFromCanvas: savedSyncSettings.closeTabsRemovedFromCanvas || false,
        sendNewTabsToCanvas: savedSyncSettings.sendNewTabsToCanvas || false,
        removeClosedTabsFromCanvas: savedSyncSettings.removeClosedTabsFromCanvas || false,
        removeUtmParameters: savedSyncSettings.removeUtmParameters ?? true,
        contextUnloadBehavior: savedSyncSettings.contextUnloadBehavior || 'close',
        stashDiscardTabs: savedSyncSettings.stashDiscardTabs ?? true,
        firefoxHideStashedTabs: savedSyncSettings.firefoxHideStashedTabs ?? true,
        chromiumStashGroupName: savedSyncSettings.chromiumStashGroupName || 'Stashed',
        canvasTabsFetchLimit: savedSyncSettings.canvasTabsFetchLimit || 200,
        syncOnlyCurrentBrowser: savedSyncSettings.syncOnlyCurrentBrowser || false,
        syncOnlyTaggedTabs: savedSyncSettings.syncOnlyTaggedTabs || false,
        syncTagFilter: savedSyncSettings.syncTagFilter || '',
        preferredTreeType: savedSyncSettings.preferredTreeType || 'context',
        workspaceTreeOverrides: savedSyncSettings.workspaceTreeOverrides || {}
      },
      browserIdentity: response.browserIdentity || getDefaultBrowserIdentity(),
      currentContext: (modeSelResponse.success ? modeSelResponse.context : null) || (response.context || null),
      currentWorkspace: modeSelResponse.success ? modeSelResponse.workspace : null,
      mode: modeSelResponse.success ? (modeSelResponse.mode || 'explorer') : 'explorer',
      user: response.user || null
    };

    // Set connection state
    isConnected = response.connected || false;
    currentMode = settings.mode;

    populateForm();

    // Load contexts and workspaces if connected
    if (isConnected) {
      await Promise.all([
        loadContexts(),
        loadWorkspaces()
      ]);

      // Preselect dropdowns if values exist - this will be handled in populate functions
    }

  } catch (error) {
    console.error('Failed to load settings:', error);
    showToast('Failed to load settings', 'error');

    // Use defaults on error
    settings = {
      connectionSettings: {
        serverUrl: 'https://my.cnvs.ai',
        apiBasePath: '/rest/v2',
        apiToken: '',
        connected: false
      },
      syncSettings: {
        openTabsAddedToCanvas: false,
        closeTabsRemovedFromCanvas: false,
        sendNewTabsToCanvas: false,
        removeClosedTabsFromCanvas: false,
        removeUtmParameters: true,
        contextUnloadBehavior: 'close',
        stashDiscardTabs: true,
        firefoxHideStashedTabs: true,
        chromiumStashGroupName: 'Stashed',
        canvasTabsFetchLimit: 200
      },
      browserIdentity: getDefaultBrowserIdentity(),
      currentContext: null
    };
    populateForm();
  }
}

function populateForm() {
  // Connection settings
  serverUrl.value = settings.connectionSettings.serverUrl;
  apiBasePath.value = settings.connectionSettings.apiBasePath;
  apiToken.value = settings.connectionSettings.apiToken;

  // Auth mode
  currentAuthMode = settings.connectionSettings.authMode || 'token';
  if (authModeToken) authModeToken.checked = currentAuthMode === 'token';
  if (authModeCredentials) authModeCredentials.checked = currentAuthMode === 'credentials';
  // Refill the saved email (password is never persisted)
  if (authEmail) authEmail.value = settings.connectionSettings.email || '';
  updateAuthModeVisibility(currentAuthMode);
  browserIdentity.value = settings.browserIdentity || getDefaultBrowserIdentity();

  // Sync settings
  openTabsAddedToCanvas.checked = settings.syncSettings.openTabsAddedToCanvas;
  closeTabsRemovedFromCanvas.checked = settings.syncSettings.closeTabsRemovedFromCanvas;
  sendNewTabsToCanvas.checked = settings.syncSettings.sendNewTabsToCanvas;
  removeClosedTabsFromCanvas.checked = settings.syncSettings.removeClosedTabsFromCanvas;
  if (removeUtmParameters) removeUtmParameters.checked = settings.syncSettings.removeUtmParameters ?? true;
  contextUnloadBehavior.value = settings.syncSettings.contextUnloadBehavior || 'close';
  stashDiscardTabs.checked = settings.syncSettings.stashDiscardTabs ?? true;
  firefoxHideStashedTabs.checked = settings.syncSettings.firefoxHideStashedTabs ?? true;
  chromiumStashGroupName.value = settings.syncSettings.chromiumStashGroupName || 'Stashed';
  canvasTabsFetchLimit.value = String(normalizeCanvasTabsFetchLimit(settings.syncSettings.canvasTabsFetchLimit));
  updateUnloadOptionsVisibility();

  // Sync filtering options
  syncOnlyCurrentBrowser.checked = settings.syncSettings.syncOnlyCurrentBrowser;
  syncOnlyTaggedTabs.checked = settings.syncSettings.syncOnlyTaggedTabs;
  syncTagFilter.value = settings.syncSettings.syncTagFilter;
  syncTagFilter.disabled = !settings.syncSettings.syncOnlyTaggedTabs;

  // Workspace tree preference
  if (preferredTreeType) preferredTreeType.value = settings.syncSettings.preferredTreeType || 'context';
  treeOverrides = { ...(settings.syncSettings.workspaceTreeOverrides || {}) };
  renderTreeOverrides();

  // Update connection status
  updateConnectionStatus(settings.connectionSettings.connected);

  // Sync mode UI
  syncModeSection.style.display = isConnected ? 'block' : 'none';
  syncModeSelect.value = settings.mode || 'explorer';
  updateModeVisibility(syncModeSelect.value);

  // Show current context if exists and in context mode
  if (settings.currentContext && (settings.mode === 'context')) {
    boundContextId.textContent = settings.currentContext.id;
    boundContextUrl.textContent = settings.currentContext.url || '-';
    currentContext.style.display = 'block';
  } else if (currentContext) {
    currentContext.style.display = 'none';
  }
}

async function checkInitialConnection() {
  if (settings.connectionSettings.connected && settings.connectionSettings.apiToken) {
    await handleTestConnection();
  }
}

async function handleTestConnection() {
  try {
    setButtonLoading(testConnectionBtn, true);

    // In credentials mode, only do a fresh login if email+password are entered.
    // Otherwise fall back to the stored JWT (e.g. on initial connection check at startup).
    const freshCredentials = currentAuthMode === 'credentials' && authEmail.value.trim() && authPassword.value;
    const connectionData = {
      serverUrl: serverUrl.value.trim(),
      apiBasePath: apiBasePath.value.trim(),
      apiToken: freshCredentials ? '' : (apiToken.value.trim() || settings.connectionSettings.apiToken || ''),
      authMode: freshCredentials ? 'credentials' : 'token',
      email: freshCredentials ? authEmail.value.trim() : undefined,
      password: freshCredentials ? authPassword.value : undefined
    };

    console.log('Testing connection with:', { ...connectionData, password: '[redacted]' });

    // Send test connection request to background
    const response = await sendMessageToBackground('TEST_CONNECTION', connectionData);
    console.log('Connection test response:', response);

    if (response.success) {
      // Only show connected status if BOTH connection AND authentication succeed
      const isFullyConnected = response.connected && response.authenticated;
      updateConnectionStatus(isFullyConnected);

      if (response.authenticated) {
        showToast('✅ Connection and authentication successful!', 'success');

        // Show authentication details if available
        if (response.user) {
          const userInfo = response.user.name || response.user.email || 'User';
          showToast(`🔐 Authenticated as: ${userInfo}`, 'info');
        }

        // Load contexts and workspaces if authenticated
        await Promise.all([
          loadContexts(),
          loadWorkspaces()
        ]);
      } else if (response.connected) {
        showToast('⚠️ Server reachable but authentication failed - check API token', 'warning');
      } else {
        showToast('❌ Server connection failed', 'error');
      }
    } else {
      updateConnectionStatus(false);
      showToast(`❌ Connection test failed: ${response.error}`, 'error');
    }

  } catch (error) {
    console.error('Connection test failed:', error);
    updateConnectionStatus(false);
    showToast(`Connection test failed: ${error.message}`, 'error');
  } finally {
    setButtonLoading(testConnectionBtn, false);
  }
}

async function handleConnect() {
  try {
    setButtonLoading(connectBtn, true);

    // Validate form
    if (!validateConnectionForm()) {
      setButtonLoading(connectBtn, false);
      return;
    }

    // Generate browser identity if not set
    if (!browserIdentity.value.trim()) {
      await generateBrowserIdentity();
    }

    const connectionData = {
      serverUrl: serverUrl.value.trim(),
      apiBasePath: apiBasePath.value.trim(),
      apiToken: currentAuthMode === 'token' ? apiToken.value.trim() : '',
      authMode: currentAuthMode,
      email: currentAuthMode === 'credentials' ? authEmail.value.trim() : undefined,
      password: currentAuthMode === 'credentials' ? authPassword.value : undefined,
      browserIdentity: browserIdentity.value.trim()
    };

    console.log('Connecting with:', { ...connectionData, password: '[redacted]' });

    // Send connect request to background
    const response = await sendMessageToBackground('CONNECT', connectionData);
    console.log('Connect response:', response);

    if (response.success && response.authenticated) {
      isConnected = true;
      settings.user = response.user || null;
      // Store the resolved token (may be a JWT obtained from credentials login)
      if (response.apiToken) {
        settings.connectionSettings.apiToken = response.apiToken;
        settings.connectionSettings.authMode = currentAuthMode;
      }
      // Remember the email so it refills on reopen. The password is never stored;
      // reconnect relies on the JWT saved above.
      if (currentAuthMode === 'credentials') {
        settings.connectionSettings.email = authEmail.value.trim();
      }
      updateConnectionStatus(true);

      if (response.user) {
        showToast(`✅ Connected and authenticated as ${response.user.name || response.user.email}`, 'success');
      } else {
        showToast('✅ Connected and authenticated successfully!', 'success');
      }

      // Load contexts and workspaces
      await Promise.all([loadContexts(), loadWorkspaces()]);

      const universeWorkspace = getUniverseWorkspace();
      if (!universeWorkspace) {
        throw new Error('Universe workspace not found');
      }

      currentMode = 'explorer';
      settings.mode = 'explorer';
      settings.currentContext = null;
      settings.currentWorkspace = universeWorkspace;
      isBoundToContext = false;
      syncModeSelect.value = 'explorer';
      workspaceSelect.value = universeWorkspace.id;
      updateModeVisibility('explorer');
      if (currentContext) currentContext.style.display = 'none';

      await sendMessageToBackground('SET_MODE_AND_SELECTION', {
        mode: 'explorer',
        workspace: universeWorkspace,
        workspacePath: '/'
      });
      showToast('Explorer mode selected with universe workspace', 'info');
    } else if (response.success && response.connected && !response.authenticated) {
      // Server reachable but authentication failed
      isConnected = false;
      updateConnectionStatus(false);
      showToast('⚠️ Server reachable but authentication failed - check API token', 'warning');
    } else {
      // Complete connection failure
      isConnected = false;
      updateConnectionStatus(false);
      showToast(`❌ Connection failed: ${response.error}`, 'error');
    }

  } catch (error) {
    console.error('Connection failed:', error);
    isConnected = false;
    updateConnectionStatus(false);
    showToast(`Connection failed: ${error.message}`, 'error');
  } finally {
    setButtonLoading(connectBtn, false);
  }
}

async function handleDisconnect() {
  try {
    setButtonLoading(disconnectBtn, true);

    // TODO: Send disconnect request to background
    console.log('TODO: Disconnect');

    // Simulate success for now
    setTimeout(() => {
      isConnected = false;
      updateConnectionStatus(false);
      showToast('Disconnected successfully', 'success');
      setButtonLoading(disconnectBtn, false);

      // Hide UI sections
      if (syncModeSection) syncModeSection.style.display = 'none';
      currentContext.style.display = 'none';
    }, 500);

  } catch (error) {
    console.error('Disconnection failed:', error);
    showToast(`Disconnection failed: ${error.message}`, 'error');
    setButtonLoading(disconnectBtn, false);
  }
}

async function loadContexts() {
  try {
    if (!isConnected) {
      console.log('Not connected, skipping context loading');
      // Clear contexts
      availableContexts = [];
      populateContextSelect();
      if (syncModeSection) syncModeSection.style.display = 'none';
      return;
    }

    console.log('Loading contexts from Canvas server...');

    // Get contexts from background service worker
    const response = await sendMessageToBackground('GET_CONTEXTS');
    console.log('Contexts response:', response);

    if (response.success) {
      availableContexts = response.contexts || [];
      console.log(`Loaded ${availableContexts.length} contexts`);

      populateContextSelect();
      if (syncModeSection) syncModeSection.style.display = 'block';

      if (availableContexts.length > 0) {
        // Auto-select first context if none is currently selected
        if (!contextSelect.value) {
          contextSelect.value = availableContexts[0].id;
          console.log('Auto-selected first context:', availableContexts[0].id);
        }
      }
    } else {
      console.error('Failed to load contexts:', response.error);
      showToast(`Failed to load contexts: ${response.error}`, 'error');
      availableContexts = [];
      populateContextSelect();
    }

  } catch (error) {
    console.error('Failed to load contexts:', error);
    showToast(`Failed to load contexts: ${error.message}`, 'error');
    availableContexts = [];
    populateContextSelect();
  }
}

function populateContextSelect() {
  // Clear existing options securely
  contextSelect.textContent = '';

  // Create default option securely
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'Select a context...';
  contextSelect.appendChild(defaultOption);

  availableContexts.forEach(context => {
    const option = document.createElement('option');
    option.value = context.id;
    option.textContent = `${context.id} (${context.url})`;
    contextSelect.appendChild(option);
  });

  // Set current context selection if we have one and we're in context mode
  if (settings.currentContext?.id && currentMode === 'context') {
    contextSelect.value = settings.currentContext.id;
    console.log('Pre-selected current context:', settings.currentContext.id);
  }
}

async function loadWorkspaces() {
  try {
    if (!isConnected) {
      availableWorkspaces = [];
      populateWorkspaceSelect();
      return;
    }

    console.log('Loading workspaces from Canvas server...');
    const response = await sendMessageToBackground('GET_WORKSPACES');
    console.log('Workspaces response:', response);

    if (response.success) {
      availableWorkspaces = response.workspaces || [];
      populateWorkspaceSelect();

      // Auto-select universe workspace if in explorer mode and no workspace is selected
      if (currentMode === 'explorer') {
        const universeWorkspace = availableWorkspaces.find(w => w.name === 'universe');
        if (universeWorkspace && !workspaceSelect.value) {
          workspaceSelect.value = universeWorkspace.id;
          console.log('Auto-selected universe workspace during workspace loading:', universeWorkspace.id);
        }
      }
    } else {
      availableWorkspaces = [];
      populateWorkspaceSelect();
    }
  } catch (error) {
    console.error('Failed to load workspaces:', error);
    availableWorkspaces = [];
    populateWorkspaceSelect();
  }
}

// Render one row per workspace with a tree override select (Default / Context /
// Directory). The overrides map is keyed by workspace id. "Default" removes the
// override so the global preferredTreeType applies.
function renderTreeOverrides() {
  if (!treeOverridesList || !treeOverridesGroup) return;

  if (!availableWorkspaces || availableWorkspaces.length === 0) {
    treeOverridesGroup.style.display = 'none';
    treeOverridesList.textContent = '';
    return;
  }

  treeOverridesGroup.style.display = 'block';
  treeOverridesList.textContent = '';

  availableWorkspaces.forEach((ws) => {
    const row = document.createElement('div');
    row.className = 'tree-override-row';

    const name = document.createElement('span');
    name.className = 'tree-override-name';
    name.textContent = ws.label || ws.name || ws.id;
    row.appendChild(name);

    const select = document.createElement('select');
    select.className = 'input-field';
    [['', 'Default'], ['context', 'Context'], ['directory', 'Directory']].forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    });
    select.value = treeOverrides[ws.id] || '';
    select.addEventListener('change', () => {
      if (select.value) {
        treeOverrides[ws.id] = select.value;
      } else {
        delete treeOverrides[ws.id];
      }
      scheduleAutoSave();
    });
    row.appendChild(select);

    treeOverridesList.appendChild(row);
  });
}

function populateWorkspaceSelect() {
  // Clear existing options securely
  workspaceSelect.textContent = '';

  // Create default option securely
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'Select a workspace...';
  workspaceSelect.appendChild(defaultOption);

  availableWorkspaces.forEach(ws => {
    const option = document.createElement('option');
    option.value = ws.id;
    option.textContent = ws.label || ws.name || ws.id;
    option.dataset.name = ws.name;
    workspaceSelect.appendChild(option);
  });

  // Set current workspace selection if we have one and we're in explorer mode
  if (settings.currentWorkspace?.id && currentMode === 'explorer') {
    workspaceSelect.value = settings.currentWorkspace.id;
    console.log('Pre-selected current workspace:', settings.currentWorkspace.id);
  } else if (currentMode === 'explorer') {
    // Auto-select 'universe' workspace if available and no workspace is selected
    const universeWorkspace = availableWorkspaces.find(w => w.name === 'universe');
    if (universeWorkspace) {
      workspaceSelect.value = universeWorkspace.id;
      console.log('Auto-selected universe workspace:', universeWorkspace.id);
    }
  }

  // Keep the per-workspace tree override rows in sync with the workspace list
  renderTreeOverrides();
}

function getUniverseWorkspace() {
  return availableWorkspaces.find((workspace) => workspace.name === 'universe') || null;
}

function updateModeVisibility(mode) {
  if (!contextSettings || !explorerSettings) return;
  if (mode === 'context') {
    contextSettings.style.display = 'block';
    explorerSettings.style.display = 'none';
  } else {
    contextSettings.style.display = 'none';
    explorerSettings.style.display = 'block';
  }
}

function updateUnloadOptionsVisibility() {
  if (!stashOptions || !contextUnloadBehavior) return;
  stashOptions.style.display = contextUnloadBehavior.value === 'stash' ? 'block' : 'none';
}

function normalizeCanvasTabsFetchLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) return 200;
  return Math.min(1000, Math.max(1, Math.floor(limit)));
}

async function handleModeChange() {
  const selectedMode = syncModeSelect.value;
  currentMode = selectedMode;
  updateModeVisibility(selectedMode);

  if (selectedMode === 'context') {
    await sendMessageToBackground('SET_MODE_AND_SELECTION', { mode: 'context' });
  } else {
    const wsId = workspaceSelect.value;
    let selectedWorkspace = null;
    if (wsId) {
      selectedWorkspace = availableWorkspaces.find(w => w.id === wsId) || null;
    }
    await sendMessageToBackground('SET_MODE_AND_SELECTION', { mode: 'explorer', workspace: selectedWorkspace });
  }
}

async function handleBindContext() {
  try {
    const selectedContextId = contextSelect.value;
    if (!selectedContextId) {
      showToast('Please select a context to bind to', 'warning');
      return;
    }

    console.log('Binding to context:', selectedContextId);

    // Find the selected context
    const selectedContext = availableContexts.find(ctx => ctx.id === selectedContextId);
    if (!selectedContext) {
      showToast('Selected context not found', 'error');
      return;
    }

    // Send bind context request to background
    const response = await sendMessageToBackground('BIND_CONTEXT', { context: selectedContext });
    console.log('Bind context response:', response);

    if (response.success) {
      showToast(`Bound to context: ${selectedContext.id}`, 'success');
      settings.currentContext = selectedContext;
      isBoundToContext = true;
      currentMode = 'context';

      // Persist mode/selection in background
      await sendMessageToBackground('SET_MODE_AND_SELECTION', { mode: 'context', context: selectedContext });

      // Update UI to show bound context
      boundContextId.textContent = selectedContext.id;
      boundContextUrl.textContent = selectedContext.url;
      currentContext.style.display = 'block';

      // Show green dot indicator
      const contextStatusDot = document.getElementById('contextStatusDot');
      if (contextStatusDot) {
        contextStatusDot.className = 'status-dot connected';
        contextStatusDot.style.display = 'inline-block';
      }
    } else {
      showToast(`Failed to bind context: ${response.error}`, 'error');
      isBoundToContext = false;
    }
  } catch (error) {
    console.error('Failed to bind context:', error);
    showToast(`Failed to bind context: ${error.message}`, 'error');
  }
}

async function handleResetSettings() {
  if (!confirm('Reset all settings to defaults? This cannot be undone.')) {
    return;
  }

  try {
    setButtonLoading(resetSettingsBtn, true);

    // TODO: Reset settings in background
    console.log('TODO: Reset settings');

    // Simulate success and reload
    setTimeout(() => {
      showToast('Settings reset successfully', 'success');
      setButtonLoading(resetSettingsBtn, false);
      location.reload();
    }, 1000);

  } catch (error) {
    console.error('Failed to reset settings:', error);
    showToast(`Failed to reset settings: ${error.message}`, 'error');
    setButtonLoading(resetSettingsBtn, false);
  }
}

async function handleBrowserIdentityBlur() {
  if (!browserIdentity.value.trim()) {
    await generateBrowserIdentity();
  }
}

async function generateBrowserIdentity() {
  browserIdentity.value = getDefaultBrowserIdentity();
}

function getDefaultBrowserIdentity() {
  const userAgent = navigator.userAgent || '';
  if (userAgent.includes('Firefox')) return 'firefox';
  if (userAgent.includes('Edg/') || userAgent.includes('Edg ')) return 'edge';
  if (userAgent.includes('Chrome')) return 'chrome';
  if (userAgent.includes('Safari')) return 'safari';
  return 'browser';
}

function validateConnectionForm() {
  if (!serverUrl.value.trim()) {
    showToast('Server URL is required', 'warning');
    serverUrl.focus();
    return false;
  }

  if (!apiBasePath.value.trim()) {
    showToast('API base path is required', 'warning');
    apiBasePath.focus();
    return false;
  }

  if (currentAuthMode === 'credentials') {
    if (!authEmail.value.trim()) {
      showToast('Email is required', 'warning');
      authEmail.focus();
      return false;
    }
    if (!authPassword.value) {
      showToast('Password is required', 'warning');
      authPassword.focus();
      return false;
    }
  } else {
    if (!apiToken.value.trim()) {
      showToast('API token is required', 'warning');
      apiToken.focus();
      return false;
    }
  }

  return true;
}

function updateConnectionStatus(connected) {
  isConnected = connected;

  // Header pill + panel dot stay in sync
  const dotClass = connected ? 'status-dot connected' : 'status-dot disconnected';
  const label = connected ? 'Connected' : 'Not connected';
  if (statusDot) statusDot.className = dotClass;
  if (statusText) statusText.textContent = label;
  if (statusDotPanel) statusDotPanel.className = dotClass;
  if (statusTextPanel) statusTextPanel.textContent = label;
  if (syncDisconnectedNotice) syncDisconnectedNotice.style.display = connected ? 'none' : 'block';

  if (connected) {
    statusDetails.textContent = 'Successfully connected and authenticated to Canvas server';

    // Show user info if available
    if (settings.user && userInfo && userName && userServer) {
      userName.textContent = settings.user.name || settings.user.email || 'User';

      // Extract server URL without protocol
      const serverUrlValue = settings.connectionSettings.serverUrl;
      let displayServerUrl = serverUrlValue;
      if (serverUrlValue) {
        try {
          const url = new URL(serverUrlValue);
          displayServerUrl = url.hostname + (url.port ? ':' + url.port : '');
        } catch {
          // If URL parsing fails, use the original value
          displayServerUrl = serverUrlValue.replace(/^https?:\/\//, '');
        }
      }

      userServer.textContent = `@${displayServerUrl}`;
      userInfo.style.display = 'block';
    } else if (userInfo) {
      userInfo.style.display = 'none';
    }

    connectBtn.style.display = 'none';
    disconnectBtn.style.display = 'inline-block';
  } else {
    statusDetails.textContent = 'Click "Test Connection" or "Connect" to establish connection';

    // Hide user info when disconnected
    if (userInfo) {
      userInfo.style.display = 'none';
    }

    connectBtn.style.display = 'inline-block';
    disconnectBtn.style.display = 'none';

    if (syncModeSection) syncModeSection.style.display = 'none';
  }
}

function setButtonLoading(button, loading) {
  if (loading) {
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.textContent = 'Loading...';
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText;
  }
}

async function refreshTabSyncDebug() {
  try {
    setButtonLoading(refreshTabSyncDebugBtn, true);
    const response = await sendMessageToBackground('GET_TAB_SYNC_DEBUG');
    if (!response?.success) {
      throw new Error(response?.error || 'Failed to load debug state');
    }

    lastTabSyncDebug = response.debug;
    renderTabSyncDebug(response.debug);
  } catch (error) {
    lastTabSyncDebug = null;
    tabSyncDebugSummary.textContent = `Failed to load debug state: ${error.message}`;
    tabSyncDebugOutput.textContent = '';
    showToast(`Failed to load debug state: ${error.message}`, 'error');
  } finally {
    setButtonLoading(refreshTabSyncDebugBtn, false);
  }
}

function renderTabSyncDebug(debug) {
  const trackedCount = debug?.live?.trackedTabs?.length || 0;
  const persistedCount = debug?.persistedTrackedTabs?.length || 0;
  const syncableCount = debug?.live?.syncableTabs?.length || 0;
  const socketState = debug?.websocket?.state || 'unknown';
  const scope = debug?.mode === 'context'
    ? (debug?.selection?.context?.id || 'none')
    : `${debug?.selection?.workspace?.name || debug?.selection?.workspace?.id || 'none'} @ ${debug?.selection?.workspacePath || '/'}`;

  tabSyncDebugSummary.textContent = `Mode: ${debug?.mode || 'unknown'} | Scope: ${scope} | Socket: ${socketState} | Persisted mappings: ${persistedCount} | Live mappings: ${trackedCount} | Syncable tabs: ${syncableCount}`;
  tabSyncDebugOutput.textContent = JSON.stringify(debug, null, 2);
}

async function copyTabSyncDebug() {
  try {
    if (!lastTabSyncDebug) {
      await refreshTabSyncDebug();
      if (!lastTabSyncDebug) return;
    }

    await navigator.clipboard.writeText(JSON.stringify(lastTabSyncDebug, null, 2));
    showToast('Debug JSON copied to clipboard', 'success');
  } catch (error) {
    showToast(`Failed to copy debug JSON: ${error.message}`, 'error');
  }
}

function showToast(message, type = 'info') {
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.style.display = 'block';

  setTimeout(() => {
    toast.style.display = 'none';
  }, 5000);
}

// Setup storage change listeners for real-time updates
function setupStorageListeners() {
  // Listen for storage changes (cross-browser compatible)
  const browserAPI = (typeof chrome !== 'undefined') ? chrome : browser;
  if (browserAPI && browserAPI.storage) {
    browserAPI.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        console.log('Settings: Storage changed:', changes);

        // Handle connection settings changes
        if (changes.canvasConnectionSettings) {
          console.log('Settings: Connection settings changed');
          const newSettings = changes.canvasConnectionSettings.newValue;
          if (newSettings) {
            // Update connection state
            isConnected = newSettings.connected || false;
            updateConnectionStatus(isConnected);

            // Update form fields if they exist and are different
            if (serverUrl && newSettings.serverUrl && serverUrl.value !== newSettings.serverUrl) {
              serverUrl.value = newSettings.serverUrl;
            }
            if (apiBasePath && newSettings.apiBasePath && apiBasePath.value !== newSettings.apiBasePath) {
              apiBasePath.value = newSettings.apiBasePath;
            }
            if (apiToken && newSettings.apiToken && apiToken.value !== newSettings.apiToken) {
              apiToken.value = newSettings.apiToken;
            }
          }
        }

        // Handle context changes
        if (changes.canvasCurrentContext) {
          console.log('Settings: Current context changed');
          const newContext = changes.canvasCurrentContext.newValue;
          if (newContext) {
            isBoundToContext = true;
            if (boundContextId) boundContextId.textContent = newContext.id;
            if (boundContextUrl) boundContextUrl.textContent = newContext.url;
            if (currentContext) currentContext.style.display = 'block';

            // Show green dot indicator
            const contextStatusDot = document.getElementById('contextStatusDot');
            if (contextStatusDot) {
              contextStatusDot.className = 'status-dot connected';
              contextStatusDot.style.display = 'inline-block';
            }

            // Update context dropdown selection
            if (contextSelect && contextSelect.value !== newContext.id) {
              contextSelect.value = newContext.id;
            }
          } else {
            isBoundToContext = false;
            if (currentContext) currentContext.style.display = 'none';

            // Hide green dot indicator
            const contextStatusDot = document.getElementById('contextStatusDot');
            if (contextStatusDot) {
              contextStatusDot.style.display = 'none';
            }
          }
        }

        // Handle mode changes
        if (changes.canvasSyncMode) {
          const newMode = changes.canvasSyncMode.newValue || 'explorer';
          currentMode = newMode;
          if (syncModeSelect) syncModeSelect.value = newMode;
          updateModeVisibility(newMode);
        }

        if (
          changes.canvasTrackedCanvasTabs ||
          changes.canvasSyncMode ||
          changes.canvasCurrentContext ||
          changes.canvasCurrentWorkspace ||
          changes.canvasWorkspacePath
        ) {
          void refreshTabSyncDebug();
        }
      }
    });
  } else {
    console.warn('Settings: Chrome storage API not available');
  }
}

// Utility functions
async function sendMessageToBackground(type, data = null) {
  return new Promise((resolve, reject) => {
    const runtime = (typeof browser !== 'undefined') ? browser.runtime : chrome.runtime;
    runtime.sendMessage({ type, data }, (response) => {
      const lastError = (typeof browser !== 'undefined') ? browser.runtime.lastError : chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

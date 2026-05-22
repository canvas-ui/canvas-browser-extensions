// Canvas Extension Settings JavaScript
// Handles settings page interactions and configuration management

// DOM elements
let browserIdentity, serverUrl, apiBasePath, apiToken;
let authModeToken, authModeCredentials, apiTokenGroup, credentialsGroup, authEmail, authPassword;
let deviceSelect, deviceSelectionHelp, deviceRegistrationSection;
let deviceDetailsSection, selectedDeviceName, selectedDeviceId, selectedDevicePlatform, selectedDeviceDescription;
let generatedDeviceId;
let newDeviceName, newDevicePlatform, newDeviceDescription;
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
let syncOnlyCurrentBrowser, syncOnlyTaggedTabs, syncTagFilter;
let saveSettingsBtn, saveAndCloseBtn, resetSettingsBtn;
let refreshTabSyncDebugBtn, copyTabSyncDebugBtn, tabSyncDebugSummary, tabSyncDebugOutput;
let toast;

// State
let currentAuthMode = 'token';
let isConnected = false;
let isBoundToContext = false;
let availableContexts = [];
let availableWorkspaces = [];
let availableDevices = [];
let settings = {};
let currentMode = 'explorer';
let lastTabSyncDebug = null;
let currentGeneratedDeviceId = '';

const REGISTER_NEW_DEVICE_VALUE = '__register_new_device__';

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
  deviceSelect = document.getElementById('deviceSelect');
  deviceSelectionHelp = document.getElementById('deviceSelectionHelp');
  deviceRegistrationSection = document.getElementById('deviceRegistrationSection');
  deviceDetailsSection = document.getElementById('deviceDetailsSection');
  selectedDeviceName = document.getElementById('selectedDeviceName');
  selectedDeviceId = document.getElementById('selectedDeviceId');
  selectedDevicePlatform = document.getElementById('selectedDevicePlatform');
  selectedDeviceDescription = document.getElementById('selectedDeviceDescription');
  generatedDeviceId = document.getElementById('generatedDeviceId');
  newDeviceName = document.getElementById('newDeviceName');
  newDevicePlatform = document.getElementById('newDevicePlatform');
  newDeviceDescription = document.getElementById('newDeviceDescription');

  // Connection controls

  testConnectionBtn = document.getElementById('testConnectionBtn');
  connectBtn = document.getElementById('connectBtn');
  disconnectBtn = document.getElementById('disconnectBtn');

  // Connection status
  statusDot = document.getElementById('statusDot');
  statusText = document.getElementById('statusText');
  statusDetails = document.getElementById('statusDetails');
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

  // Sync filtering options
  syncOnlyCurrentBrowser = document.getElementById('syncOnlyCurrentBrowser');
  syncOnlyTaggedTabs = document.getElementById('syncOnlyTaggedTabs');
  syncTagFilter = document.getElementById('syncTagFilter');

  // Action buttons
  saveSettingsBtn = document.getElementById('saveSettingsBtn');
  saveAndCloseBtn = document.getElementById('saveAndCloseBtn');
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
  saveSettingsBtn.addEventListener('click', handleSaveSettings);
  saveAndCloseBtn.addEventListener('click', handleSaveAndClose);
  resetSettingsBtn.addEventListener('click', handleResetSettings);
  refreshTabSyncDebugBtn.addEventListener('click', refreshTabSyncDebug);
  copyTabSyncDebugBtn.addEventListener('click', copyTabSyncDebug);

  // Auto-generate browser identity if empty
  browserIdentity.addEventListener('blur', handleBrowserIdentityBlur);
  deviceSelect.addEventListener('change', updateDeviceSelectionUI);

  // Sync filtering options
  syncOnlyTaggedTabs.addEventListener('change', () => {
    syncTagFilter.disabled = !syncOnlyTaggedTabs.checked;
    if (!syncOnlyTaggedTabs.checked) {
      syncTagFilter.value = '';
    }
  });

  contextUnloadBehavior.addEventListener('change', updateUnloadOptionsVisibility);

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
        deviceId: savedConnectionSettings.deviceId || '',
        deviceToken: savedConnectionSettings.deviceToken || '',
        deviceName: savedConnectionSettings.deviceName || '',
        devicePlatform: savedConnectionSettings.devicePlatform || '',
        deviceDescription: savedConnectionSettings.deviceDescription || '',
        deviceType: savedConnectionSettings.deviceType || 'browser',
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
        chromiumStashGroupName: savedSyncSettings.chromiumStashGroupName || 'Closed tabs',
        canvasTabsFetchLimit: savedSyncSettings.canvasTabsFetchLimit || 200,
        syncOnlyCurrentBrowser: savedSyncSettings.syncOnlyCurrentBrowser || false,
        syncOnlyTaggedTabs: savedSyncSettings.syncOnlyTaggedTabs || false,
        syncTagFilter: savedSyncSettings.syncTagFilter || ''
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
        loadWorkspaces(),
        loadRegisteredDevices()
      ]);

      // Preselect dropdowns if values exist - this will be handled in populate functions
    }

    showToast('Settings loaded successfully', 'success');
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
        chromiumStashGroupName: 'Closed tabs',
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
  updateAuthModeVisibility(currentAuthMode);
  browserIdentity.value = settings.browserIdentity || getDefaultBrowserIdentity();
  if (newDeviceName) newDeviceName.value = settings.connectionSettings.deviceName || '';
  if (newDevicePlatform) newDevicePlatform.value = settings.connectionSettings.devicePlatform || '';
  if (newDeviceDescription) newDeviceDescription.value = settings.connectionSettings.deviceDescription || '';
  populateDeviceSelect();

  // Sync settings
  openTabsAddedToCanvas.checked = settings.syncSettings.openTabsAddedToCanvas;
  closeTabsRemovedFromCanvas.checked = settings.syncSettings.closeTabsRemovedFromCanvas;
  sendNewTabsToCanvas.checked = settings.syncSettings.sendNewTabsToCanvas;
  removeClosedTabsFromCanvas.checked = settings.syncSettings.removeClosedTabsFromCanvas;
  if (removeUtmParameters) removeUtmParameters.checked = settings.syncSettings.removeUtmParameters ?? true;
  contextUnloadBehavior.value = settings.syncSettings.contextUnloadBehavior || 'close';
  stashDiscardTabs.checked = settings.syncSettings.stashDiscardTabs ?? true;
  firefoxHideStashedTabs.checked = settings.syncSettings.firefoxHideStashedTabs ?? true;
  chromiumStashGroupName.value = settings.syncSettings.chromiumStashGroupName || 'Closed tabs';
  canvasTabsFetchLimit.value = String(normalizeCanvasTabsFetchLimit(settings.syncSettings.canvasTabsFetchLimit));
  updateUnloadOptionsVisibility();

  // Sync filtering options
  syncOnlyCurrentBrowser.checked = settings.syncSettings.syncOnlyCurrentBrowser;
  syncOnlyTaggedTabs.checked = settings.syncSettings.syncOnlyTaggedTabs;
  syncTagFilter.value = settings.syncSettings.syncTagFilter;
  syncTagFilter.disabled = !settings.syncSettings.syncOnlyTaggedTabs;

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
          loadWorkspaces(),
          loadRegisteredDevices(connectionData)
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
      updateConnectionStatus(true);

      if (response.user) {
        showToast(`✅ Connected and authenticated as ${response.user.name || response.user.email}`, 'success');
      } else {
        showToast('✅ Connected and authenticated successfully!', 'success');
      }

      // Load contexts and workspaces
      await Promise.all([loadContexts(), loadWorkspaces(), loadRegisteredDevices()]);

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
      availableDevices = [];
      populateDeviceSelect();
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

      if (availableContexts.length === 0) {
        showToast('No contexts found - you can create one by entering a context ID', 'info');
      } else {
        showToast(`Loaded ${availableContexts.length} contexts`, 'success');

        // Auto-select first context if none is currently selected
        if (!contextSelect.value && availableContexts.length > 0) {
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
}

function getUniverseWorkspace() {
  return availableWorkspaces.find((workspace) => workspace.name === 'universe') || null;
}

async function loadRegisteredDevices(connectionOverride = null) {
  try {
    if (!isConnected && !connectionOverride) {
      availableDevices = [];
      populateDeviceSelect();
      return;
    }

    const response = await sendMessageToBackground('GET_REGISTERED_DEVICES', connectionOverride);
    if (!response?.success) {
      throw new Error(response?.error || 'Failed to load devices');
    }

    availableDevices = Array.isArray(response.devices) ? response.devices : [];
    populateDeviceSelect();
  } catch (error) {
    console.error('Failed to load registered devices:', error);
    availableDevices = [];
    populateDeviceSelect();
    showToast(`Failed to load devices: ${error.message}`, 'error');
  }
}

function populateDeviceSelect() {
  if (!deviceSelect) return;

  const previousValue = deviceSelect.value;
  deviceSelect.textContent = '';
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  if (!isConnected) {
    defaultOption.textContent = 'Connect first to load devices...';
  } else {
    defaultOption.textContent = availableDevices.length > 0 ? 'Select a device...' : 'No registered devices found';
  }
  deviceSelect.appendChild(defaultOption);

  availableDevices.forEach((device) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    const platform = device.platform ? ` (${device.platform})` : '';
    option.textContent = `${device.name || device.deviceId}${platform}`;
    deviceSelect.appendChild(option);
  });

  if (isConnected) {
    const registerOption = document.createElement('option');
    registerOption.value = REGISTER_NEW_DEVICE_VALUE;
    registerOption.textContent = 'Register a new device';
    deviceSelect.appendChild(registerOption);
  }

  deviceSelect.disabled = !isConnected;
  if (previousValue === REGISTER_NEW_DEVICE_VALUE) {
    deviceSelect.value = REGISTER_NEW_DEVICE_VALUE;
  } else if (availableDevices.some((device) => device.deviceId === previousValue)) {
    deviceSelect.value = previousValue;
  } else if (availableDevices.some((device) => device.deviceId === settings.connectionSettings.deviceId)) {
    deviceSelect.value = settings.connectionSettings.deviceId;
  } else if (isConnected && availableDevices.length === 0) {
    deviceSelect.value = REGISTER_NEW_DEVICE_VALUE;
  } else {
    deviceSelect.value = '';
  }

  updateDeviceSelectionUI();
}

function updateDeviceSelectionUI() {
  const hasDevices = availableDevices.length > 0;
  const isRegistering = !hasDevices || deviceSelect.value === REGISTER_NEW_DEVICE_VALUE;
  const selectedDevice = availableDevices.find((device) => device.deviceId === deviceSelect.value) || null;

  if (deviceRegistrationSection) {
    deviceRegistrationSection.style.display = isConnected && isRegistering ? 'block' : 'none';
  }

  if (deviceDetailsSection) {
    deviceDetailsSection.style.display = selectedDevice ? 'block' : 'none';
  }

  if (deviceSelectionHelp) {
    if (!isConnected) {
      deviceSelectionHelp.textContent = 'Connect first to load devices.';
    } else if (selectedDevice) {
      deviceSelectionHelp.textContent = 'Selected device details are shown below.';
    } else {
      deviceSelectionHelp.textContent = 'Register a named device for this browser.';
    }
  }

  if (selectedDevice) {
    if (selectedDeviceName) selectedDeviceName.textContent = selectedDevice.name || 'Unnamed device';
    if (selectedDeviceId) selectedDeviceId.textContent = `ID: ${selectedDevice.deviceId || '-'}`;
    if (selectedDevicePlatform) selectedDevicePlatform.textContent = `OS: ${selectedDevice.platform || '-'}`;
    if (selectedDeviceDescription) {
      selectedDeviceDescription.textContent = selectedDevice.description
        ? `Description: ${selectedDevice.description}`
        : 'Description: -';
    }
  }

  if (isRegistering) {
    ensureGeneratedDeviceId();
    if (generatedDeviceId) generatedDeviceId.value = currentGeneratedDeviceId;
    if (newDevicePlatform && !newDevicePlatform.value) {
      newDevicePlatform.value = getDefaultDevicePlatform();
    }
  }
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

async function handleSaveAndClose() {
  try {
    // Save settings first
    await handleSaveSettings();

    // Wait a moment for the save operation to complete and show success message
    setTimeout(() => {
      // Close the current tab
      window.close();
    }, 1000);

  } catch (error) {
    console.error('Failed to save and close:', error);
    showToast(`Failed to save and close: ${error.message}`, 'error');
  }
}



async function handleSaveSettings() {
  try {
    setButtonLoading(saveSettingsBtn, true);

    // MANDATORY: Check if connected
    if (!isConnected) {
      throw new Error('You must connect to Canvas server before saving settings');
    }

    // Mode-specific validation
    if ((currentMode === 'context') && (!isBoundToContext && !contextSelect.value)) {
      throw new Error('You must bind to a context before saving settings');
    }
    if (currentMode === 'explorer' && !workspaceSelect.value) {
      throw new Error('You must select a workspace in Explorer mode');
    }

    // If context is selected but not bound, bind automatically
    if (currentMode === 'context' && contextSelect.value && !isBoundToContext) {
      console.log('Auto-binding to selected context before save...');
      await handleBindContext();

      // Check if binding was successful
      if (!isBoundToContext) {
        throw new Error('Failed to bind to context. Please bind manually before saving.');
      }
    }

    // Persist mode and selection
    if (currentMode === 'explorer') {
      const ws = availableWorkspaces.find(w => w.id === workspaceSelect.value) || null;
      await sendMessageToBackground('SET_MODE_AND_SELECTION', { mode: 'explorer', workspace: ws });
    }

    const assignedDevice = await resolveDeviceAssignment();

    // When using credentials auth, the JWT was obtained during connect and stored in settings
    const resolvedApiToken = currentAuthMode === 'credentials'
      ? settings.connectionSettings.apiToken
      : apiToken.value.trim();

    const allSettings = {
      connectionSettings: {
        serverUrl: serverUrl.value.trim(),
        apiBasePath: apiBasePath.value.trim(),
        apiToken: resolvedApiToken,
        authMode: currentAuthMode,
        deviceId: assignedDevice.deviceId,
        deviceToken: assignedDevice.token,
        deviceName: assignedDevice.name || '',
        devicePlatform: assignedDevice.platform || '',
        deviceDescription: assignedDevice.description || '',
        deviceType: assignedDevice.type || 'browser',
        deviceTokenServerUrl: serverUrl.value.trim().replace(/\/$/, ''),
        connected: isConnected
      },
      syncSettings: {
        openTabsAddedToCanvas: openTabsAddedToCanvas.checked,
        closeTabsRemovedFromCanvas: closeTabsRemovedFromCanvas.checked,
        sendNewTabsToCanvas: sendNewTabsToCanvas.checked,
        removeClosedTabsFromCanvas: removeClosedTabsFromCanvas.checked,
        removeUtmParameters: removeUtmParameters?.checked ?? true,
        contextUnloadBehavior: contextUnloadBehavior.value,
        stashDiscardTabs: stashDiscardTabs.checked,
        firefoxHideStashedTabs: firefoxHideStashedTabs.checked,
        chromiumStashGroupName: chromiumStashGroupName.value.trim() || 'Closed tabs',
        canvasTabsFetchLimit: normalizeCanvasTabsFetchLimit(canvasTabsFetchLimit.value),
        syncOnlyCurrentBrowser: syncOnlyCurrentBrowser.checked,
        syncOnlyTaggedTabs: syncOnlyTaggedTabs.checked,
        syncTagFilter: syncTagFilter.value.trim()
      },
      browserIdentity: browserIdentity.value.trim()
    };

    console.log('Saving settings with mandatory context binding:', allSettings);

    // Save settings via background service worker
    const saveResponse = await sendMessageToBackground('SAVE_SETTINGS', allSettings);

    if (saveResponse.success) {
      settings.connectionSettings = { ...settings.connectionSettings, ...allSettings.connectionSettings };
      settings.syncSettings = { ...settings.syncSettings, ...allSettings.syncSettings };
      settings.browserIdentity = allSettings.browserIdentity;
      showToast('Settings saved successfully! Extension is fully configured.', 'success');
    } else {
      throw new Error(saveResponse.error || 'Failed to save settings');
    }

  } catch (error) {
    console.error('Failed to save settings:', error);
    showToast(`Cannot save settings: ${error.message}`, 'error');
  } finally {
    setButtonLoading(saveSettingsBtn, false);
  }
}

async function resolveDeviceAssignment() {
  const connectionData = {
    serverUrl: serverUrl.value.trim(),
    apiBasePath: apiBasePath.value.trim(),
    apiToken: apiToken.value.trim(),
    browserIdentity: browserIdentity.value.trim()
  };

  const selectedValue = deviceSelect.value;

  if (selectedValue && selectedValue !== REGISTER_NEW_DEVICE_VALUE) {
    const selectedDevice = availableDevices.find((device) => device.deviceId === selectedValue);
    if (!selectedDevice) {
      throw new Error('Pick a registered device for this browser');
    }
    if (isUuidLike(selectedDevice.name || '')) {
      throw new Error('Selected device uses a UUID as its name. Register a new device with a real name.');
    }

    const response = await sendMessageToBackground('ASSIGN_BROWSER_DEVICE', {
      ...connectionData,
      deviceId: selectedDevice.deviceId,
      deviceName: selectedDevice.name,
      devicePlatform: selectedDevice.platform,
      deviceDescription: selectedDevice.description
    });
    if (!response?.success || !response.device?.deviceId || !response.device?.token) {
      throw new Error(response?.error || 'Failed to assign selected device');
    }
    return response.device;
  }

  if (availableDevices.length > 0 && selectedValue !== REGISTER_NEW_DEVICE_VALUE) {
    throw new Error('Pick a registered device or choose "Register a new device"');
  }

  const deviceNameValue = newDeviceName.value.trim();
  const devicePlatformValue = newDevicePlatform.value.trim();
  if (!deviceNameValue) {
    throw new Error('Device name is required');
  }
  if (isUuidLike(deviceNameValue)) {
    throw new Error('Device name cannot be a UUID. Use something a human can recognize.');
  }
  if (!devicePlatformValue) {
    throw new Error('Device OS is required');
  }

  const response = await sendMessageToBackground('ASSIGN_BROWSER_DEVICE', {
    ...connectionData,
    registerNew: true,
    deviceId: ensureGeneratedDeviceId(),
    deviceName: deviceNameValue,
    devicePlatform: devicePlatformValue,
    deviceDescription: newDeviceDescription.value.trim()
  });
  if (!response?.success || !response.device?.deviceId || !response.device?.token) {
    throw new Error(response?.error || 'Failed to register device');
  }

  availableDevices = [response.device];
  currentGeneratedDeviceId = '';
  populateDeviceSelect();
  deviceSelect.value = response.device.deviceId;
  updateDeviceSelectionUI();
  return response.device;
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

function ensureGeneratedDeviceId() {
  if (!currentGeneratedDeviceId) {
    currentGeneratedDeviceId = generateUuidV4();
  }
  return currentGeneratedDeviceId;
}

function generateUuidV4() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isUuidLike(value) {
  const normalizedValue = String(value || '').trim().replace(/-/g, '');
  return /^[0-9a-f]{32}$/i.test(normalizedValue);
}

function getDefaultBrowserIdentity() {
  const userAgent = navigator.userAgent || '';
  if (userAgent.includes('Firefox')) return 'firefox';
  if (userAgent.includes('Edg/') || userAgent.includes('Edg ')) return 'edge';
  if (userAgent.includes('Chrome')) return 'chrome';
  if (userAgent.includes('Safari')) return 'safari';
  return 'browser';
}

function getDefaultDevicePlatform() {
  const userAgent = navigator.userAgent || '';
  if (userAgent.includes('Android')) return 'android';
  if (userAgent.includes('iPhone') || userAgent.includes('iPad')) return 'ios';
  if (userAgent.includes('Windows')) return 'windows';
  if (userAgent.includes('Mac OS X') || userAgent.includes('Macintosh')) return 'mac';
  if (userAgent.includes('Linux')) return 'linux';
  return 'unknown';
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

  if (connected) {
    statusDot.className = 'status-dot connected';
    statusText.textContent = 'Connected';
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
    statusDot.className = 'status-dot disconnected';
    statusText.textContent = 'Not connected';
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

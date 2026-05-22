// Browser-compatible storage system for Canvas Extension
// Works with both Chrome and Firefox using storage API directly

// Browser compatibility shim
const browserAPI = (() => {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    return chrome;
  }
  if (typeof browser !== 'undefined' && browser.storage) {
    return browser;
  }
  throw new Error('Browser storage API not available');
})();

export class BrowserStorage {
  constructor() {
    this.storage = browserAPI.storage.local;
    this.setupChangeListeners();

    // Storage keys
    this.KEYS = {
      CONNECTION_SETTINGS: 'canvasConnectionSettings',
      CURRENT_CONTEXT: 'canvasCurrentContext',
      CURRENT_WORKSPACE: 'canvasCurrentWorkspace',
      SYNC_MODE: 'canvasSyncMode',
      WORKSPACE_PATH: 'canvasWorkspacePath',
      SYNC_SETTINGS: 'canvasSyncSettings',
      BROWSER_IDENTITY: 'canvasBrowserIdentity',
      TRACKED_CANVAS_TABS: 'canvasTrackedCanvasTabs',
      PINNED_TABS: 'canvasPinnedTabs',
      USER_INFO: 'canvasUserInfo',
      RECENT_DESTINATIONS: 'canvasRecentDestinations'
    };

    // Default values
    this.DEFAULTS = {
      [this.KEYS.CONNECTION_SETTINGS]: {
        serverUrl: 'https://my.cnvs.ai',
        apiBasePath: '/rest/v2',
        apiToken: '',
        connected: false
      },
      [this.KEYS.SYNC_MODE]: 'explorer', // 'explorer' | 'context'
      [this.KEYS.WORKSPACE_PATH]: '/',
      [this.KEYS.SYNC_SETTINGS]: {
        openTabsAddedToCanvas: false,        // Open tabs when added to Canvas Server
        closeTabsRemovedFromCanvas: false,   // Close tabs when removed from Canvas Server
        sendNewTabsToCanvas: false,          // Send newly opened browser tabs to Canvas Server
        removeClosedTabsFromCanvas: false,   // Remove closed browser tabs from Canvas Server
        removeUtmParameters: true,           // Strip utm_* query params from URLs before syncing
        contextUnloadBehavior: 'close',      // 'close' | 'discard' | 'stash'
        stashDiscardTabs: true,              // Discard tabs after stashing them
        firefoxHideStashedTabs: true,        // Firefox-only: hide stashed tabs from the tab strip
        chromiumStashGroupName: 'Stashed',
        canvasTabsFetchLimit: 200,
        contextChangeBehavior: 'keep-only'  // How to handle context changes: 'close-open-new', 'save-close-open-new', 'keep-open-new', 'keep-only'
      },
      [this.KEYS.CURRENT_CONTEXT]: null,
      [this.KEYS.CURRENT_WORKSPACE]: null, // { id, name, label, path }
      [this.KEYS.BROWSER_IDENTITY]: '',
      [this.KEYS.TRACKED_CANVAS_TABS]: [],
      // Stored as array in browser storage (Set can't be serialized)
      [this.KEYS.PINNED_TABS]: [],
      [this.KEYS.USER_INFO]: null, // { id, name, email, userType, status }
      [this.KEYS.RECENT_DESTINATIONS]: [] // Array of recent destinations: [{ id, title, type: 'workspace'|'context', workspaceName?, contextSpec?, timestamp }]
    };
  }

  // Setup storage change listeners
  setupChangeListeners() {
    browserAPI.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        console.log('Storage changed:', changes);

        // Notify other parts of the extension about changes
        if (changes[this.KEYS.CONNECTION_SETTINGS]) {
          console.log('Connection settings changed:', changes[this.KEYS.CONNECTION_SETTINGS].newValue);
        }

        if (changes[this.KEYS.CURRENT_CONTEXT]) {
          console.log('Current context changed:', changes[this.KEYS.CURRENT_CONTEXT].newValue);
        }
      }
    });
  }

  // Generic get method
  async get(key) {
    try {
      console.log('BrowserStorage: Getting key:', key);
      const result = await this.storage.get(key);
      const value = result[key];

      console.log('BrowserStorage: Retrieved value for', key, ':', value);

      // Return actual value if exists, otherwise return default
      if (value !== undefined && value !== null) {
        return value;
      }

      const defaultValue = this.DEFAULTS[key];
      console.log('BrowserStorage: Using default value for', key, ':', defaultValue);
      return defaultValue;
    } catch (error) {
      console.error('BrowserStorage: Error getting', key, ':', error);
      return this.DEFAULTS[key];
    }
  }

  // Generic set method
  async set(key, value) {
    try {
      console.log('BrowserStorage: Setting key:', key, 'to value:', value);
      await this.storage.set({ [key]: value });
      console.log('BrowserStorage: Successfully set', key);
      return true;
    } catch (error) {
      console.error('BrowserStorage: Error setting', key, ':', error);
      return false;
    }
  }

  // Get multiple keys at once
  async getMultiple(keys) {
    try {
      console.log('BrowserStorage: Getting multiple keys:', keys);
      const result = await this.storage.get(keys);

      // Apply defaults for missing keys
      const output = {};
      for (const key of keys) {
        output[key] = result[key] !== undefined ? result[key] : this.DEFAULTS[key];
      }

      console.log('BrowserStorage: Retrieved multiple values:', output);
      return output;
    } catch (error) {
      console.error('BrowserStorage: Error getting multiple keys:', error);
      // Return defaults for all requested keys
      const output = {};
      for (const key of keys) {
        output[key] = this.DEFAULTS[key];
      }
      return output;
    }
  }

  // Connection Settings
  async getConnectionSettings() {
    return await this.get(this.KEYS.CONNECTION_SETTINGS);
  }

  async setConnectionSettings(settings) {
    const current = await this.getConnectionSettings();
    const updated = { ...current, ...settings };
    return await this.set(this.KEYS.CONNECTION_SETTINGS, updated);
  }

  // Current Context
  async getCurrentContext() {
    return await this.get(this.KEYS.CURRENT_CONTEXT);
  }

  async setCurrentContext(context) {
    return await this.set(this.KEYS.CURRENT_CONTEXT, context);
  }

  // Current Workspace (Explorer mode)
  async getCurrentWorkspace() {
    return await this.get(this.KEYS.CURRENT_WORKSPACE);
  }

  async setCurrentWorkspace(workspace) {
    return await this.set(this.KEYS.CURRENT_WORKSPACE, workspace);
  }

  // Sync Mode
  async getSyncMode() {
    return await this.get(this.KEYS.SYNC_MODE);
  }

  async setSyncMode(mode) {
    return await this.set(this.KEYS.SYNC_MODE, mode);
  }

  // Explorer path
  async getWorkspacePath() {
    return await this.get(this.KEYS.WORKSPACE_PATH);
  }

  async setWorkspacePath(path) {
    return await this.set(this.KEYS.WORKSPACE_PATH, path || '/');
  }

  // Sync Settings
  async getSyncSettings() {
    return await this.get(this.KEYS.SYNC_SETTINGS);
  }

  async setSyncSettings(settings) {
    const current = await this.getSyncSettings();
    const updated = { ...current, ...settings };
    return await this.set(this.KEYS.SYNC_SETTINGS, updated);
  }

  async getTrackedCanvasTabs() {
    const trackedTabs = await this.get(this.KEYS.TRACKED_CANVAS_TABS);
    return Array.isArray(trackedTabs) ? trackedTabs : [];
  }

  async setTrackedCanvasTabs(trackedTabs) {
    const items = Array.isArray(trackedTabs) ? trackedTabs : [];
    return await this.set(this.KEYS.TRACKED_CANVAS_TABS, items);
  }

  // Browser Identity
  async getBrowserIdentity() {
    let identity = await this.get(this.KEYS.BROWSER_IDENTITY);

    if (!identity) {
      identity = this.detectBrowserIdentity();
      await this.set(this.KEYS.BROWSER_IDENTITY, identity);
      console.log('Generated new browser identity:', identity);
    }

    return identity;
  }

  detectBrowserIdentity() {
    const ua = navigator.userAgent;

    let browserName = 'browser';
    if (ua.includes('Firefox')) browserName = 'firefox';
    else if (ua.includes('Edg/') || ua.includes('Edg ')) browserName = 'edge';
    else if (ua.includes('Chrome')) browserName = 'chrome';
    else if (ua.includes('Safari')) browserName = 'safari';
    return browserName;
  }

  // Pinned Tabs Management
  // IMPORTANT: We store pinned tabs by URL (NOT tabId) so pins survive browser restarts.
  async getPinnedTabUrls() {
    const pinnedData = await this.get(this.KEYS.PINNED_TABS);
    const arr = Array.isArray(pinnedData) ? pinnedData : (pinnedData ? Array.from(pinnedData) : []);
    // Migration safety: older versions stored numeric tabIds; ignore non-strings.
    return new Set(arr.filter(v => typeof v === 'string' && v.length));
  }

  async setPinnedTabUrls(pinnedUrls) {
    const arr = pinnedUrls instanceof Set ? Array.from(pinnedUrls) : (Array.isArray(pinnedUrls) ? pinnedUrls : []);
    return await this.set(this.KEYS.PINNED_TABS, arr.filter(v => typeof v === 'string' && v.length));
  }

  async pinTabUrl(url) {
    const pinned = await this.getPinnedTabUrls();
    pinned.add(url);
    console.log('Pinning tab URL:', url);
    return await this.setPinnedTabUrls(pinned);
  }

  async unpinTabUrl(url) {
    const pinned = await this.getPinnedTabUrls();
    pinned.delete(url);
    console.log('Unpinning tab URL:', url);
    return await this.setPinnedTabUrls(pinned);
  }

  async isTabUrlPinned(url) {
    const pinned = await this.getPinnedTabUrls();
    return pinned.has(url);
  }

  // User Info
  async getUserInfo() {
    return await this.get(this.KEYS.USER_INFO);
  }

  async setUserInfo(userInfo) {
    return await this.set(this.KEYS.USER_INFO, userInfo);
  }

  // Recent Destinations Management
  async getRecentDestinations() {
    return await this.get(this.KEYS.RECENT_DESTINATIONS);
  }

  async addRecentDestination(destination) {
    try {
      const recent = await this.getRecentDestinations();
      
      // Create destination object with timestamp
      const newDestination = {
        ...destination,
        timestamp: Date.now()
      };

      // Remove any existing destination with the same ID to avoid duplicates
      const filtered = recent.filter(item => item.id !== destination.id);
      
      // Add new destination at the beginning
      filtered.unshift(newDestination);
      
      // Keep only the 5 most recent
      const trimmed = filtered.slice(0, 5);
      
      await this.set(this.KEYS.RECENT_DESTINATIONS, trimmed);
      console.log('Added recent destination:', newDestination);
      return trimmed;
    } catch (error) {
      console.error('Failed to add recent destination:', error);
      return [];
    }
  }

  async clearRecentDestinations() {
    return await this.set(this.KEYS.RECENT_DESTINATIONS, []);
  }

  // Clear all extension data
  async clearAll() {
    try {
      await this.storage.clear();
      console.log('BrowserStorage: Cleared all data');
      return true;
    } catch (error) {
      console.error('BrowserStorage: Error clearing data:', error);
      return false;
    }
  }

  // Check if extension is configured
  async isConfigured() {
    const connectionSettings = await this.getConnectionSettings();
    const currentContext = await this.getCurrentContext();

    return !!(
      connectionSettings.apiToken &&
      connectionSettings.serverUrl &&
      currentContext?.id
    );
  }
}

// Create singleton instance
export const browserStorage = new BrowserStorage();
export default browserStorage;

// Tab Manager module for Canvas Extension
// Handles browser tab operations and Canvas document conversion

import { browserStorage } from './browser-storage.js';
import { confirmLargeTabOperation } from './large-operation-confirm.js';

export class TabManager {
  constructor() {
    this.trackedTabs = new Map(); // tabId -> tab data
    this.syncedTabs = new Set(); // tabIds that are synced to Canvas
    this.pendingCanvasTabs = new Set(); // URLs of tabs being opened from Canvas (to prevent auto-sync race conditions)
    this.initialized = false;
    this.initializePromise = null;
    this.persistTrackedTabsTimer = null;

    // Browser compatibility
    this.tabsAPI = (typeof chrome !== 'undefined') ? chrome.tabs : browser.tabs;
    this.windowsAPI = (typeof chrome !== 'undefined') ? chrome.windows : browser.windows;
    this.tabGroupsAPI = (typeof chrome !== 'undefined' && chrome.tabGroups) ? chrome.tabGroups : (typeof browser !== 'undefined' ? browser.tabGroups : null);
  }

  async initialize() {
    if (this.initialized) return true;
    if (!this.initializePromise) {
      this.initializePromise = this.restoreTrackedTabs();
    }

    await this.initializePromise;
    return true;
  }

  async restoreTrackedTabs() {
    try {
      const storedTrackedTabs = await browserStorage.getTrackedCanvasTabs();
      const syncSettings = await browserStorage.getSyncSettings();
      const allTabs = await this.getAllTabs();

      const activeTabsById = new Map(allTabs.map((tab) => [String(tab.id), tab]));
      const activeTabsByUrl = new Map();
      for (const tab of allTabs) {
        if (!this.shouldSyncTab(tab)) continue;
        const key = normalizeTabUrl(tab.url, syncSettings);
        const tabsForUrl = activeTabsByUrl.get(key) || [];
        tabsForUrl.push(tab);
        activeTabsByUrl.set(key, tabsForUrl);
      }

      const restoredTabs = new Map(this.trackedTabs);
      const claimedTabIds = new Set([...restoredTabs.keys()].map((tabId) => String(tabId)));
      const trackedItems = Array.isArray(storedTrackedTabs) ? storedTrackedTabs : [];

      for (const item of trackedItems) {
        const documentId = item?.documentId;
        const storedUrl = typeof item?.url === 'string' && item.url ? normalizeTabUrl(item.url, syncSettings) : null;
        if (documentId === undefined || documentId === null || !storedUrl) continue;

        let matchedTab = null;
        const storedTabId = item?.tabId;
        if (storedTabId !== undefined && storedTabId !== null) {
          const candidate = activeTabsById.get(String(storedTabId));
          const candidateUrl = candidate?.url ? normalizeTabUrl(candidate.url, syncSettings) : null;
          if (candidate && candidateUrl === storedUrl && !claimedTabIds.has(String(candidate.id))) {
            matchedTab = candidate;
          }
        }

        if (!matchedTab) {
          const tabsForUrl = activeTabsByUrl.get(storedUrl) || [];
          matchedTab = tabsForUrl.find((tab) => !claimedTabIds.has(String(tab.id))) || null;
        }

        if (!matchedTab) continue;

        restoredTabs.set(matchedTab.id, {
          documentId: String(documentId),
          url: storedUrl
        });
        claimedTabIds.add(String(matchedTab.id));
      }

      this.trackedTabs = restoredTabs;
      this.syncedTabs = new Set(restoredTabs.keys());
      this.initialized = true;
      await this.persistTrackedTabsNow();
      console.log(`TabManager: Restored ${restoredTabs.size} tracked Canvas tab mappings`);
    } catch (error) {
      console.error('TabManager: Failed to restore tracked tabs:', error);
      this.initialized = true;
    } finally {
      this.initializePromise = null;
    }
  }

  schedulePersistTrackedTabs() {
    clearTimeout(this.persistTrackedTabsTimer);
    this.persistTrackedTabsTimer = setTimeout(() => {
      void this.persistTrackedTabsNow();
    }, 50);
  }

  async persistTrackedTabsNow() {
    try {
      const trackedTabs = Array.from(this.trackedTabs.entries()).map(([tabId, tabData]) => ({
        tabId,
        documentId: tabData?.documentId != null ? String(tabData.documentId) : null,
        url: tabData?.url || null
      })).filter((item) => item.documentId && item.url);

      await browserStorage.setTrackedCanvasTabs(trackedTabs);
    } catch (error) {
      console.error('TabManager: Failed to persist tracked tabs:', error);
    }
  }

  // Convert browser tab to Canvas document format (based on PAYLOAD.md format)
  convertTabToDocument(tab, browserIdentity, syncSettings = {}) {
    const normalizedUrl = normalizeTabUrl(tab.url, syncSettings);
    const document = {
      schema: 'data/abstraction/tab',
      schemaVersion: '2.0',
      data: {
        pinned: tab.pinned,
        url: normalizedUrl,
        title: tab.title,
        favIconUrl: tab.favIconUrl,
        timestamp: new Date().toISOString()
      },
      featureArray: this.generateFeatureArray(browserIdentity, syncSettings),
      metadata: {
        contentType: 'application/json',
        contentEncoding: 'utf8'
      }
    };

    console.log('Converted tab to Canvas document:', document);
    return document;
  }

  // Generate feature array for tab document
  generateFeatureArray(browserIdentity, syncSettings = {}) {
    const features = ['data/abstraction/tab'];

    // Add browser type
    if (browserIdentity) {
      if (browserIdentity.includes('chrome')) {
        features.push('client/app/chrome');
      } else if (browserIdentity.includes('firefox')) {
        features.push('client/app/firefox');
      } else if (browserIdentity.includes('edge')) {
        features.push('client/app/edge');
      } else if (browserIdentity.includes('safari')) {
        features.push('client/app/safari');
      }

      // Add browser identity string if "sync only current browser" is enabled
      if (syncSettings.syncOnlyCurrentBrowser) {
        features.push('client/app/browser-identity-string');
      }

      // Add instance identifier
      features.push(`tag/${browserIdentity}`);
    }

    // Add custom tag if "sync only tagged tabs" is enabled and tag is specified
    if (syncSettings.syncOnlyTaggedTabs && syncSettings.syncTagFilter) {
      features.push(`custom/tag/${syncSettings.syncTagFilter}`);
    }

    return features;
  }

  // Check if tab should be synced (exclude internal pages)
  shouldSyncTab(tab) {
    console.log('🔧 shouldSyncTab: Checking tab:', {
      id: tab?.id,
      url: tab?.url,
      title: tab?.title,
      status: tab?.status,
      discarded: tab?.discarded
    });

    if (!tab || !tab.url || !tab.title) {
      console.log('❌ shouldSyncTab: Tab missing basic fields:', {
        hasTab: !!tab,
        hasUrl: !!tab?.url,
        hasTitle: !!tab?.title
      });
      return false;
    }

    // Exclude internal browser pages and extension pages
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

    const excludedTitles = [
      'New Tab',
      'New tab',
      'Newtab',
      'about:blank'
    ];

    // Check protocols
    for (const protocol of excludedProtocols) {
      if (tab.url.startsWith(protocol)) {
        console.log(`❌ shouldSyncTab: Excluded protocol: ${protocol}`);
        return false;
      }
    }

    // Check specific URLs
    for (const url of excludedUrls) {
      if (tab.url === url) {
        console.log(`❌ shouldSyncTab: Excluded URL: ${url}`);
        return false;
      }
    }

    // Check titles (for pages that might have blank/new tab titles)
    for (const title of excludedTitles) {
      if (tab.title === title) {
        console.log(`❌ shouldSyncTab: Excluded title: ${title}`);
        return false;
      }
    }

    // Must have http or https protocol for valid web pages
    const isValidProtocol = tab.url.startsWith('http://') || tab.url.startsWith('https://');
    if (!isValidProtocol) {
      console.log(`❌ shouldSyncTab: Invalid protocol for URL: ${tab.url}`);
      return false;
    }

    console.log(`✅ shouldSyncTab: Tab is syncable: ${tab.title} (${tab.url})`);
    return true;
  }

  // Get all browser tabs
  async getAllTabs() {
    try {
      const tabs = await this.tabsAPI.query({});
      const syncSettings = await browserStorage.getSyncSettings();
      return await this.annotateStashedTabs(tabs, syncSettings);
    } catch (error) {
      console.error('Failed to get all tabs:', error);
      return [];
    }
  }

  async annotateStashedTabs(tabs, syncSettings = {}) {
    const groupTitle = syncSettings.chromiumStashGroupName || 'Stashed';
    const groupTitleById = new Map();

    if (this.tabGroupsAPI && typeof this.tabGroupsAPI.get === 'function') {
      const groupIds = new Set(
        tabs
          .map(tab => tab.groupId)
          .filter(groupId => Number.isInteger(groupId) && groupId >= 0)
      );

      for (const groupId of groupIds) {
        try {
          const group = await this.tabGroupsAPI.get(groupId);
          groupTitleById.set(groupId, group?.title || '');
        } catch {
          groupTitleById.set(groupId, '');
        }
      }
    }

    return tabs.map(tab => ({
      ...tab,
      stashed: tab.hidden === true || groupTitleById.get(tab.groupId) === groupTitle
    }));
  }

  // Get tabs that should be synced
  async getSyncableTabs() {
    const allTabs = await this.getAllTabs();
    console.log('Total browser tabs found:', allTabs.length);

    const syncableTabs = allTabs.filter(tab => {
      const shouldSync = this.shouldSyncTab(tab);
      if (!shouldSync) {
        console.log('Filtering out tab:', tab.title, tab.url, 'Status:', tab.status, 'Discarded:', tab.discarded);
      }
      return shouldSync;
    });

    console.log('Syncable tabs after filtering:', syncableTabs.length);
    return syncableTabs;
  }

  async getActiveSyncableTabs() {
    const tabs = await this.getSyncableTabs();
    return tabs.filter(tab => this.isActiveSyncCandidate(tab));
  }

  isActiveSyncCandidate(tab) {
    return this.shouldSyncTab(tab) && tab.discarded !== true && tab.hidden !== true && tab.stashed !== true;
  }

  // Get unsynced tabs
  async getUnsyncedTabs() {
    await this.initialize();
    const syncableTabs = await this.getSyncableTabs();
    return syncableTabs.filter(tab => !this.syncedTabs.has(tab.id));
  }

  // Track tab as synced
  markTabAsSynced(tabId, documentId = null, url = null) {
    this.syncedTabs.add(tabId);
    const tabData = this.trackedTabs.get(tabId) || {};
    if (documentId !== undefined && documentId !== null) tabData.documentId = String(documentId);
    if (url) tabData.url = url;
    if (Object.keys(tabData).length > 0) {
      this.trackedTabs.set(tabId, tabData);
      this.schedulePersistTrackedTabs();
    }
  }

  // Untrack tab
  unmarkTabAsSynced(tabId) {
    this.syncedTabs.delete(tabId);
    this.trackedTabs.delete(tabId);
    this.schedulePersistTrackedTabs();
  }

  // Check if tab is synced
  isTabSynced(tabId) {
    return this.syncedTabs.has(tabId);
  }

  // Check if URL is pending from Canvas (to prevent auto-sync)
  isUrlPendingFromCanvas(url) {
    return this.pendingCanvasTabs.has(url);
  }

  // Mark URL as pending from Canvas
  markUrlAsPendingFromCanvas(url) {
    this.pendingCanvasTabs.add(url);
  }

  // Unmark URL as pending from Canvas
  unmarkUrlAsPendingFromCanvas(url) {
    this.pendingCanvasTabs.delete(url);
  }

  // Get tab by ID
  async getTab(tabId) {
    try {
      const tab = await this.tabsAPI.get(tabId);
      return tab;
    } catch (error) {
      console.error('Failed to get tab:', error);
      return null;
    }
  }

  // Open URL in new tab
  async openTab(url, options = {}) {
    try {
      const tab = await this.tabsAPI.create({
        url,
        active: options.active !== false, // Default to active
        ...options
      });
      return tab;
    } catch (error) {
      console.error('Failed to open tab:', error);
      throw error;
    }
  }

  async openEmptyTab(options = {}) {
    try {
      return await this.tabsAPI.create({
        active: options.active !== false,
        ...options
      });
    } catch (error) {
      console.error('Failed to open empty tab:', error);
      throw error;
    }
  }

  // Close tab
  async closeTab(tabId) {
    try {
      await this.tabsAPI.remove(tabId);
      this.unmarkTabAsSynced(tabId);
      return true;
    } catch (error) {
      console.error('Failed to close tab:', error);
      return false;
    }
  }

  // Focus tab
  async focusTab(tabId) {
    try {
      const tab = await this.tabsAPI.get(tabId);
      await this.tabsAPI.update(tabId, { active: true });
      await this.windowsAPI.update(tab.windowId, { focused: true });
      return true;
    } catch (error) {
      console.error('Failed to focus tab:', error);
      return false;
    }
  }

  // Close multiple tabs
  async closeTabs(tabIds) {
    if (!await confirmLargeTabOperation('close', Array.isArray(tabIds) ? tabIds.length : 1)) {
      return false;
    }

    try {
      await this.tabsAPI.remove(tabIds);
      tabIds.forEach(tabId => this.unmarkTabAsSynced(tabId));
      return true;
    } catch (error) {
      console.error('Failed to close tabs:', error);
      return false;
    }
  }

  async unloadTabs(tabs, syncSettings = {}) {
    const validTabs = Array.isArray(tabs) ? tabs.filter(tab => tab?.id !== undefined && tab?.id !== null) : [];
    if (validTabs.length === 0) return { success: true, unloaded: 0, behavior: 'none' };

    const behavior = syncSettings.contextUnloadBehavior || 'close';
    if (behavior === 'discard') {
      return await this.discardTabs(validTabs);
    }
    if (behavior === 'stash') {
      return await this.stashTabs(validTabs, syncSettings);
    }

    const closed = await this.closeTabs(validTabs.map(tab => tab.id));
    return { success: closed, unloaded: closed ? validTabs.length : 0, behavior: 'close', aborted: !closed };
  }

  async discardTabs(tabs) {
    const validTabs = Array.isArray(tabs) ? tabs.filter(tab => tab?.id !== undefined && tab?.id !== null) : [];
    if (validTabs.length === 0 || typeof this.tabsAPI.discard !== 'function') {
      return { success: false, unloaded: 0, behavior: 'discard', error: 'tabs.discard is not available' };
    }

    const preparedTabs = await this.prepareTabsForUnload(validTabs);
    const tabIds = preparedTabs.map(tab => tab.id);
    if (tabIds.length === 0) return { success: true, unloaded: 0, behavior: 'discard' };

    try {
      await this.tabsAPI.discard(tabIds);
      return { success: true, unloaded: tabIds.length, behavior: 'discard' };
    } catch (error) {
      console.error('Failed to discard tabs:', error);
      return { success: false, unloaded: 0, behavior: 'discard', error: error.message };
    }
  }

  async stashTabs(tabs, syncSettings = {}) {
    const validTabs = Array.isArray(tabs) ? tabs.filter(tab => tab?.id !== undefined && tab?.id !== null) : [];
    if (validTabs.length === 0) return { success: true, unloaded: 0, behavior: 'stash' };

    const preparedTabs = await this.prepareTabsForUnload(validTabs);
    const tabIds = preparedTabs.map(tab => tab.id);
    if (tabIds.length === 0) return { success: true, unloaded: 0, behavior: 'stash' };

    const hiddenIds = await this.hideTabsIfAvailable(tabIds, syncSettings);
    const groupedIds = hiddenIds.length > 0 ? [] : await this.groupTabsIfAvailable(preparedTabs.filter(tab => !tab.pinned), syncSettings);
    let discardResult = { success: true, unloaded: 0 };

    if (syncSettings.stashDiscardTabs !== false) {
      discardResult = await this.discardTabs(preparedTabs);
    }

    return {
      success: hiddenIds.length > 0 || groupedIds.length > 0 || discardResult.success,
      unloaded: tabIds.length,
      behavior: 'stash',
      hidden: hiddenIds.length,
      grouped: groupedIds.length,
      discarded: discardResult.unloaded || 0
    };
  }

  async restoreTabs(tabs, syncSettings = {}) {
    const validTabs = Array.isArray(tabs) ? tabs.filter(tab => tab?.id !== undefined && tab?.id !== null) : [];
    if (validTabs.length === 0) return;

    const tabIds = validTabs.map(tab => tab.id);
    if (typeof this.tabsAPI.show === 'function') {
      try {
        await this.tabsAPI.show(tabIds);
      } catch (error) {
        console.warn('Failed to show stashed tabs:', error?.message || error);
      }
    }

    await this.ungroupStashedTabs(validTabs, syncSettings);
  }

  // Update tab
  async updateTab(tabId, updateProperties) {
    try {
      const tab = await this.tabsAPI.update(tabId, updateProperties);
      return tab;
    } catch (error) {
      console.error('Failed to update tab:', error);
      return null;
    }
  }

  async prepareTabsForUnload(tabs) {
    const allTabs = await this.getAllTabs();
    const unloadIds = new Set(tabs.map(tab => tab.id));
    const tabsByWindow = new Map();

    for (const tab of tabs) {
      if (!tab.active) continue;
      const windowTabs = tabsByWindow.get(tab.windowId) || [];
      windowTabs.push(tab);
      tabsByWindow.set(tab.windowId, windowTabs);
    }

    for (const [windowId] of tabsByWindow) {
      const replacement = allTabs.find(tab => tab.windowId === windowId && !unloadIds.has(tab.id));
      if (replacement) {
        await this.tabsAPI.update(replacement.id, { active: true });
      } else {
        await this.openEmptyTab({ active: true, windowId });
      }
    }

    return tabs;
  }

  async hideTabsIfAvailable(tabIds, syncSettings = {}) {
    if (syncSettings.firefoxHideStashedTabs === false || typeof this.tabsAPI.hide !== 'function') return [];

    try {
      return await this.tabsAPI.hide(tabIds);
    } catch (error) {
      console.warn('Failed to hide stashed tabs:', error?.message || error);
      return [];
    }
  }

  async groupTabsIfAvailable(tabs, syncSettings = {}) {
    if (!this.tabGroupsAPI || typeof this.tabsAPI.group !== 'function' || typeof this.tabGroupsAPI.update !== 'function') return [];

    const groupTitle = syncSettings.chromiumStashGroupName || 'Stashed';
    const candidateTabs = tabs.filter(tab => !tab.pinned);
    if (candidateTabs.length === 0) return [];
    const groupedIds = [];

    try {
      const group = await this.getExistingStashGroup(groupTitle);
      let groupId = group?.id ?? null;
      const targetWindowId = group?.windowId ?? candidateTabs[0].windowId;

      const tabIds = [];
      for (const tab of candidateTabs) {
        if (await this.isTabInGroup(tab, groupId, groupTitle)) continue;
        if (tab.windowId !== targetWindowId) {
          await this.tabsAPI.move(tab.id, { windowId: targetWindowId, index: -1 });
        }
        tabIds.push(tab.id);
      }
      if (tabIds.length === 0) return groupedIds;

      groupId = groupId === null
        ? await this.tabsAPI.group({ tabIds, createProperties: { windowId: targetWindowId } })
        : await this.tabsAPI.group({ tabIds, groupId });
      await this.tabGroupsAPI.update(groupId, {
        collapsed: true,
        title: groupTitle,
        color: 'grey'
      });
      groupedIds.push(...tabIds);
    } catch (error) {
      console.warn('Failed to group stashed tabs:', error?.message || error);
    }

    return groupedIds;
  }

  async getExistingStashGroup(title) {
    if (typeof this.tabGroupsAPI.query === 'function') {
      const groups = await this.tabGroupsAPI.query({ title });
      if (groups.length > 0) return groups[0];
    }
    return null;
  }

  async isTabInGroup(tab, groupId, expectedTitle) {
    if (!Number.isInteger(tab.groupId) || tab.groupId < 0) return false;
    if (groupId !== null && tab.groupId === groupId) return true;

    try {
      const group = await this.tabGroupsAPI.get(tab.groupId);
      return group?.title === expectedTitle;
    } catch {
      return false;
    }
  }

  async ungroupStashedTabs(tabs, syncSettings = {}) {
    if (!this.tabGroupsAPI || typeof this.tabsAPI.ungroup !== 'function' || typeof this.tabGroupsAPI.get !== 'function') return;

    const expectedGroupName = syncSettings.chromiumStashGroupName || 'Stashed';
    const tabIdsToUngroup = [];
    for (const tab of tabs) {
      if (!Number.isInteger(tab.groupId) || tab.groupId < 0) continue;

      try {
        const group = await this.tabGroupsAPI.get(tab.groupId);
        if (group?.title === expectedGroupName) tabIdsToUngroup.push(tab.id);
      } catch {
        // Group may have disappeared already.
      }
    }

    if (tabIdsToUngroup.length > 0) {
      try {
        await this.tabsAPI.ungroup(tabIdsToUngroup);
      } catch (error) {
        console.warn('Failed to ungroup restored stashed tabs:', error?.message || error);
      }
    }
  }

  // Check if tab exists
  async tabExists(tabId) {
    try {
      await this.tabsAPI.get(tabId);
      return true;
    } catch {
      return false;
    }
  }

  // Get synced tab data
  getSyncedTabData(tabId) {
    return this.trackedTabs.get(tabId);
  }

  getTrackedTabs() {
    return Array.from(this.trackedTabs.entries(), ([tabId, tabData]) => ({ tabId, ...tabData }));
  }

  async getDebugSnapshot() {
    await this.initialize();
    const allTabs = await this.getAllTabs();
    const syncableTabs = allTabs.filter((tab) => this.shouldSyncTab(tab));

    return {
      initialized: this.initialized,
      trackedTabs: this.getTrackedTabs(),
      syncedTabIds: Array.from(this.syncedTabs),
      syncableTabs: syncableTabs.map((tab) => ({
        id: tab.id,
        windowId: tab.windowId,
        url: tab.url,
        title: tab.title,
        pinned: tab.pinned,
        active: tab.active
      }))
    };
  }

  getTrackedTabIdsByDocumentIds(documentIds = []) {
    const wanted = new Set(
      (Array.isArray(documentIds) ? documentIds : [documentIds])
        .filter((id) => id !== undefined && id !== null)
        .map((id) => String(id))
    );
    if (wanted.size === 0) return [];

    const matches = [];
    for (const [tabId, tabData] of this.trackedTabs.entries()) {
      if (wanted.has(String(tabData?.documentId))) {
        matches.push(tabId);
      }
    }
    return matches;
  }

  // Generate hash for tab (for duplicate detection)
  generateTabHash(tab) {
    return `${tab.url}|${tab.title}`;
  }

  // Find duplicate tabs by URL
  async findDuplicateTabs(url, syncSettings = {}) {
    const allTabs = await this.getAllTabs();
    return this.findDuplicateTabsInList(url, allTabs, syncSettings);
  }

  normalizeUrl(rawUrl, syncSettings = {}) {
    return normalizeTabUrl(rawUrl, syncSettings);
  }

  findDuplicateTabsInList(url, tabs, syncSettings = {}) {
    const needle = normalizeTabUrl(url, syncSettings);
    return tabs.filter(tab => normalizeTabUrl(tab.url, syncSettings) === needle);
  }

  async findTabsMatchingUrls(urls, syncSettings = {}) {
    const needles = new Set((urls || []).map(url => normalizeTabUrl(url, syncSettings)).filter(Boolean));
    if (needles.size === 0) return [];
    const allTabs = await this.getAllTabs();
    return allTabs.filter(tab => needles.has(normalizeTabUrl(tab.url, syncSettings)));
  }

  // Canvas Integration Methods

  // Compare browser tabs with Canvas documents to determine sync state
  compareWithCanvasDocuments(browserTabs, canvasDocuments, syncSettings = {}) {
    const result = {
      browserToCanvas: [], // Browser tabs not in Canvas (need syncing)
      canvasToBrowser: [], // Canvas docs not open in browser
      synced: [] // Tabs that exist in both
    };

    // Create lookup maps for efficient comparison
    const browserTabsByUrl = new Map();
    const canvasDocsByUrl = new Map();

    // Index browser tabs by URL
    browserTabs.forEach(tab => {
      if (this.shouldSyncTab(tab)) {
        browserTabsByUrl.set(normalizeTabUrl(tab.url, syncSettings), tab);
      }
    });

    // Index Canvas documents by URL
    canvasDocuments.forEach(doc => {
      if (doc.schema === 'data/abstraction/tab' && doc.data?.url) {
        canvasDocsByUrl.set(normalizeTabUrl(doc.data.url, syncSettings), doc);
      }
    });

    // Find browser tabs not in Canvas
    browserTabsByUrl.forEach((tab, url) => {
      if (!canvasDocsByUrl.has(url)) {
        if (this.isActiveSyncCandidate(tab)) result.browserToCanvas.push(tab);
      } else {
        result.synced.push({
          browserTab: tab,
          canvasDoc: canvasDocsByUrl.get(url)
        });
        // Mark as synced in our tracking
        this.markTabAsSynced(tab.id, canvasDocsByUrl.get(url).id, canvasDocsByUrl.get(url).data?.url);
      }
    });

    // Find Canvas documents not open in browser
    canvasDocsByUrl.forEach((doc, url) => {
      if (!browserTabsByUrl.has(url)) {
        result.canvasToBrowser.push(doc);
      }
    });

    console.log('Tab sync comparison result:', {
      browserToCanvas: result.browserToCanvas.length,
      canvasToBrowser: result.canvasToBrowser.length,
      synced: result.synced.length
    });

    return result;
  }

  // Get tabs that need syncing to Canvas
  async getTabsToSync(canvasDocuments = [], syncSettings = {}) {
    const browserTabs = await this.getSyncableTabs();
    const comparison = this.compareWithCanvasDocuments(browserTabs, canvasDocuments, syncSettings);
    return comparison.browserToCanvas;
  }

  // Sync a browser tab to Canvas
  async syncTabToCanvas(tab, apiClient, contextId, browserIdentity, syncSettings = {}) {
    try {
      console.log(`🔧 TabManager.syncTabToCanvas: Starting sync for tab: ${tab.title} (${tab.url})`);

      if (!this.shouldSyncTab(tab)) {
        console.warn(`⚠️ TabManager.syncTabToCanvas: Tab is not syncable: ${tab.title}`);
        throw new Error('Tab is not syncable');
      }

      console.log('🔧 TabManager.syncTabToCanvas: Tab is syncable, proceeding with sync');

      // Convert tab to Canvas document format
      const document = this.convertTabToDocument(tab, browserIdentity, syncSettings);
      console.log('🔧 TabManager.syncTabToCanvas: Converted to document:', {
        schema: document.schema,
        url: document.data.url,
        title: document.data.title,
        featureArrayLength: document.featureArray?.length
      });

      console.log('🔧 TabManager.syncTabToCanvas: Making API call to insertDocument...');
      console.log('🔧 TabManager.syncTabToCanvas: API client details:', {
        hasApiClient: !!apiClient,
        hasInsertMethod: typeof apiClient?.insertDocument === 'function',
        apiToken: apiClient?.apiToken ? 'present' : 'missing',
        serverUrl: apiClient?.serverUrl || 'missing'
      });

      // Send to Canvas API (use insertDocument with feature array)
      const response = await apiClient.insertDocument(
        contextId,
        document,
        document.featureArray
      );

      console.log('🔧 TabManager.syncTabToCanvas: API response:', response);

      if (response.status === 'success') {
        // response.payload is now an array of document IDs
        const documentId = Array.isArray(response.payload) ? response.payload[0] : response.payload;

        // Mark tab as synced
        this.markTabAsSynced(tab.id, documentId, document.data?.url);

        console.log(`Tab synced successfully: ${tab.title}`);
        return {
          success: true,
          documentId: documentId,
          message: 'Tab synced to Canvas'
        };
      } else {
        throw new Error(response.message || 'Failed to sync tab');
      }
    } catch (error) {
      console.error('Failed to sync tab to Canvas:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Open a Canvas document as a browser tab
  async openCanvasDocument(canvasDoc, options = {}) {
    try {
      if (!canvasDoc.data?.url) {
        throw new Error('Canvas document has no URL');
      }

      console.log(`Opening Canvas document: ${canvasDoc.data.title} (${canvasDoc.data.url})`);

      // Mark URL as pending from Canvas to prevent auto-sync race conditions
      this.markUrlAsPendingFromCanvas(canvasDoc.data.url);

      try {
        // Check if tab is already open
        const existingTabs = await this.findDuplicateTabs(canvasDoc.data.url);
        if (existingTabs.length > 0 && !options.allowDuplicates) {
          // Focus existing tab instead
          const existingTab = existingTabs[0];
          await this.restoreTabs([existingTab], options.syncSettings || {});
          await this.tabsAPI.update(existingTab.id, { active: true });
          await this.windowsAPI.update(existingTab.windowId, { focused: true });

          // Mark as synced and remove from pending
          this.markTabAsSynced(existingTab.id, canvasDoc.id, canvasDoc.data?.url);

          return {
            success: true,
            tab: existingTab,
            message: 'Focused existing tab'
          };
        }

        // Open new tabs in the current browser context by default. Stored Canvas
        // window IDs are stale runtime state after restarts or across browsers.
        const baseOptions = {
          active: options.active !== false,
          pinned: canvasDoc.data.pinned || false
        };
        const preferredWindowId = options.restoreWindow === true && Number.isInteger(canvasDoc.data?.windowId)
          ? canvasDoc.data.windowId
          : undefined;

        let tab;
        if (preferredWindowId !== undefined) {
          try {
            tab = await this.openTab(canvasDoc.data.url, { ...baseOptions, windowId: preferredWindowId });
          } catch (err) {
            console.warn('Failed to open tab in preferred window, retrying without windowId:', err?.message || err);
            tab = await this.openTab(canvasDoc.data.url, baseOptions);
          }
        } else {
          tab = await this.openTab(canvasDoc.data.url, baseOptions);
        }

        // Mark as synced immediately to prevent auto-sync
        this.markTabAsSynced(tab.id, canvasDoc.id, canvasDoc.data?.url);

        console.log(`Canvas document opened successfully: ${canvasDoc.data.title}`);
        return {
          success: true,
          tab,
          message: 'Canvas document opened'
        };
      } finally {
        // Always clean up pending state
        this.unmarkUrlAsPendingFromCanvas(canvasDoc.data.url);
      }
    } catch (error) {
      console.error('Failed to open Canvas document:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async openCanvasDocuments(canvasDocs, options = {}, syncSettings = {}) {
    const documents = Array.isArray(canvasDocs) ? canvasDocs.filter(doc => doc?.data?.url) : [];
    if (documents.length === 0) {
      return { success: false, total: 0, successful: 0, failed: 0, results: [] };
    }

    const allTabs = await this.getAllTabs();
    const openUrls = new Set(allTabs.map(tab => normalizeTabUrl(tab.url, syncSettings)));
    const queuedUrls = new Set();
    const maxConcurrent = Math.max(1, options.maxConcurrent || 20);
    const delayMs = options.delayMs || 0;

    const work = [];
    for (const document of documents) {
      const urlKey = normalizeTabUrl(document.data.url, syncSettings);
      const duplicate = openUrls.has(urlKey) || queuedUrls.has(urlKey);
      if (!options.allowDuplicates && duplicate) {
        const existingTab = this.findDuplicateTabsInList(document.data.url, allTabs, syncSettings)[0] || null;
        if (existingTab) {
          await this.restoreTabs([existingTab], syncSettings);
          this.markTabAsSynced(existingTab.id, document.id, document.data?.url);
        }
        work.push({
          document,
          skipped: true,
          result: {
            success: true,
            tab: existingTab,
            skipped: true,
            message: existingTab ? 'Focused existing tab' : 'Duplicate tab already queued'
          }
        });
        continue;
      }

      queuedUrls.add(urlKey);
      work.push({ document, skipped: false });
    }

    const tabsToOpenCount = work.filter(item => !item.skipped).length;
    if (!await confirmLargeTabOperation('open', tabsToOpenCount)) {
      return { success: false, total: documents.length, successful: 0, skipped: 0, failed: documents.length, aborted: true, results: [] };
    }

    const results = [];
    for (let i = 0; i < work.length; i += maxConcurrent) {
      const batch = work.slice(i, i + maxConcurrent);
      const opened = await Promise.all(batch.map(async (item) => {
        if (item.skipped) return item;

        try {
          this.markUrlAsPendingFromCanvas(item.document.data.url);
          const tab = await this.openTab(item.document.data.url, {
            active: options.active !== false,
            pinned: item.document.data.pinned || false
          });
          this.markTabAsSynced(tab.id, item.document.id, item.document.data?.url);
          return { document: item.document, result: { success: true, tab, message: 'Canvas document opened' } };
        } catch (error) {
          return { document: item.document, result: { success: false, error: error.message } };
        } finally {
          this.unmarkUrlAsPendingFromCanvas(item.document.data.url);
        }
      }));

      results.push(...opened);
      if (i + maxConcurrent < work.length && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    const successful = results.filter(item => item.result?.success && !item.result?.skipped).length;
    const skipped = results.filter(item => item.result?.skipped).length;
    return {
      success: successful > 0 || skipped > 0,
      total: documents.length,
      successful,
      skipped,
      failed: documents.length - successful - skipped,
      results
    };
  }

  // Bulk sync multiple tabs
  async syncMultipleTabs(tabs, apiClient, contextId, browserIdentity, syncSettings = {}) {
    console.log(`🔧 TabManager.syncMultipleTabs: Starting batch sync of ${tabs.length} tabs to context ${contextId}`);
    console.log('🔧 TabManager.syncMultipleTabs: API client status:', {
      hasApiClient: !!apiClient,
      hasToken: !!apiClient?.apiToken,
      hasUrl: !!apiClient?.serverUrl
    });

    try {
      // Filter out non-syncable tabs
      const syncableTabs = tabs.filter(tab => {
        const canSync = this.shouldSyncTab(tab);
        if (!canSync) {
          console.warn(`⚠️ TabManager.syncMultipleTabs: Tab is not syncable: ${tab.title}`);
        }
        return canSync;
      });

      if (syncableTabs.length === 0) {
        console.warn('❌ TabManager.syncMultipleTabs: No syncable tabs found');
        return {
          success: false,
          total: tabs.length,
          successful: 0,
          failed: tabs.length,
          error: 'No syncable tabs found'
        };
      }

      console.log(`🔧 TabManager.syncMultipleTabs: Converting ${syncableTabs.length} syncable tabs to documents`);

      // Convert all tabs to documents
      const documents = syncableTabs.map(tab => this.convertTabToDocument(tab, browserIdentity, syncSettings));

      // Use batch API for better performance
      console.log(`🔧 TabManager.syncMultipleTabs: Making batch API call with ${documents.length} documents`);

      const response = await apiClient.insertDocuments(
        contextId,
        documents,
        documents[0]?.featureArray || [] // All tabs should have same feature array
      );

      console.log('🔧 TabManager.syncMultipleTabs: Batch API response:', response);

      if (response.status === 'success') {
        // response.payload is now an array of document IDs
        const documentIds = Array.isArray(response.payload) ? response.payload : [response.payload];
        syncableTabs.forEach((tab, index) => {
          const documentId = documentIds[index] || documentIds[0]; // Fallback to first ID if array mismatch
          this.markTabAsSynced(tab.id, documentId, documents[index]?.data?.url);
          console.log(`✅ TabManager.syncMultipleTabs: Marked tab ${tab.id} as synced with document ${documentId}`);
        });

        console.log(`✅ TabManager.syncMultipleTabs: Batch sync completed successfully: ${syncableTabs.length} tabs synced`);

        return {
          success: true,
          total: tabs.length,
          successful: syncableTabs.length,
          failed: tabs.length - syncableTabs.length,
          documentIds
        };
      } else {
        throw new Error(response.message || 'Batch sync failed');
      }

    } catch (error) {
      console.error('❌ TabManager.syncMultipleTabs: Batch sync failed:', error);

      // Fallback to individual sync if batch fails
      console.log('🔄 TabManager.syncMultipleTabs: Falling back to individual sync...');
      return await this.syncMultipleTabsIndividually(tabs, apiClient, contextId, browserIdentity, syncSettings);
    }
  }

  // Fallback method for individual tab syncing
  async syncMultipleTabsIndividually(tabs, apiClient, contextId, browserIdentity, syncSettings = {}) {
    console.log(`🔄 TabManager.syncMultipleTabsIndividually: Starting individual sync of ${tabs.length} tabs`);

    const results = [];

    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      console.log(`🔧 TabManager.syncMultipleTabsIndividually: Syncing tab ${i + 1}/${tabs.length}: ${tab.title}`);

      try {
        const result = await this.syncTabToCanvas(tab, apiClient, contextId, browserIdentity, syncSettings);
        console.log(`🔧 TabManager.syncMultipleTabsIndividually: Tab ${i + 1} result:`, result);
        results.push({
          tab,
          result
        });
      } catch (error) {
        console.error(`❌ TabManager.syncMultipleTabsIndividually: Tab ${i + 1} failed:`, error);
        results.push({
          tab,
          result: { success: false, error: error.message }
        });
      }
    }

    const successful = results.filter(r => r.result.success).length;
    console.log(`✅ TabManager.syncMultipleTabsIndividually: Individual sync completed: ${successful}/${tabs.length} tabs synced`);

    return {
      success: successful > 0,
      total: tabs.length,
      successful,
      failed: tabs.length - successful,
      results
    };
  }

  // Remove Canvas document (and optionally close browser tab)
  // NOTE: This method is deprecated in favor of handleRemoveCanvasDocument in service-worker.js
  // which properly handles both context and workspace modes with settings
  async removeCanvasDocument(canvasDoc, apiClient, contextId, closeTab = false) {
    try {
      console.log(`Removing Canvas document: ${canvasDoc.data?.title}`);

      // Remove from Canvas
      const response = await apiClient.deleteDocument(contextId, canvasDoc.id);

      if (response.status === 'success') {
        // Optionally close browser tab
        if (closeTab && canvasDoc.data?.url) {
          const matchingTabs = await this.findDuplicateTabs(canvasDoc.data.url);
          for (const tab of matchingTabs) {
            if (this.isTabSynced(tab.id)) {
              await this.closeTab(tab.id);
            }
          }
        }

        return {
          success: true,
          message: 'Canvas document removed'
        };
      } else {
        throw new Error(response.message || 'Failed to remove document');
      }
    } catch (error) {
      console.error('Failed to remove Canvas document:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

// Create singleton instance
export const tabManager = new TabManager();
export default tabManager;

// Utilities (keep at bottom)
function normalizeTabUrl(rawUrl, syncSettings = {}) {
  const removeUtmParameters = syncSettings?.removeUtmParameters !== false;
  if (!removeUtmParameters || !rawUrl || typeof rawUrl !== 'string') return rawUrl;

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return rawUrl;

    // Remove utm_* query params (case-insensitive), keep everything else (e.g. hgtid).
    const keys = [];
    for (const [key] of url.searchParams) {
      if (key.toLowerCase().startsWith('utm_')) keys.push(key);
    }
    for (const key of keys) url.searchParams.delete(key);

    const s = url.toString();
    return s.endsWith('?') ? s.slice(0, -1) : s;
  } catch {
    return rawUrl;
  }
}

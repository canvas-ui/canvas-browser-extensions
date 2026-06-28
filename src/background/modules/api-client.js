// API Client module for Canvas Extension
// Handles REST API communication with Canvas server

import { browserStorage } from './browser-storage.js';

export class AuthExpiredError extends Error {
  constructor(status) {
    super(`HTTP ${status}: session expired`);
    this.name = 'AuthExpiredError';
    this.status = status;
  }
}

const DEFAULT_WORKSPACE_TREE_NAME = 'context';

/**
 * Decode a JWT payload without verifying the signature.
 * Returns the parsed payload object, or null if the value is not a JWT
 * (e.g. opaque `canvas-` API/device tokens, which never expire).
 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Return the expiry of a JWT as a millisecond epoch timestamp,
 * or null if the token is not a JWT or carries no `exp` claim.
 */
export function getJwtExpiryMs(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') return null;
  return payload.exp * 1000;
}

export class CanvasApiClient {
  constructor() {
    this.baseUrl = null;
    this.apiBasePath = '/rest/v2';
    this.userToken = null;
    this.connected = false;
    this.appKey = 'canvas-extension';
    this.startedWorkspaces = new Set();
    this.requestStats = { count: 0, totalMs: 0, last: null };
  }

  // ---- Utilities ---------------------------------------------------------

  get apiToken() {
    return this.userToken;
  }

  set apiToken(value) {
    this.userToken = value;
  }

  /**
   * Normalize document IDs for SynapsD-backed workspace operations.
   * SynapsD's batch remove/delete expects numbers (strings will fail and trigger 400s).
   */
  normalizeDocumentIds(documentIds) {
    const raw = Array.isArray(documentIds) ? documentIds : [documentIds];
    const ids = raw.map((v) => {
      if (typeof v === 'number') return v;
      const n = Number(v);
      if (!Number.isFinite(n)) return NaN;
      return n;
    });
    const bad = ids.find((n) => !Number.isFinite(n));
    if (bad !== undefined) {
      throw new Error(`Invalid document ID(s): expected numbers (or numeric strings), got ${JSON.stringify(raw)}`);
    }
    return ids;
  }

  getWorkspaceTreeRoute(workspaceNameOrId, treeNameOrTreeId = DEFAULT_WORKSPACE_TREE_NAME) {
    const tree = treeNameOrTreeId || DEFAULT_WORKSPACE_TREE_NAME;
    return `/workspaces/${encodeURIComponent(workspaceNameOrId)}/trees/${encodeURIComponent(tree)}`;
  }

  async fetchDeleteWithJson(url, body) {
    const startedAt = performance.now();
    const endpoint = url.replace(`${this.baseUrl}${this.apiBasePath}`, '');
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: await this.buildHeaders(),
      body: JSON.stringify(body)
    });
    const durationMs = Math.round(performance.now() - startedAt);
    this.recordRequestMetric('DELETE', endpoint, durationMs);
    console.info(`API Timing: DELETE ${endpoint} ${durationMs}ms`);
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) throw new AuthExpiredError(resp.status);
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    return await resp.json();
  }

  // Initialize client with connection settings
  initialize(serverUrl, apiBasePath, apiToken) {
    const normalizedBaseUrl = serverUrl.replace(/\/$/, '');
    const connectionChanged = this.baseUrl !== normalizedBaseUrl || this.userToken !== apiToken;

    this.baseUrl = normalizedBaseUrl; // Remove trailing slash
    this.apiBasePath = apiBasePath;
    this.userToken = apiToken;

    if (connectionChanged) {
      this.startedWorkspaces.clear();
    }
  }

  // Build full API URL
  buildUrl(endpoint) {
    return `${this.baseUrl}${this.apiBasePath}${endpoint}`;
  }

  isBrowserScopedSyncEnabled(syncSettings) {
    return !!(syncSettings?.syncOnlyCurrentBrowser || syncSettings?.syncOnlyThisBrowser);
  }

  parseResponsePayload(response) {
    return response?.payload || response?.data || response;
  }

  recordRequestMetric(method, endpoint, durationMs) {
    this.requestStats.count += 1;
    this.requestStats.totalMs += durationMs;
    this.requestStats.last = { method, endpoint, durationMs, at: new Date().toISOString() };
  }

  getRequestStats() {
    return { ...this.requestStats };
  }

  resetRequestStats() {
    this.requestStats = { count: 0, totalMs: 0, last: null };
  }

  async ensureWorkspaceStarted(workspaceNameOrId) {
    const workspaceKey = encodeURIComponent(workspaceNameOrId);
    if (this.startedWorkspaces.has(workspaceKey)) return;

    await this.post(`/workspaces/${workspaceKey}/start`, {});
    this.startedWorkspaces.add(workspaceKey);
  }

  // Build request headers
  async buildHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-App-Name': this.appKey
    };

    if (this.userToken) {
      headers['Authorization'] = `Bearer ${this.userToken}`;
    }

    return headers;
  }

  // Generic HTTP request method
  async request(method, endpoint, data = null) {
    const url = this.buildUrl(endpoint);
    const headers = await this.buildHeaders();
    const startedAt = performance.now();

    // Firefox compatibility: avoid CORS issues for local network connections
    const isFirefox = typeof browser !== 'undefined' && browser.runtime;
    const isLocalNetwork = this.baseUrl.includes('127.0.0.1') || this.baseUrl.includes('172.16.') || this.baseUrl.includes('192.168.') || this.baseUrl.includes('10.');

    const requestOptions = {
      method,
      headers
    };

    // Firefox-specific handling for local network connections
    if (isFirefox && isLocalNetwork) {
      // Firefox: no CORS mode, no credentials for local network
      requestOptions.mode = 'no-cors';
      requestOptions.credentials = 'omit';
    } else if (!isLocalNetwork) {
      // Remote servers: use CORS mode
      requestOptions.mode = 'cors';
    }
    // Local network in Chrome: no mode specified (default behavior)

    if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      requestOptions.body = JSON.stringify(data);
    }

    try {
      console.log(`API Request: ${method} ${url}`, { mode: requestOptions.mode, isFirefox, isLocalNetwork });

      // Add timeout for Firefox to prevent hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      const response = await fetch(url, { ...requestOptions, signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new AuthExpiredError(response.status);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const responseData = await response.json();
      const durationMs = Math.round(performance.now() - startedAt);
      this.recordRequestMetric(method, endpoint, durationMs);
      console.info(`API Timing: ${method} ${endpoint} ${durationMs}ms`);
      console.log(`API Response: ${method} ${url}`, responseData);

      // Validate Canvas API response format
      if (responseData.status && responseData.status !== 'success') {
        throw new Error(`Canvas API Error: ${responseData.message || 'Unknown error'}`);
      }

      return responseData;
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error(`API Timeout: ${method} ${url} - request took longer than 10 seconds`);
        throw new Error(`Request timeout: server ${this.baseUrl} is not responding`);
      }

      // Firefox-specific error handling for local network
      if (typeof browser !== 'undefined' && browser.runtime) {
        const isLocalNetwork = this.baseUrl.includes('127.0.0.1') || this.baseUrl.includes('172.16.') || this.baseUrl.includes('192.168.') || this.baseUrl.includes('10.');
        if (isLocalNetwork && (error.message.includes('Failed to fetch') || error.name === 'AbortError')) {
          console.error(`Firefox local network connection blocked: ${error.message}`);

          const firefoxError = `
🚫 Firefox Security Block Detected

Firefox is blocking connections to your local Canvas server (${this.baseUrl}).

Quick Solutions:
1. ✅ EASIEST: Use Chrome/Edge for local development
2. 🔧 Firefox Fix: Go to about:config and set:
   - network.dns.blockDotOnion = false
   - security.fileuri.strict_origin_policy = false
3. 🌐 Alternative: Try 127.0.0.1:8001 instead of 172.16.x.x
4. 🔗 Tunnel: Use ngrok to create HTTPS tunnel

This is a Firefox security feature, not an extension bug.
`;

          console.error(firefoxError);
          throw new Error('Firefox blocked local network connection - see console for solutions');
        }
      }

      console.error(`API Error: ${method} ${url}`, error);
      throw error;
    }
  }

  // GET request
  async get(endpoint) {
    return await this.request('GET', endpoint);
  }

  // POST request
  async post(endpoint, data) {
    return await this.request('POST', endpoint, data);
  }

  // PUT request
  async put(endpoint, data) {
    return await this.request('PUT', endpoint, data);
  }

  // DELETE request
  async delete(endpoint) {
    return await this.request('DELETE', endpoint);
  }

  // Test connection to server
  async testConnection() {
    try {
      console.log(`Testing connection to ${this.baseUrl}${this.apiBasePath}`);

      // Test unauthenticated ping endpoint
      const pingUrl = `${this.baseUrl}${this.apiBasePath}/ping`;
      console.log(`Testing ping: ${pingUrl}`);

      // Firefox compatibility: avoid CORS issues for local network connections
      const isFirefox = typeof browser !== 'undefined' && browser.runtime;
      const isLocalNetwork = this.baseUrl.includes('127.0.0.1') || this.baseUrl.includes('172.16.') || this.baseUrl.includes('192.168.') || this.baseUrl.includes('10.');

      console.log(`Firefox: ${isFirefox}, Local Network: ${isLocalNetwork}`);

      // Firefox-specific: try multiple approaches for local network
      if (isFirefox && isLocalNetwork) {
        console.log('🔧 Firefox local network detected - trying multiple connection approaches...');

        // Try approach 1: no-cors mode (can't read response but checks if server is reachable)
        try {
          console.log('🔧 Trying no-cors mode...');
          const controller1 = new AbortController();
          const timeout1 = setTimeout(() => controller1.abort(), 5000); // 5 second timeout

          const pingResponse = await fetch(pingUrl, {
            method: 'GET',
            mode: 'no-cors',
            credentials: 'omit',
            signal: controller1.signal
          });
          clearTimeout(timeout1);

          console.log('✅ no-cors mode response received (opaque):', pingResponse);
          // no-cors mode returns opaque response, so we can't read it
          // but if we get here, the server is reachable
          if (pingResponse.type === 'opaque') {
            // Server is reachable, but we can't test authentication with no-cors
            return {
              success: true,
              connected: true,
              authenticated: false,
              message: 'Server reachable via no-cors mode - authentication test skipped',
              ping: { message: 'Server reachable (opaque response)' }
            };
          }
        } catch (error1) {
          console.warn('❌ no-cors mode failed:', error1);
        }

        // Try approach 2: no mode specified
        try {
          console.log('🔧 Trying no mode specified...');
          const controller2 = new AbortController();
          const timeout2 = setTimeout(() => controller2.abort(), 5000); // 5 second timeout

          const pingResponse = await fetch(pingUrl, {
            method: 'GET',
            credentials: 'omit',
            signal: controller2.signal
          });
          clearTimeout(timeout2);

          console.log('✅ no mode succeeded:', pingResponse);

          if (!pingResponse.ok) {
            throw new Error(`Ping failed: HTTP ${pingResponse.status} ${pingResponse.statusText}`);
          }

          let pingData;
          try {
            pingData = await pingResponse.json();
            console.log('Ping successful:', pingData);
          } catch (jsonError) {
            console.warn('Ping response is not JSON:', jsonError);
            pingData = { message: 'Server responded but not with JSON' };
          }

          // Continue to authentication test if we have a user token
          if (!this.userToken) {
            return {
              success: true,
              connected: true,
              authenticated: false,
              message: 'Server reachable but no API token provided',
              ping: pingData
            };
          }

          return await this.testAuthentication(pingData);
        } catch (error2) {
          console.warn('❌ no mode failed:', error2);
        }

        // Try approach 3: XMLHttpRequest (older but more compatible)
        try {
          console.log('🔧 Trying XMLHttpRequest...');
          const pingData = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.timeout = 10000;
            xhr.open('GET', pingUrl, true);
            xhr.setRequestHeader('Accept', 'application/json');

            xhr.onload = function() {
              if (xhr.status >= 200 && xhr.status < 300) {
                try {
                  const data = JSON.parse(xhr.responseText);
                  resolve(data);
                } catch {
                  resolve({ message: 'Server responded but not with JSON' });
                }
              } else {
                reject(new Error(`HTTP ${xhr.status}: ${xhr.statusText}`));
              }
            };

            xhr.onerror = function() {
              reject(new Error('XHR network error'));
            };

            xhr.ontimeout = function() {
              reject(new Error('XHR timeout'));
            };

            xhr.send();
          });

          console.log('✅ XMLHttpRequest succeeded:', pingData);

          // Continue to authentication test if we have a user token
          if (!this.userToken) {
            return {
              success: true,
              connected: true,
              authenticated: false,
              message: 'Server reachable but no API token provided',
              ping: pingData
            };
          }

          return await this.testAuthentication(pingData);
        } catch (error3) {
          console.warn('❌ XMLHttpRequest failed:', error3);
        }

        // All approaches failed - provide detailed Firefox instructions
        const firefoxInstructions = `
Firefox Security Error: Cannot connect to local server ${this.baseUrl}

This is a known Firefox security limitation. Try these solutions:

1. RECOMMENDED: Use Chrome for local Canvas development
2. OR modify Firefox settings:
   - Type 'about:config' in address bar
   - Set 'network.dns.blockDotOnion' to false
   - Set 'network.file.disable_unc_paths' to false
   - Set 'security.fileuri.strict_origin_policy' to false

3. OR use a different local IP:
   - Try 127.0.0.1:8001 instead of ${this.baseUrl}
   - Or use your machine's external IP

4. OR tunnel through HTTPS:
   - Use ngrok or similar to expose your local server
   - Connect to the HTTPS tunnel URL instead

Firefox blocks local network requests for security reasons.
`;

        console.error(firefoxInstructions);
        throw new Error('Firefox cannot connect to local server - see console for detailed instructions.');
      }

      // Non-Firefox or remote server: use standard approach
      const pingOptions = {
        method: 'GET'
      };

      if (!isLocalNetwork) {
        pingOptions.mode = 'cors';
      }

      console.log('Testing ping with options:', pingOptions);

      // Add timeout to prevent hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        const pingResponse = await fetch(pingUrl, { ...pingOptions, signal: controller.signal });
        clearTimeout(timeoutId);

        console.log(`Ping response status: ${pingResponse.status}, ok: ${pingResponse.ok}`);

        if (!pingResponse.ok) {
          throw new Error(`Ping failed: HTTP ${pingResponse.status} ${pingResponse.statusText}`);
        }

        let pingData;
        try {
          pingData = await pingResponse.json();
          console.log('Ping successful:', pingData);
        } catch (jsonError) {
          console.warn('Ping response is not JSON:', jsonError);
          pingData = { message: 'Server responded but not with JSON' };
        }

        // After successful ping, test authentication if we have a user token
        if (!this.userToken) {
          return {
            success: true,
            connected: true,
            authenticated: false,
            message: 'Server reachable but no API token provided',
            ping: pingData
          };
        }

        return await this.testAuthentication(pingData);
      } catch (fetchError) {
        clearTimeout(timeoutId);
        throw fetchError;
      }
    } catch (error) {
      console.error('Connection test failed:', error);
      this.connected = false;

      let errorMessage = error.message;
      if (error.name === 'AbortError') {
        errorMessage = `Connection timeout: server ${this.baseUrl} is not responding`;
      }

      return {
        success: false,
        connected: false,
        authenticated: false,
        error: errorMessage,
        message: 'Connection failed'
      };
    }
  }

  // Helper method to test authentication and return standardized response
  async testAuthentication(pingData) {
    try {
      console.log('Testing authenticated endpoint...');
      const userResponse = await this.get('/auth/me');
      console.log('Authentication response:', userResponse);

      // Validate Canvas API authentication response
      if (!userResponse || userResponse.status !== 'success') {
        throw new Error(`Authentication failed: ${userResponse?.message || 'Invalid response'}`);
      }

      if (!userResponse.payload || !userResponse.payload.id) {
        throw new Error('Authentication response missing user data');
      }

      this.connected = true;
      return {
        success: true,
        connected: true,
        authenticated: true,
        user: userResponse.payload,
        message: userResponse.message || 'Connection and authentication successful',
        ping: pingData
      };
    } catch (error) {
      console.error('Authentication test failed:', error);
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  // Authentication methods
  async getCurrentUser() {
    return await this.get('/auth/me');
  }

  async login(email, password) {
    const url = this.buildUrl('/auth/login');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.status !== 'success' || !data.payload?.token) {
        throw new Error(data?.message || `Login failed: HTTP ${response.status}`);
      }
      return data.payload; // { token, user }
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') throw new Error('Login request timed out');
      throw error;
    }
  }

  /**
   * Exchange the current (still-valid) JWT for a fresh one.
   * Only meaningful for credentials/JWT sessions; opaque API tokens never expire.
   * Throws AuthExpiredError if the current token is already expired/invalid.
   * Returns { token, expiresIn } on success.
   */
  async refreshUserToken() {
    const data = await this.post('/auth/token/refresh', {});
    const body = this.parseResponsePayload(data);
    const token = body?.token;
    if (!token) throw new Error('Token refresh did not return a new token');
    this.userToken = token;
    return { token, expiresIn: body?.expiresIn || null, user: body?.user || null };
  }

  // Expiry of the current user token (ms epoch), or null for non-JWT/non-expiring tokens.
  getUserTokenExpiryMs() {
    return getJwtExpiryMs(this.userToken);
  }

  // Context methods
  async getContexts() {
    return await this.get('/contexts');
  }

  async getContext(contextId) {
    return await this.get(`/contexts/${contextId}`);
  }



  async updateContext(contextId, contextData) {
    return await this.put(`/contexts/${contextId}`, contextData);
  }

  async updateContextUrl(contextId, url) {
    return await this.post(`/contexts/${contextId}/url`, { url });
  }

  // Context tree
  async getContextTree(contextId) {
    return await this.get(`/contexts/${contextId}/tree`);
  }

  async deleteContext(contextId) {
    return await this.delete(`/contexts/${contextId}`);
  }

  // Workspace methods
  async getWorkspaces() {
    return await this.get('/workspaces');
  }

  // Workspace lifecycle
  async startWorkspace(workspaceNameOrId) {
    return await this.post(`/workspaces/${encodeURIComponent(workspaceNameOrId)}/start`, {});
  }

  // Workspace tree
  async getWorkspaceTree(workspaceNameOrId, treeNameOrTreeId = DEFAULT_WORKSPACE_TREE_NAME) {
    await this.ensureWorkspaceStarted(workspaceNameOrId);
    return await this.get(this.getWorkspaceTreeRoute(workspaceNameOrId, treeNameOrTreeId));
  }

  async getWorkspaceDocuments(workspaceNameOrId, contextSpec = '/', featureArray = [], options = {}) {
    await this.ensureWorkspaceStarted(workspaceNameOrId);
    const enhancedFeatureArray = [...featureArray];
    if (!enhancedFeatureArray.includes('data/abstraction/tab')) {
      enhancedFeatureArray.unshift('data/abstraction/tab');
    }

    let endpoint = `/workspaces/${encodeURIComponent(workspaceNameOrId)}/documents`;

    const params = new URLSearchParams();
    params.set('treeNameOrTreeId', options.treeNameOrTreeId || DEFAULT_WORKSPACE_TREE_NAME);
    if (contextSpec) params.set('context', contextSpec);
    if (enhancedFeatureArray.length > 0) {
      enhancedFeatureArray.forEach(feature => params.append('allOf', feature));
    }
    if (Number.isFinite(options.limit)) params.set('limit', String(options.limit));
    if (Number.isFinite(options.offset)) params.set('offset', String(options.offset));

    const query = params.toString();
    if (query) endpoint += `?${query}`;

    return await this.get(endpoint);
  }

  async insertWorkspaceDocument(workspaceNameOrId, document, contextSpec = '/', featureArray = [], treeNameOrTreeId = DEFAULT_WORKSPACE_TREE_NAME) {
    await this.ensureWorkspaceStarted(workspaceNameOrId);
    const data = {
      treeNameOrTreeId: treeNameOrTreeId || DEFAULT_WORKSPACE_TREE_NAME,
      context: contextSpec,
      features: featureArray,
      documents: [document]
    };
    return await this.post(`/workspaces/${encodeURIComponent(workspaceNameOrId)}/documents`, data);
  }

  async insertWorkspaceDocuments(workspaceNameOrId, documents, contextSpec = '/', featureArray = [], treeNameOrTreeId = DEFAULT_WORKSPACE_TREE_NAME) {
    await this.ensureWorkspaceStarted(workspaceNameOrId);
    const data = {
      treeNameOrTreeId: treeNameOrTreeId || DEFAULT_WORKSPACE_TREE_NAME,
      context: contextSpec,
      features: featureArray,
      documents
    };
    return await this.post(`/workspaces/${encodeURIComponent(workspaceNameOrId)}/documents`, data);
  }

  async removeWorkspaceDocuments(workspaceNameOrId, documentIds, contextSpec = '/', featureArray = [], treeNameOrTreeId = DEFAULT_WORKSPACE_TREE_NAME) {
    await this.ensureWorkspaceStarted(workspaceNameOrId);
    // DELETE /workspaces/:id/documents/remove with body and query
    const endpoint = `/workspaces/${encodeURIComponent(workspaceNameOrId)}/documents/remove`;
    const url = new URL(this.buildUrl(endpoint));
    url.searchParams.set('treeNameOrTreeId', treeNameOrTreeId || DEFAULT_WORKSPACE_TREE_NAME);
    if (contextSpec) url.searchParams.set('context', contextSpec);
    if (Array.isArray(featureArray)) {
      for (const f of featureArray) url.searchParams.append('allOf', f);
    }
    const ids = this.normalizeDocumentIds(documentIds);
    return await this.fetchDeleteWithJson(url.toString(), ids);
  }

  async deleteWorkspaceDocuments(workspaceNameOrId, documentIds, contextSpec = '/', featureArray = [], treeNameOrTreeId = DEFAULT_WORKSPACE_TREE_NAME) {
    await this.ensureWorkspaceStarted(workspaceNameOrId);
    // DELETE /workspaces/:id/documents with body and query
    const endpoint = `/workspaces/${encodeURIComponent(workspaceNameOrId)}/documents`;
    const url = new URL(this.buildUrl(endpoint));
    url.searchParams.set('treeNameOrTreeId', treeNameOrTreeId || DEFAULT_WORKSPACE_TREE_NAME);
    if (contextSpec) url.searchParams.set('context', contextSpec);
    if (Array.isArray(featureArray)) {
      for (const f of featureArray) url.searchParams.append('allOf', f);
    }
    const ids = this.normalizeDocumentIds(documentIds);
    return await this.fetchDeleteWithJson(url.toString(), ids);
  }

  // Workspace tree operations.
  // Insert is PUT .../trees/{tree}/path/{encodedPath} — the path is the URL splat
  // (not a body field), matching the web UI and the `PUT /path/*` route.
  async insertWorkspacePath(workspaceNameOrId, path, data = null, autoCreateLayers = true, treeNameOrTreeId = DEFAULT_WORKSPACE_TREE_NAME) {
    await this.ensureWorkspaceStarted(workspaceNameOrId);
    const encodedPath = String(path || '/').split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const body = { autoCreateLayers };
    if (data && typeof data === 'object') Object.assign(body, data);
    return await this.put(`${this.getWorkspaceTreeRoute(workspaceNameOrId, treeNameOrTreeId)}/path/${encodedPath}`, body);
  }

  // Context tree operations
  async insertContextPath(contextId, path, autoCreateLayers = true) {
    return await this.post(`/contexts/${contextId}/tree/paths`, { path, autoCreateLayers });
  }

  // Document methods (tabs)
  async getContextDocuments(contextId, featureArray = [], options = {}) {
    // Always ensure we're looking for tab documents
    const enhancedFeatureArray = [...featureArray];
    if (!enhancedFeatureArray.includes('data/abstraction/tab')) {
      enhancedFeatureArray.unshift('data/abstraction/tab');
    }

    // Get sync settings to check if we should filter by browser instance
    const syncSettings = await browserStorage.getSyncSettings();
    if (this.isBrowserScopedSyncEnabled(syncSettings)) {
      const browserIdentity = await browserStorage.getBrowserIdentity();
      if (browserIdentity) {
        const browserTag = `tag/${browserIdentity}`;
        if (!enhancedFeatureArray.includes(browserTag)) {
          enhancedFeatureArray.push(browserTag);
        }
      }
    }

    let endpoint = `/contexts/${contextId}/documents`;

    const params = new URLSearchParams();

    // Add feature array as query parameters if provided
    if (enhancedFeatureArray.length > 0) {
      enhancedFeatureArray.forEach(feature => params.append('allOf', feature));
    }
    if (Number.isFinite(options.limit)) params.set('limit', String(options.limit));
    if (Number.isFinite(options.offset)) params.set('offset', String(options.offset));
    const query = params.toString();
    if (query) endpoint += `?${query}`;

    return await this.get(endpoint);
  }

  async insertDocument(contextId, document, featureArray = []) {
    // Always add browser identity for POST operations
    const enhancedFeatureArray = [...featureArray];
    const browserIdentity = await browserStorage.getBrowserIdentity();
    if (browserIdentity) {
      const browserTag = `tag/${browserIdentity}`;
      if (!enhancedFeatureArray.includes(browserTag)) {
        enhancedFeatureArray.push(browserTag);
      }
    }

    const data = {
      documents: document,  // Server expects "documents" (can be single object)
      features: enhancedFeatureArray
    };
    return await this.post(`/contexts/${contextId}/documents`, data);
  }

  async insertDocuments(contextId, documents, featureArray = []) {
    // Always add browser identity for POST operations
    const enhancedFeatureArray = [...featureArray];
    const browserIdentity = await browserStorage.getBrowserIdentity();
    if (browserIdentity) {
      const browserTag = `tag/${browserIdentity}`;
      if (!enhancedFeatureArray.includes(browserTag)) {
        enhancedFeatureArray.push(browserTag);
      }
    }

    const data = {
      documents,
      features: enhancedFeatureArray
    };
    return await this.post(`/contexts/${contextId}/documents`, data);
  }

  async updateDocument(contextId, documentId, document, featureArray = []) {
    // Always add browser identity for PUT operations
    const enhancedFeatureArray = [...featureArray];
    const browserIdentity = await browserStorage.getBrowserIdentity();
    if (browserIdentity) {
      const browserTag = `tag/${browserIdentity}`;
      if (!enhancedFeatureArray.includes(browserTag)) {
        enhancedFeatureArray.push(browserTag);
      }
    }

    const doc = typeof document === 'object' ? { ...document, id: documentId } : { id: documentId };
    const data = {
      documents: [doc],
      features: enhancedFeatureArray
    };
    return await this.put(`/contexts/${contextId}/documents`, data);
  }

  async removeDocument(contextId, documentId) {
    // Server route: DELETE /contexts/:id/documents/remove (body: [ids], optional featureArray query)
    const endpoint = `/contexts/${contextId}/documents/remove`;
    const url = new URL(this.buildUrl(endpoint));
    const ids = this.normalizeDocumentIds([documentId]);
    return await this.fetchDeleteWithJson(url.toString(), ids);
  }

  async removeDocuments(contextId, documentIds, featureArray = []) {
    // Server route: DELETE /contexts/:id/documents/remove (body: [ids], featureArray query)
    const endpoint = `/contexts/${contextId}/documents/remove`;
    const url = new URL(this.buildUrl(endpoint));
    if (Array.isArray(featureArray)) {
      for (const f of featureArray) url.searchParams.append('allOf', f);
    }
    const ids = this.normalizeDocumentIds(documentIds);
    return await this.fetchDeleteWithJson(url.toString(), ids);
  }

  async deleteDocument(contextId, documentId) {
    return await this.delete(`/contexts/${contextId}/documents/${documentId}`);
  }

  async deleteDocuments(contextId, documentIds) {
    // Server route: DELETE /contexts/:id/documents (body: [ids]) - direct DB deletion (owner-only)
    const endpoint = `/contexts/${contextId}/documents`;
    const url = new URL(this.buildUrl(endpoint));
    const ids = this.normalizeDocumentIds(documentIds);
    return await this.fetchDeleteWithJson(url.toString(), ids);
  }
}

// Create singleton instance
export const apiClient = new CanvasApiClient();
export default apiClient;

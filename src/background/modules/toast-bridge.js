// Popup toasts + OS notification fallback when the popup is closed.

const runtimeAPI = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime : browser.runtime;
const notificationsAPI = (typeof chrome !== 'undefined' && chrome.notifications)
  ? chrome.notifications
  : (typeof browser !== 'undefined' ? browser.notifications : null);

let syncBatch = { pages: 0, paths: new Set(), timer: null };
const SYNC_BATCH_MS = 1500;

function sendPopupToast(message, type) {
  try {
    const result = runtimeAPI.sendMessage({
      type: 'BACKGROUND_EVENT',
      eventType: 'ui.toast',
      data: { message, type }
    });
    if (result?.catch) result.catch(() => {});
  } catch { /* popup not open */ }
}

async function osNotify(title, message) {
  if (!notificationsAPI) return;
  try {
    await notificationsAPI.create({
      type: 'basic',
      iconUrl: 'assets/icons/logo-wr_128x128.png',
      title,
      message,
      priority: 1
    });
  } catch { /* ignore */ }
}

export function broadcastToast(message, type = 'info', { osFallback = false } = {}) {
  sendPopupToast(message, type);
  // OS notifications are opt-in only. Connection/sync errors recur on every
  // retry while offline or session-expired, so they rely on the toolbar
  // badge + in-popup banner instead of spamming the OS notification center.
  if (osFallback) {
    const title = type === 'error' ? 'Canvas Extension Error' : type === 'success' ? 'Synced' : 'Canvas';
    void osNotify(title, message);
  }
}

export function reportSyncSuccess(pages, path = null) {
  if (pages <= 0) return;
  let pathSuffix = '';
  if (path) pathSuffix = ` to ${path}`;
  const message = pages === 1 ? `Synced 1 page${pathSuffix}` : `Synced ${pages} pages${pathSuffix}`;
  broadcastToast(message, 'success', { osFallback: true });
}

export function queueSyncSuccess(path = null) {
  syncBatch.pages += 1;
  if (path) syncBatch.paths.add(path);
  clearTimeout(syncBatch.timer);
  syncBatch.timer = setTimeout(() => {
    const { pages, paths } = syncBatch;
    syncBatch = { pages: 0, paths: new Set(), timer: null };
    if (pages <= 0) return;
    const pathArg = paths.size === 1 ? [...paths][0] : paths.size > 1 ? null : null;
    if (paths.size > 1) {
      broadcastToast(`Synced ${pages} pages to ${paths.size} paths`, 'success', { osFallback: true });
    } else {
      reportSyncSuccess(pages, pathArg);
    }
  }, SYNC_BATCH_MS);
}

export function notifySyncError(error, label = 'Sync') {
  const msg = error?.message || String(error);
  const isAuth = error?.name === 'AuthExpiredError' || /session expired/i.test(msg);
  // No OS fallback: this fires on every retry while offline/expired and the
  // toolbar badge + in-popup banner already surface the persistent state.
  broadcastToast(isAuth ? 'Session expired — reconnect in Settings' : `${label} failed: ${msg}`, 'error');
}

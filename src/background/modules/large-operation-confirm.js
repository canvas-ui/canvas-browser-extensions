const notificationsAPI = (() => {
  if (typeof chrome !== 'undefined' && chrome.notifications) return chrome.notifications;
  if (typeof browser !== 'undefined' && browser.notifications) return browser.notifications;
  return null;
})();

export async function confirmLargeTabOperation(action, count) {
  if (count <= 50) return true;

  const message = `Canvas wants to ${action} ${count} browser tabs. Continue?`;
  console.warn(`Large tab operation: ${message}`);
  if (!notificationsAPI?.create || !notificationsAPI?.onButtonClicked || !notificationsAPI?.onClosed) return true;

  const notificationId = `canvas-large-tab-operation-${action}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    return await new Promise((resolve) => {
      let settled = false;
      const cleanup = (result) => {
        if (settled) return;
        settled = true;
        notificationsAPI.onButtonClicked.removeListener(handleButtonClicked);
        notificationsAPI.onClosed.removeListener(handleClosed);
        if (notificationsAPI.clear) void notificationsAPI.clear(notificationId);
        resolve(result);
      };
      const handleButtonClicked = (clickedNotificationId, buttonIndex) => {
        if (clickedNotificationId === notificationId) cleanup(buttonIndex === 0);
      };
      const handleClosed = (closedNotificationId) => {
        if (closedNotificationId === notificationId) cleanup(false);
      };

      notificationsAPI.onButtonClicked.addListener(handleButtonClicked);
      notificationsAPI.onClosed.addListener(handleClosed);
      const created = notificationsAPI.create(notificationId, {
        type: 'basic',
        iconUrl: 'assets/icons/logo-wr_128x128.png',
        title: 'Large tab operation',
        message,
        buttons: [{ title: 'OK' }, { title: 'Abort' }],
        priority: 2,
        requireInteraction: true
      });
      void Promise.resolve(created).catch((error) => {
        console.warn('Failed to show confirmation notification:', error?.message || error);
        cleanup(true);
      });
    });
  } catch (error) {
    console.warn('Failed to confirm large tab operation:', error?.message || error);
    return true;
  }
}

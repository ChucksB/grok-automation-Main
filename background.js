/* =========================================================
   Grok Video Automator – Background Service Worker
   ========================================================= */

'use strict';

// ── Installation / Update ────────────────────────────────

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    console.log('[GrokAutomator] Extension installed.');
  } else if (details.reason === 'update') {
    console.log(`[GrokAutomator] Extension updated to v${chrome.runtime.getManifest().version}`);
    // Clean up any stale automation data from previous sessions
    chrome.storage.local.remove('automationData', () => {
      console.log('[GrokAutomator] Cleared stale session data.');
    });
  }
});

// ── Message Relay ────────────────────────────────────────
// The background worker acts as a relay for messages between
// the popup and content scripts when the popup is closed.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Forward completion/error notifications to any open popup instances
  // The popup also listens directly via chrome.runtime.onMessage, so this
  // is mainly useful for when the popup is re-opened after a run completes.

  if (message && message.action === 'complete') {
    // Persist completion status for when the popup re-opens
    chrome.storage.local.set({
      lastRunStatus: {
        status:    'complete',
        total:     message.total,
        timestamp: Date.now(),
      }
    });
  }

  if (message && message.action === 'error') {
    chrome.storage.local.set({
      lastRunStatus: {
        status:    'error',
        text:      message.text,
        timestamp: Date.now(),
      }
    });
  }

  // Required to keep the message channel open for async responses
  return false;
});

// ── Keep-Alive Ping ──────────────────────────────────────
// Service workers in Manifest V3 may be killed if idle.
// The content script's ongoing loop keeps the extension
// alive via message passing, but we also register an alarm
// as a fallback to prevent premature suspension.

chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'keepAlive') {
    // No-op: just wakes the service worker
    console.log('[GrokAutomator] Keep-alive ping.');
  }
});

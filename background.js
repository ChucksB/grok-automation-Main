/* =========================================================
   Grok Video Automator – Background Service Worker
   Orchestrates the multi-page automation flow:
     1. grok.com/imagine/favorites  → upload image (navigates to post page)
     2. grok.com/imagine/post/<id>  → fill video prompt + click Make Video
     3. navigate back to favorites  → repeat for next pair
   ========================================================= */

'use strict';

// ── Automation State ──────────────────────────────────────────────────────────

let state = null;

function initState(tabId, data) {
  state = {
    active:       true,
    paused:       false,
    tabId,
    images:       data.images,
    prompts:      data.prompts,
    total:        data.total,
    currentIndex: 0,
    delay:        data.delay || 2000,
    // Phases: 'await_post_page' | 'await_favorites' | 'done'
    phase:        'await_post_page',
  };
}

function clearState() {
  state = null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(text, type = 'info') {
  console.log(`[GrokAutomator BG] [${type}] ${text}`);
  chrome.runtime.sendMessage({ action: 'log', text, type }).catch(() => {});
}

function broadcastProgress(current, total, status) {
  chrome.runtime.sendMessage({ action: 'progress', current, total, status }).catch(() => {});
}

async function waitIfPaused() {
  while (state && state.active && state.paused) {
    await sleep(300);
  }
}

/** Inject content.js (idempotent due to guard) then send a message. */
async function injectAndSend(tabId, message) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (_) { /* already injected or page not ready */ }
  return chrome.tabs.sendMessage(tabId, message);
}

// ── Automation Steps ──────────────────────────────────────────────────────────

async function doUpload() {
  if (!state || !state.active) return;
  await waitIfPaused();
  if (!state || !state.active) return;

  const i = state.currentIndex;
  log(`Item ${i + 1}/${state.total}: Sending upload command`);
  broadcastProgress(i + 1, state.total, `Uploading image ${i + 1} of ${state.total}…`);
  state.phase = 'await_post_page';

  try {
    await injectAndSend(state.tabId, {
      action: 'upload_image',
      image:  state.images[i],
      index:  i,
    });
  } catch (err) {
    log(`Item ${i + 1}: Upload command failed – ${err.message}`, 'error');
    chrome.runtime.sendMessage({ action: 'item_error', index: i, text: err.message }).catch(() => {});
    state.currentIndex++;
    if (state.active && state.currentIndex < state.total) {
      await doNavigateToFavorites();
    } else {
      await finish();
    }
  }
}

async function doFillPrompt() {
  if (!state || !state.active) return;
  await waitIfPaused();
  if (!state || !state.active) return;

  const i = state.currentIndex;
  log(`Item ${i + 1}/${state.total}: Sending fill-prompt command`);
  broadcastProgress(i + 1, state.total, `Filling video prompt for item ${i + 1} of ${state.total}…`);
  state.phase = 'fill_prompt';

  try {
    await injectAndSend(state.tabId, {
      action:  'fill_video_prompt',
      prompt:  state.prompts[i],
      index:   i,
    });
  } catch (err) {
    log(`Item ${i + 1}: Fill-prompt command failed – ${err.message}`, 'error');
    chrome.runtime.sendMessage({ action: 'item_error', index: i, text: err.message }).catch(() => {});
    state.currentIndex++;
    await doNavigateToFavorites();
  }
}

async function doNavigateToFavorites() {
  if (!state) return;
  state.phase = 'await_favorites';
  log('Navigating back to grok.com/imagine/favorites');
  try {
    await chrome.tabs.update(state.tabId, { url: 'https://grok.com/imagine/favorites' });
  } catch (err) {
    log(`Navigation failed: ${err.message}`, 'error');
  }
}

async function finish() {
  const total = state ? state.total : 0;
  log('All items complete!');
  clearState();
  chrome.runtime.sendMessage({ action: 'complete', total }).catch(() => {});
  chrome.storage.local.set({
    lastRunStatus: { status: 'complete', total, timestamp: Date.now() },
  });
}

// ── Tab URL Monitoring ────────────────────────────────────────────────────────
// Drives the state machine based on where the tab navigates to.

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!state || !state.active) return;
  if (tabId !== state.tabId)   return;
  if (changeInfo.status !== 'complete') return;

  const url = tab.url || '';

  // Image uploaded → Grok opened the post page
  if (state.phase === 'await_post_page' && url.includes('grok.com/imagine/post/')) {
    log(`Post page detected for item ${state.currentIndex + 1}`);
    await sleep(800); // Let the page settle
    await doFillPrompt();
    return;
  }

  // Back on favorites after clicking Make Video (or after an error)
  if (state.phase === 'await_favorites' && url.includes('grok.com/imagine/favorites')) {
    if (state.currentIndex < state.total) {
      if (state.currentIndex > 0 && state.delay > 0) {
        log(`Waiting ${state.delay / 1000}s before next item…`);
        await sleep(state.delay);
      }
      await doUpload();
    } else {
      await finish();
    }
  }
});

// ── Message Handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.action) return false;

  (async () => {
    switch (message.action) {

      case 'start': {
        if (state && state.active) {
          sendResponse({ ok: false, reason: 'already_running' });
          return;
        }
        initState(message.tabId, message.data);
        log(`Automation started | pairs=${state.total} | delay=${state.delay}ms`);
        sendResponse({ ok: true });
        await doUpload();
        break;
      }

      // Content script on the post page reports that Make Video was clicked
      case 'video_submitted': {
        if (!state) { sendResponse({ ok: false }); return; }
        const i = message.index;
        log(`Item ${i + 1}: Video submitted – moving on`);
        state.currentIndex++;
        sendResponse({ ok: true });
        // Navigate back to favorites; state machine continues from there
        await doNavigateToFavorites();
        break;
      }

      case 'pause': {
        if (state) state.paused = true;
        log('Paused.', 'info');
        sendResponse({ ok: true });
        break;
      }

      case 'resume': {
        if (state) state.paused = false;
        log('Resumed.', 'info');
        sendResponse({ ok: true });
        break;
      }

      case 'cancel': {
        log('Cancelled.', 'warning');
        clearState();
        chrome.runtime.sendMessage({ action: 'cancelled' }).catch(() => {});
        sendResponse({ ok: true });
        break;
      }

      case 'complete':
        chrome.storage.local.set({
          lastRunStatus: { status: 'complete', total: message.total, timestamp: Date.now() },
        });
        sendResponse({});
        break;

      case 'error':
        chrome.storage.local.set({
          lastRunStatus: { status: 'error', text: message.text, timestamp: Date.now() },
        });
        sendResponse({});
        break;

      default:
        sendResponse({});
    }
  })();

  return true; // Keep message channel open for async response
});

// ── Installation ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    console.log('[GrokAutomator] Extension installed.');
  } else if (details.reason === 'update') {
    console.log(`[GrokAutomator] Extension updated to v${chrome.runtime.getManifest().version}`);
    chrome.storage.local.remove('automationData', () => {
      console.log('[GrokAutomator] Cleared stale session data.');
    });
  }
});

// ── Keep-Alive ────────────────────────────────────────────────────────────────

chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'keepAlive') {
    console.log('[GrokAutomator] Keep-alive ping.');
  }
});

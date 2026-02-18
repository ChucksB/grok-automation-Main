/* =========================================================
   Grok Video Automator – Background Service Worker
   Flow:
     1. Send 'submit_pair' to content script on favorites page
     2. Content script: upload image, wait 5s, type prompt, wait 2s, click send
     3. Content script sends 'pair_done' back
     4. Background navigates to favorites
     5. When favorites loads → send next 'submit_pair'
   ========================================================= */

'use strict';

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
    phase:        'idle',
    pairTimeout:  null,
  };
}

function clearState() {
  if (state && state.pairTimeout) clearTimeout(state.pairTimeout);
  state = null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(text, type = 'info') {
  console.log(`[GrokAutomator BG] [${type}] ${text}`);
  chrome.runtime.sendMessage({ action: 'log', text, type }).catch(() => {});
}

function broadcastProgress(current, total, status) {
  chrome.runtime.sendMessage({ action: 'progress', current, total, status }).catch(() => {});
}

async function waitIfPaused() {
  while (state && state.active && state.paused) await sleep(300);
}

async function injectAndSend(tabId, msg) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); } catch (_) {}
  return chrome.tabs.sendMessage(tabId, msg);
}

// ── Steps ──────────────────────────────────────────────────────────────────────

async function doSubmitPair() {
  if (!state || !state.active) return;
  await waitIfPaused();
  if (!state || !state.active) return;

  const i = state.currentIndex;
  log(`Item ${i + 1}/${state.total}: Sending pair to content script`);
  broadcastProgress(i + 1, state.total, `Submitting item ${i + 1} of ${state.total}…`);
  state.phase = 'submitting';

  // Safety timeout: if content script never sends pair_done, skip after 70 s
  // (5s image load + 2s prompt wait + extra buffer)
  if (state.pairTimeout) clearTimeout(state.pairTimeout);
  state.pairTimeout = setTimeout(() => {
    if (state && state.active && state.phase === 'submitting') {
      log(`Item ${state.currentIndex + 1}: Timed out – skipping`, 'warning');
      chrome.runtime.sendMessage({ action: 'item_error', index: state.currentIndex, text: 'Timeout' }).catch(() => {});
      state.currentIndex++;
      if (state.currentIndex < state.total) doNavigateToFavorites();
      else finish();
    }
  }, 70000);

  try {
    await injectAndSend(state.tabId, {
      action: 'submit_pair',
      image:  state.images[i],
      prompt: state.prompts[i],
      index:  i,
    });
  } catch (err) {
    log(`Item ${i + 1}: Could not reach content script – ${err.message}`, 'error');
    if (state.pairTimeout) { clearTimeout(state.pairTimeout); state.pairTimeout = null; }
    chrome.runtime.sendMessage({ action: 'item_error', index: i, text: err.message }).catch(() => {});
    state.currentIndex++;
    if (state.active && state.currentIndex < state.total) await doNavigateToFavorites();
    else await finish();
  }
}

async function doNavigateToFavorites() {
  if (!state) return;
  state.phase = 'await_favorites';
  log('Navigating to grok.com/imagine/favorites');
  try { await chrome.tabs.update(state.tabId, { url: 'https://grok.com/imagine/favorites' }); }
  catch (err) { log(`Navigation failed: ${err.message}`, 'error'); }
}

async function finish() {
  const total = state ? state.total : 0;
  log(`All ${total} items complete!`);
  clearState();
  chrome.runtime.sendMessage({ action: 'complete', total }).catch(() => {});
  chrome.storage.local.set({ lastRunStatus: { status: 'complete', total, timestamp: Date.now() } });
}

// ── Tab URL Monitoring ─────────────────────────────────────────────────────────
// Only used to detect when the favorites page has fully loaded after navigation.

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!state || !state.active) return;
  if (tabId !== state.tabId) return;
  if (changeInfo.status !== 'complete') return;

  const url = tab.url || '';

  if (state.phase === 'await_favorites' && url.includes('grok.com/imagine/favorites')) {
    if (state.currentIndex < state.total) {
      if (state.delay > 0) {
        log(`Waiting ${state.delay / 1000}s before next item…`);
        await sleep(state.delay);
      }
      await doSubmitPair();
    } else {
      await finish();
    }
  }
});

// ── Messages ───────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.action) return false;

  (async () => {
    switch (message.action) {

      case 'start': {
        if (state && state.active) { sendResponse({ ok: false, reason: 'already_running' }); return; }
        initState(message.tabId, message.data);
        log(`Automation started | pairs=${state.total} | delay=${state.delay}ms`);
        sendResponse({ ok: true });
        await doSubmitPair();
        break;
      }

      // Content script finished upload + prompt + send — navigate to favorites
      case 'pair_done': {
        if (!state) { sendResponse({ ok: false }); return; }
        if (state.pairTimeout) { clearTimeout(state.pairTimeout); state.pairTimeout = null; }
        log(`Item ${message.index + 1}: Pair done – navigating to favorites`);
        state.currentIndex++;
        sendResponse({ ok: true });
        if (state.currentIndex < state.total) {
          await doNavigateToFavorites();
        } else {
          // Last item – still go to favorites to finish cleanly
          state.phase = 'await_favorites';
          await doNavigateToFavorites();
        }
        break;
      }

      case 'pause':  { if (state) state.paused = true;  log('Paused.');  sendResponse({ ok: true }); break; }
      case 'resume': { if (state) state.paused = false; log('Resumed.'); sendResponse({ ok: true }); break; }

      case 'cancel': {
        log('Cancelled.', 'warning');
        clearState();
        chrome.runtime.sendMessage({ action: 'cancelled' }).catch(() => {});
        sendResponse({ ok: true });
        break;
      }

      case 'complete':
        chrome.storage.local.set({ lastRunStatus: { status: 'complete', total: message.total, timestamp: Date.now() } });
        sendResponse({});
        break;

      case 'error':
        chrome.storage.local.set({ lastRunStatus: { status: 'error', text: message.text, timestamp: Date.now() } });
        sendResponse({});
        break;

      default:
        sendResponse({});
    }
  })();

  return true;
});

// ── Install / Keep-Alive ───────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') console.log('[GrokAutomator] Installed.');
  else if (details.reason === 'update') {
    console.log(`[GrokAutomator] Updated to v${chrome.runtime.getManifest().version}`);
    chrome.storage.local.remove('automationData');
  }
});

chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'keepAlive') console.log('[GrokAutomator] Keep-alive.');
});

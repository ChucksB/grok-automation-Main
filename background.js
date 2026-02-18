/* =========================================================
   Grok Video Automator – Background Service Worker
   Orchestrates:
     1. grok.com/imagine/favorites → upload image + type prompt + send
     2. Detect post page navigation → head back to favorites
     3. Repeat for next pair
   ========================================================= */

'use strict';

let state = null;

function initState(tabId, data) {
  state = {
    active:            true,
    paused:            false,
    tabId,
    images:            data.images,
    prompts:           data.prompts,
    total:             data.total,
    currentIndex:      0,
    delay:             data.delay || 2000,
    phase:             'idle',
    navigationTimeout: null,
  };
}

function clearState() {
  if (state && state.navigationTimeout) clearTimeout(state.navigationTimeout);
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

// ── Steps ─────────────────────────────────────────────────────────────────────

async function doSubmitPair() {
  if (!state || !state.active) return;
  await waitIfPaused();
  if (!state || !state.active) return;

  const i = state.currentIndex;
  log(`Item ${i + 1}/${state.total}: Submitting pair`);
  broadcastProgress(i + 1, state.total, `Submitting item ${i + 1} of ${state.total}…`);
  state.phase = 'await_post_page';

  try {
    await injectAndSend(state.tabId, {
      action: 'submit_pair',
      image:  state.images[i],
      prompt: state.prompts[i],
      index:  i,
    });

    // Timeout: if no post page in 45s, skip this item
    if (state.navigationTimeout) clearTimeout(state.navigationTimeout);
    state.navigationTimeout = setTimeout(() => {
      if (state && state.active && state.phase === 'await_post_page') {
        log(`Item ${state.currentIndex + 1}: Timed out waiting for post page`, 'warning');
        chrome.runtime.sendMessage({ action: 'item_error', index: state.currentIndex, text: 'Timeout' }).catch(() => {});
        state.currentIndex++;
        if (state.currentIndex < state.total) doNavigateToFavorites();
        else finish();
      }
    }, 45000);
  } catch (err) {
    log(`Item ${i + 1}: Submit failed – ${err.message}`, 'error');
    chrome.runtime.sendMessage({ action: 'item_error', index: i, text: err.message }).catch(() => {});
    state.currentIndex++;
    if (state.active && state.currentIndex < state.total) await doNavigateToFavorites();
    else await finish();
  }
}

async function doNavigateToFavorites() {
  if (!state) return;
  state.phase = 'await_favorites';
  log('Navigating back to favorites');
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

// ── Tab URL Monitoring ────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!state || !state.active) return;
  if (tabId !== state.tabId) return;
  if (changeInfo.status !== 'complete') return;

  const url = tab.url || '';

  // Pair submitted → Grok opened the post page → generation started → go back
  if (state.phase === 'await_post_page' && url.includes('grok.com/imagine/post/')) {
    state.phase = 'navigating_back'; // Lock immediately
    if (state.navigationTimeout) { clearTimeout(state.navigationTimeout); state.navigationTimeout = null; }
    log(`Post page detected for item ${state.currentIndex + 1} – heading back`);
    state.currentIndex++;
    await sleep(2000);
    if (state && state.currentIndex < state.total) await doNavigateToFavorites();
    else if (state) { state.phase = 'await_favorites'; await doNavigateToFavorites(); }
    return;
  }

  // Back on favorites – submit next pair
  if (state.phase === 'await_favorites' && url.includes('grok.com/imagine/favorites')) {
    if (state.currentIndex < state.total) {
      if (state.delay > 0) { log(`Waiting ${state.delay / 1000}s…`); await sleep(state.delay); }
      await doSubmitPair();
    } else {
      await finish();
    }
  }
});

// ── Messages ──────────────────────────────────────────────────────────────────

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
      case 'pause':  { if (state) state.paused = true;  log('Paused.');   sendResponse({ ok: true }); break; }
      case 'resume': { if (state) state.paused = false; log('Resumed.');  sendResponse({ ok: true }); break; }
      case 'cancel': { log('Cancelled.', 'warning'); clearState(); chrome.runtime.sendMessage({ action: 'cancelled' }).catch(() => {}); sendResponse({ ok: true }); break; }
      case 'complete': chrome.storage.local.set({ lastRunStatus: { status: 'complete', total: message.total, timestamp: Date.now() } }); sendResponse({}); break;
      case 'error':    chrome.storage.local.set({ lastRunStatus: { status: 'error', text: message.text, timestamp: Date.now() } }); sendResponse({}); break;
      default: sendResponse({});
    }
  })();
  return true;
});

// ── Install / Keep-Alive ──────────────────────────────────────────────────────

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

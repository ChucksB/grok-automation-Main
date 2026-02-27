/* =========================================================
   Grok Video Automator – Popup Script
   ========================================================= */

'use strict';

// ─── State ────────────────────────────────────────────────
let selectedImages = [];   // Array of { name, type, dataUrl }
let isRunning      = false;
let isPaused       = false;

// ─── DOM Refs ──────────────────────────────────────────────
const imageInput       = document.getElementById('image-input');
const imageCount       = document.getElementById('image-count');
const imagePreview     = document.getElementById('image-preview');
const dropZone         = document.getElementById('drop-zone');
const promptsTextarea  = document.getElementById('prompts-textarea');
const promptCount      = document.getElementById('prompt-count');
const loadPromptsBtn   = document.getElementById('load-prompts-btn');
const promptFileInput  = document.getElementById('prompt-file-input');
const delayInput       = document.getElementById('delay-input');
const timeoutInput     = document.getElementById('wait-timeout-input');
const startBtn         = document.getElementById('start-btn');
const pauseBtn         = document.getElementById('pause-btn');
const cancelBtn        = document.getElementById('cancel-btn');
const clearBtn         = document.getElementById('clear-btn');
const progressSection  = document.getElementById('progress-section');
const progressBar      = document.getElementById('progress-bar');
const progressText     = document.getElementById('progress-text');
const logList          = document.getElementById('log-list');
const statusBanner     = document.getElementById('status-banner');
const statusText       = document.getElementById('status-text');

// Selector inputs
const selFile      = document.getElementById('sel-file');
const selPrompt    = document.getElementById('sel-prompt');
const selGenerate  = document.getElementById('sel-generate');

// ─── Persistence ──────────────────────────────────────────

function saveUIState() {
  // Images are NOT persisted here — base64 image data is too large for
  // chrome.storage.local's 5 MB quota. Images must be re-uploaded if the
  // popup is closed. All other settings are small and safe to persist.
  chrome.storage.local.set({
    uiState: {
      prompts:     promptsTextarea.value,
      delay:       delayInput.value,
      timeout:     timeoutInput.value,
      selFile:     selFile.value,
      selPrompt:   selPrompt.value,
      selGenerate: selGenerate.value,
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────

function showBanner(message, type = 'info') {
  statusBanner.className = `status-banner ${type}`;
  statusText.textContent = message;
  statusBanner.classList.remove('hidden');
}

function hideBanner() {
  statusBanner.classList.add('hidden');
}

function addLog(message, type = 'info') {
  const li = document.createElement('li');
  li.className = `log-item log-${type}`;
  li.textContent = `[${timestamp()}] ${message}`;
  logList.appendChild(li);
  logList.scrollTop = logList.scrollHeight;
}

function timestamp() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function setProgress(current, total) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  progressBar.parentElement.setAttribute('aria-valuenow', pct);
  progressText.textContent = `Processing ${current} / ${total} (${pct}%)`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Parse text containing sequential "video prompt N: ..." blocks.
 * Supports both formats:
 *   video prompt 1: { ... }       ← JSON / plain text without parentheses
 *   video prompt (1): { ... }     ← parenthesised format
 * Each block runs from its marker to the next marker (or end of text).
 * The full content (including multi-line JSON) is preserved as-is.
 * Falls back to one-prompt-per-line when no markers are found.
 * @param {string} text
 * @returns {string[]}
 */
function parseVideoPrompts(text) {
  // Matches "video prompt 1:" OR "video prompt (1):" — parentheses optional
  const markerRe = /video\s+prompt\s*\(?\s*(\d+)\s*\)?\s*:/gi;
  const matches  = [...text.matchAll(markerRe)];

  if (matches.length === 0) {
    // Fallback: treat each non-empty line as a separate prompt
    return text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  }

  const pairs = [];
  for (let i = 0; i < matches.length; i++) {
    const num     = parseInt(matches[i][1], 10);
    const start   = matches[i].index + matches[i][0].length;
    const end     = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const content = text.slice(start, end).trim(); // preserves JSON newlines
    if (content) pairs.push({ num, content });
  }

  // Sort by prompt number so prompt (1) → index 0, (2) → index 1, etc.
  // regardless of the order they appear in the pasted text
  pairs.sort((a, b) => a.num - b.num);
  return pairs.map(p => p.content);
}

function getPrompts() {
  return parseVideoPrompts(promptsTextarea.value);
}

function updatePromptCount() {
  promptCount.textContent = getPrompts().length;
}

function clampNumberInput(input, delta) {
  const min = parseInt(input.min, 10);
  const max = parseInt(input.max, 10);
  const val = parseInt(input.value, 10) || min;
  input.value = Math.min(max, Math.max(min, val + delta));
}

// ─── Image Handling ────────────────────────────────────────

async function processFiles(files) {
  const allowed = Array.from(files).filter(f =>
    ['image/jpeg','image/png','image/gif'].includes(f.type)
  );

  if (!allowed.length) {
    showBanner('No valid images found (JPEG, PNG, GIF only).', 'warning');
    return;
  }

  const remaining = 100 - selectedImages.length;
  if (remaining <= 0) {
    showBanner('Maximum of 100 images already loaded.', 'warning');
    return;
  }

  const toAdd = allowed.slice(0, remaining);
  if (toAdd.length < allowed.length) {
    showBanner(`Only ${remaining} more images allowed; loading first ${toAdd.length}.`, 'warning');
  }

  for (const file of toAdd) {
    const dataUrl = await fileToBase64(file);
    selectedImages.push({ name: file.name, type: file.type, dataUrl });
  }

  // Always keep images sorted by filename so 01 → prompt 1, 02 → prompt 2, etc.
  selectedImages.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );

  renderPreviews();
  hideBanner();
}

function renderPreviews() {
  imagePreview.innerHTML = '';
  imageCount.textContent = selectedImages.length;

  selectedImages.forEach((img, idx) => {
    const li   = document.createElement('li');
    li.className = 'preview-item';

    const thumb = document.createElement('img');
    thumb.src = img.dataUrl;
    thumb.alt = img.name;
    thumb.className = 'preview-thumb';

    const name = document.createElement('span');
    name.className = 'preview-name';
    name.textContent = img.name;
    name.title = img.name;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'preview-remove';
    removeBtn.innerHTML = '×';
    removeBtn.setAttribute('aria-label', `Remove ${img.name}`);
    removeBtn.addEventListener('click', () => {
      selectedImages.splice(idx, 1);
      renderPreviews();
    });

    li.append(thumb, name, removeBtn);
    imagePreview.appendChild(li);
  });

  saveUIState();
}

// ─── Drop Zone ─────────────────────────────────────────────

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

['dragleave','dragend'].forEach(ev => {
  dropZone.addEventListener(ev, () => dropZone.classList.remove('drag-over'));
});

dropZone.addEventListener('drop', async e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  await processFiles(e.dataTransfer.files);
});

dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    imageInput.click();
  }
});

imageInput.addEventListener('change', async () => {
  await processFiles(imageInput.files);
  imageInput.value = '';  // allow re-selecting same files
});

// ─── Prompt Handling ───────────────────────────────────────

promptsTextarea.addEventListener('input', () => { updatePromptCount(); saveUIState(); });

loadPromptsBtn.addEventListener('click', () => promptFileInput.click());

promptFileInput.addEventListener('change', async () => {
  const file = promptFileInput.files[0];
  if (!file) return;

  const text = await file.text();

  if (file.name.endsWith('.json')) {
    let lines;
    try {
      const data = JSON.parse(text);
      lines = Array.isArray(data)
        ? data.map(item => typeof item === 'string' ? item : JSON.stringify(item))
        : [text];
    } catch {
      showBanner('Invalid JSON file.', 'error');
      return;
    }
    promptsTextarea.value = lines.slice(0, 100).join('\n');
  } else {
    // Plain text: store as-is so parseVideoPrompts() can detect "video prompt (N):" blocks
    promptsTextarea.value = text;
  }

  updatePromptCount();
  saveUIState();
  promptFileInput.value = '';
  showBanner(`Loaded ${getPrompts().length} prompt(s) from file.`, 'success');
});

// ─── Number Inputs ─────────────────────────────────────────

document.getElementById('delay-dec').addEventListener('click',   () => { clampNumberInput(delayInput,   -1);  saveUIState(); });
document.getElementById('delay-inc').addEventListener('click',   () => { clampNumberInput(delayInput,   +1);  saveUIState(); });
document.getElementById('timeout-dec').addEventListener('click', () => { clampNumberInput(timeoutInput, -10); saveUIState(); });
document.getElementById('timeout-inc').addEventListener('click', () => { clampNumberInput(timeoutInput, +10); saveUIState(); });
delayInput.addEventListener('change',   saveUIState);
timeoutInput.addEventListener('change', saveUIState);
selFile.addEventListener('input',       saveUIState);
selPrompt.addEventListener('input',     saveUIState);
selGenerate.addEventListener('input',   saveUIState);

// ─── UI State ──────────────────────────────────────────────

function setRunningUI(running) {
  isRunning = running;
  startBtn.hidden  =  running;
  pauseBtn.hidden  = !running;
  cancelBtn.hidden = !running;
  clearBtn.disabled = running;
  progressSection.hidden = !running;
  startBtn.disabled = false;
}

function resetUI() {
  setRunningUI(false);
  isPaused = false;
  pauseBtn.textContent = '';
  pauseBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
    Pause
  `;
  progressBar.style.width = '0%';
  progressText.textContent = '';
  logList.innerHTML = '';
}

// ─── Pause / Cancel ────────────────────────────────────────

pauseBtn.addEventListener('click', () => {
  isPaused = !isPaused;
  chrome.runtime.sendMessage({ action: isPaused ? 'pause' : 'resume' });
  pauseBtn.innerHTML = isPaused
    ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Resume`
    : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg> Pause`;
  showBanner(isPaused ? 'Automation paused.' : 'Automation resumed.', 'info');
});

cancelBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'cancel' });
  showBanner('Cancelling…', 'warning');
});

// ─── Clear ─────────────────────────────────────────────────

clearBtn.addEventListener('click', () => {
  selectedImages = [];
  renderPreviews();
  promptsTextarea.value = '';
  updatePromptCount();
  delayInput.value = '5';
  timeoutInput.value = '60';
  selFile.value = '';
  selPrompt.value = '';
  selGenerate.value = '';
  hideBanner();
  chrome.storage.local.remove(['uiState']);
});

// ─── Validation ────────────────────────────────────────────

function validate() {
  const prompts = getPrompts();

  if (selectedImages.length === 0) {
    showBanner('Please upload at least one image.', 'error');
    return false;
  }

  if (prompts.length === 0) {
    showBanner('Please enter at least one prompt.', 'error');
    return false;
  }

  const delay = parseInt(delayInput.value, 10);
  if (isNaN(delay) || delay < 1 || delay > 30) {
    showBanner('Delay must be between 1 and 30 seconds.', 'error');
    return false;
  }

  const timeout = parseInt(timeoutInput.value, 10);
  if (isNaN(timeout) || timeout < 10 || timeout > 300) {
    showBanner('Generation wait timeout must be between 10 and 300 seconds.', 'error');
    return false;
  }

  return true;
}

// ─── Start ─────────────────────────────────────────────────

document.getElementById('automation-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (isRunning) return;
  if (!validate()) return;

  hideBanner();

  const prompts = getPrompts();
  const delay   = parseInt(delayInput.value, 10) * 1000;
  const timeout = parseInt(timeoutInput.value, 10) * 1000;
  const count   = Math.min(selectedImages.length, prompts.length);

  const selectors = {
    fileInput:      selFile.value.trim()     || null,
    promptField:    selPrompt.value.trim()   || null,
    generateButton: selGenerate.value.trim() || null,
  };

  // Re-sort images by filename right before sending, in case files were added
  // in multiple batches or removed/re-added out of order.
  const sortedImages = [...selectedImages].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );

  const automationData = {
    images:     sortedImages.slice(0, count),
    prompts:    prompts.slice(0, count),
    delay,
    timeout,
    selectors,
    total:      count,
  };

  // Get the active tab
  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (err) {
    showBanner('Could not access current tab.', 'error');
    return;
  }

  const tab = tabs[0];
  if (!tab) {
    showBanner('No active tab found.', 'error');
    return;
  }

  // Check the URL
  const url = tab.url || '';
  const isGrokPage = url.includes('grok.com')
    || url.includes('grok.x.ai')
    || url.includes('x.com/grok')
    || url.includes('x.com/i/grok');
  if (!isGrokPage) {
    showBanner('Please navigate to Grok Imagine (grok.com/imagine/favorites) first.', 'warning');
    return;
  }

  setRunningUI(true);
  logList.innerHTML = '';
  addLog(`Starting automation: ${count} pair(s), ${delay/1000}s delay`, 'info');

  // Send start to the background service worker.
  // Background orchestrates all page navigations and content-script calls.
  try {
    await chrome.runtime.sendMessage({ action: 'start', tabId: tab.id, data: automationData });
  } catch (err) {
    showBanner(`Failed to start: ${err.message}`, 'error');
    setRunningUI(false);
  }
});

// ─── Message Listener (from content script) ────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.action) return;

  switch (message.action) {

    case 'progress':
      setProgress(message.current, message.total);
      addLog(message.status, 'info');
      break;

    case 'log':
      addLog(message.text, message.type || 'info');
      break;

    case 'complete':
      setProgress(message.total, message.total);
      addLog(`Automation complete! Processed ${message.total} item(s).`, 'success');
      showBanner(`Done! ${message.total} video generation(s) submitted.`, 'success');
      setRunningUI(false);
      // Browser notification
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Grok Video Automator',
        message: `Automation complete! ${message.total} item(s) processed.`,
      });
      break;

    case 'error':
      addLog(`Error: ${message.text}`, 'error');
      showBanner(`Error: ${message.text}`, 'error');
      setRunningUI(false);
      break;

    case 'cancelled':
      addLog('Automation cancelled by user.', 'warning');
      showBanner('Automation cancelled.', 'warning');
      setRunningUI(false);
      break;

    case 'item_error':
      addLog(`Item ${message.index + 1} error: ${message.text}`, 'error');
      break;
  }
});

// ─── Init ──────────────────────────────────────────────────

(function init() {
  chrome.storage.local.get(['uiState'], result => {
    // Restore settings/prompts (images are not persisted — too large for storage quota)
    if (result.uiState) {
      const s = result.uiState;
      if (s.prompts !== undefined)     promptsTextarea.value = s.prompts;
      if (s.delay !== undefined)       delayInput.value      = s.delay;
      if (s.timeout !== undefined)     timeoutInput.value    = s.timeout;
      if (s.selFile !== undefined)     selFile.value         = s.selFile;
      if (s.selPrompt !== undefined)   selPrompt.value       = s.selPrompt;
      if (s.selGenerate !== undefined) selGenerate.value     = s.selGenerate;
    }

    updatePromptCount();
  });
})();

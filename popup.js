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

function getPrompts() {
  return promptsTextarea.value
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
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

promptsTextarea.addEventListener('input', updatePromptCount);

loadPromptsBtn.addEventListener('click', () => promptFileInput.click());

promptFileInput.addEventListener('change', async () => {
  const file = promptFileInput.files[0];
  if (!file) return;

  const text = await file.text();
  let lines;

  if (file.name.endsWith('.json')) {
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) {
        lines = data.map(item => typeof item === 'string' ? item : JSON.stringify(item));
      } else {
        lines = [text];
      }
    } catch {
      showBanner('Invalid JSON file.', 'error');
      return;
    }
  } else {
    lines = text.split('\n');
  }

  const limited = lines.slice(0, 100).join('\n');
  promptsTextarea.value = limited;
  updatePromptCount();
  promptFileInput.value = '';
  showBanner(`Loaded ${getPrompts().length} prompt(s) from file.`, 'success');
});

// ─── Number Inputs ─────────────────────────────────────────

document.getElementById('delay-dec').addEventListener('click',   () => clampNumberInput(delayInput, -1));
document.getElementById('delay-inc').addEventListener('click',   () => clampNumberInput(delayInput, +1));
document.getElementById('timeout-dec').addEventListener('click', () => clampNumberInput(timeoutInput, -10));
document.getElementById('timeout-inc').addEventListener('click', () => clampNumberInput(timeoutInput, +10));

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
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    chrome.tabs.sendMessage(tabs[0].id, { action: isPaused ? 'pause' : 'resume' });
  });
  pauseBtn.innerHTML = isPaused
    ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Resume`
    : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg> Pause`;
  showBanner(isPaused ? 'Automation paused.' : 'Automation resumed.', 'info');
});

cancelBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    chrome.tabs.sendMessage(tabs[0].id, { action: 'cancel' });
  });
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
  chrome.storage.local.remove('automationData');
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

  const automationData = {
    images:     selectedImages.slice(0, count),
    prompts:    prompts.slice(0, count),
    delay,
    timeout,
    selectors,
    total:      count,
  };

  try {
    await chrome.storage.local.set({ automationData });
  } catch (err) {
    showBanner(`Storage error: ${err.message}`, 'error');
    return;
  }

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
  if (!url.includes('grok.x.ai') && !url.includes('x.com')) {
    showBanner('Please navigate to the Grok interface (grok.x.ai or x.com/grok) first.', 'warning');
    return;
  }

  setRunningUI(true);
  logList.innerHTML = '';
  addLog(`Starting automation: ${count} pair(s), ${delay/1000}s delay`, 'info');

  // Inject content script and start
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    await chrome.tabs.sendMessage(tab.id, { action: 'start' });
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
      chrome.storage.local.remove('automationData');
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
      chrome.storage.local.remove('automationData');
      break;

    case 'item_error':
      addLog(`Item ${message.index + 1} error: ${message.text}`, 'error');
      break;
  }
});

// ─── Init ──────────────────────────────────────────────────

(function init() {
  updatePromptCount();

  // Restore any saved data on popup open
  chrome.storage.local.get('automationData', result => {
    if (result.automationData) {
      const d = result.automationData;
      // If there's leftover data from a crashed session, offer to clear it
      showBanner('Previous session data found. Click "Clear all" to reset.', 'info');
    }
  });
})();

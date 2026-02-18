/* =========================================================
   Grok Video Automator – Content Script
   Injected into: grok.x.ai/*, x.com/grok*
   ========================================================= */

'use strict';

// Guard: prevent double-injection when script is re-executed
if (window.__grokAutomatorLoaded) {
  console.log('[GrokAutomator] Already loaded, skipping re-init.');
} else {
  window.__grokAutomatorLoaded = true;

  // ── State ────────────────────────────────────────────────
  let cancelled = false;
  let paused    = false;
  let running   = false;

  // ── Default DOM Selectors ────────────────────────────────
  // These target Grok's current interface. Update via the
  // Advanced selectors panel in the popup if Grok's UI changes.
  const DEFAULT_SELECTORS = {
    fileInput: [
      'input[type="file"][accept*="image"]',
      'input[type="file"]',
    ],
    promptField: [
      'textarea[placeholder]',
      '[contenteditable="true"]',
      'textarea',
      'div[role="textbox"]',
    ],
    generateButton: [
      'button[aria-label*="send" i]',
      'button[aria-label*="generat" i]',
      'button[type="submit"]',
      'button[data-testid*="send" i]',
      'button[data-testid*="submit" i]',
    ],
    uploadTrigger: [
      'button[aria-label*="attach" i]',
      'button[aria-label*="upload" i]',
      'button[aria-label*="image" i]',
      'label[for*="file" i]',
      'label[for*="upload" i]',
      '[data-testid*="attach" i]',
    ],
  };

  // ── Utilities ────────────────────────────────────────────

  function log(text, type = 'info') {
    console.log(`[GrokAutomator] [${type}] ${text}`);
    sendMessage({ action: 'log', text, type });
  }

  function sendMessage(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (_) {
      // Popup may be closed – silently ignore
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function waitIfPaused() {
    while (paused && !cancelled) {
      await sleep(200);
    }
  }

  /**
   * Finds the first element matching any selector in the array.
   * Polls every 300 ms until timeout.
   * @param {string[]} selectors
   * @param {number}   timeout   ms
   * @returns {Promise<Element|null>}
   */
  function findElement(selectors, timeout = 5000) {
    return new Promise(resolve => {
      const end = Date.now() + timeout;

      (function attempt() {
        for (const sel of selectors) {
          try {
            const el = document.querySelector(sel);
            if (el) return resolve(el);
          } catch (_) { /* skip invalid selectors */ }
        }
        if (Date.now() < end) {
          setTimeout(attempt, 300);
        } else {
          resolve(null);
        }
      })();
    });
  }

  /**
   * Wait until condFn() returns truthy, or reject on timeout.
   * @param {Function} condFn
   * @param {number}   timeout  ms
   * @param {number}   interval ms
   */
  function waitFor(condFn, timeout = 10000, interval = 300) {
    return new Promise((resolve, reject) => {
      const end = Date.now() + timeout;
      (function check() {
        if (condFn()) return resolve(true);
        if (Date.now() > end) return reject(new Error('waitFor: timed out'));
        setTimeout(check, interval);
      })();
    });
  }

  /**
   * Convert a base64 data URL string into a File object.
   * @param {string} dataUrl  e.g. "data:image/png;base64,..."
   * @param {string} filename
   * @param {string} mimeType
   * @returns {File}
   */
  function dataUrlToFile(dataUrl, filename, mimeType) {
    const [, base64] = dataUrl.split(',');
    const bstr = atob(base64);
    const u8arr = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) {
      u8arr[i] = bstr.charCodeAt(i);
    }
    return new File([u8arr], filename, { type: mimeType });
  }

  /**
   * Set a form control's value in a way that triggers React/Vue
   * synthetic event systems (native descriptor trick).
   * @param {HTMLInputElement|HTMLTextAreaElement} el
   * @param {string} value
   */
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  /**
   * Simulate realistic user typing into an input or contenteditable.
   * @param {HTMLElement} el
   * @param {string}      value
   */
  function simulateTyping(el, value) {
    el.focus();

    if (el.isContentEditable) {
      // Select all existing content then insert new text via execCommand.
      // This fires the native browser input events that React/Vue listen to.
      document.execCommand('selectAll', false, null);
      const inserted = document.execCommand('insertText', false, value);
      if (!inserted) {
        // execCommand not supported (rare) – fall back to direct assignment
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true, cancelable: true,
          inputType: 'insertText', data: value,
        }));
      }
    } else {
      setNativeValue(el, value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true }));
  }

  /**
   * Attach a File to an <input type="file"> and dispatch change events.
   * @param {HTMLInputElement} input
   * @param {File}             file
   */
  function simulateFileUpload(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input',  { bubbles: true }));
  }

  // ── Selector Resolution ──────────────────────────────────

  function resolveSelectors(custom) {
    return {
      fileInput:      custom.fileInput      ? [custom.fileInput]      : DEFAULT_SELECTORS.fileInput,
      promptField:    custom.promptField    ? [custom.promptField]    : DEFAULT_SELECTORS.promptField,
      generateButton: custom.generateButton ? [custom.generateButton] : DEFAULT_SELECTORS.generateButton,
      uploadTrigger:  DEFAULT_SELECTORS.uploadTrigger,
    };
  }

  // ── Core: Process one image + prompt pair ─────────────────

  /**
   * @param {{ name:string, type:string, dataUrl:string }} imageData
   * @param {string}  prompt
   * @param {number}  index        0-based
   * @param {object}  sels         resolved selectors
   * @param {number}  genTimeout   ms
   */
  async function processPair(imageData, prompt, index, sels, genTimeout) {
    const label = `Item ${index + 1}`;
    log(`${label}: Starting`);

    // ── 1. Upload image ────────────────────────────────────

    // Try to find the file input directly first (no trigger click needed)
    let fileInputEl = await findElement(sels.fileInput, 1500);

    // Only click an upload-trigger if the file input isn't directly accessible
    if (!fileInputEl) {
      const uploadTrigger = await findElement(sels.uploadTrigger, 2000);
      if (uploadTrigger) {
        log(`${label}: Clicking upload trigger to reveal file input`);
        uploadTrigger.click();
        await sleep(800);
        fileInputEl = await findElement(sels.fileInput, 5000);
      }
    }

    if (!fileInputEl) {
      throw new Error(`${label}: File input not found. Try setting a custom selector.`);
    }

    const file = dataUrlToFile(imageData.dataUrl, imageData.name, imageData.type);
    log(`${label}: Uploading "${imageData.name}"`);
    simulateFileUpload(fileInputEl, file);
    await sleep(1000);

    // ── 2. Set prompt ──────────────────────────────────────

    const promptEl = await findElement(sels.promptField, 5000);
    if (!promptEl) {
      throw new Error(`${label}: Prompt field not found. Try setting a custom selector.`);
    }

    log(`${label}: Entering prompt`);
    simulateTyping(promptEl, prompt);
    await sleep(500);

    // ── 3. Click Generate ──────────────────────────────────

    const generateBtn = await findElement(sels.generateButton, 5000);
    if (!generateBtn) {
      throw new Error(`${label}: Generate button not found. Try setting a custom selector.`);
    }

    if (generateBtn.disabled || generateBtn.getAttribute('aria-disabled') === 'true') {
      throw new Error(`${label}: Generate button is disabled. Image/prompt may not have been accepted.`);
    }

    log(`${label}: Clicking generate`);
    generateBtn.click();
    await sleep(500);

    // ── 4. Wait for generation to begin (optional, non-fatal) ─

    const detectTimeout = Math.min(genTimeout, 10000);
    try {
      await waitFor(() => {
        // Look for any loading/busy indicator
        const btn = document.querySelector(sels.generateButton[0]);
        return !btn
          || btn.disabled
          || btn.getAttribute('aria-disabled') === 'true'
          || !!document.querySelector(
              '[role="progressbar"], [aria-label*="loading" i], [class*="loading"], [class*="spinner"]'
            );
      }, detectTimeout, 300);
      log(`${label}: Generation appears to have started`);
    } catch (_) {
      log(`${label}: Could not confirm generation start – continuing anyway`, 'warning');
    }
  }

  // ── Main Automation Loop ──────────────────────────────────

  async function runAutomation(data) {
    const { images, prompts, delay, timeout, selectors, total } = data;
    const sels = resolveSelectors(selectors || {});

    log(`Automation started | pairs=${total} | delay=${delay}ms | timeout=${timeout}ms`);
    running = true;

    for (let i = 0; i < total; i++) {
      if (cancelled) break;

      await waitIfPaused();
      if (cancelled) break;

      sendMessage({
        action:  'progress',
        current: i + 1,
        total,
        status:  `Processing item ${i + 1} of ${total}`,
      });

      try {
        await processPair(images[i], prompts[i], i, sels, timeout);
      } catch (err) {
        log(`Item ${i + 1} failed: ${err.message}`, 'error');
        sendMessage({ action: 'item_error', index: i, text: err.message });
        // Non-fatal: continue with remaining items
      }

      // Wait between items (skip after the last one)
      if (!cancelled && i < total - 1) {
        log(`Waiting ${delay / 1000}s before next item…`);
        await sleep(delay);
      }
    }

    running = false;

    if (cancelled) {
      sendMessage({ action: 'cancelled' });
    } else {
      sendMessage({ action: 'complete', total });
    }
  }

  // ── Message Handler ───────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.action) return;

    switch (message.action) {

      case 'start':
        if (running) {
          log('Already running.', 'warning');
          sendResponse({ ok: false, reason: 'already_running' });
          return;
        }
        if (!message.data) {
          sendMessage({ action: 'error', text: 'No automation data received.' });
          sendResponse({ ok: false });
          return;
        }
        cancelled = false;
        paused    = false;
        // Data is passed directly in the message — no storage read needed.
        runAutomation(message.data).catch(err => {
          sendMessage({ action: 'error', text: err.message });
          running = false;
        });
        sendResponse({ ok: true });
        break;

      case 'pause':
        paused = true;
        log('Paused by user.', 'info');
        sendResponse({ ok: true });
        break;

      case 'resume':
        paused = false;
        log('Resumed by user.', 'info');
        sendResponse({ ok: true });
        break;

      case 'cancel':
        cancelled = true;
        paused    = false;   // unblock any pause loop
        log('Cancellation requested.', 'warning');
        sendResponse({ ok: true });
        break;
    }
  });

  log('Content script ready.');
}

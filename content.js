/* =========================================================
   Grok Video Automator – Content Script
   Injected into: grok.com/*

   Handles 'submit_pair' on grok.com/imagine/favorites:
     1. Clear any lingering file attachments
     2. Upload ONE image file
     3. Wait 5 s for image to load
     4. Ensure Video mode is selected
     5. Type the video prompt
     6. Wait 2 s
     7. Click the send button
     8. Send 'pair_done' → background navigates to favorites
   ========================================================= */

'use strict';

if (window.__grokAutomatorLoaded) {
  console.log('[GrokAutomator] Already loaded, skipping re-init.');
} else {
  window.__grokAutomatorLoaded = true;

  let submitting = false; // Guard against duplicate calls

  // ── Utilities ────────────────────────────────────────────

  function log(text, type = 'info') {
    console.log(`[GrokAutomator] [${type}] ${text}`);
    try { chrome.runtime.sendMessage({ action: 'log', text, type }); } catch (_) {}
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function findElement(selectors, timeout = 8000) {
    return new Promise(resolve => {
      const end = Date.now() + timeout;
      (function attempt() {
        for (const sel of selectors) {
          try { const el = document.querySelector(sel); if (el) return resolve(el); } catch (_) {}
        }
        if (Date.now() < end) setTimeout(attempt, 300);
        else resolve(null);
      })();
    });
  }

  /** Find ANY clickable element whose visible text contains `text` (case-insensitive). */
  function findClickableByText(text) {
    const lower = text.toLowerCase();
    for (const tag of ['button', 'a', '[role="button"]', 'label', '[role="menuitem"]']) {
      for (const el of document.querySelectorAll(tag)) {
        if (el.textContent.trim().toLowerCase().includes(lower)) return el;
      }
    }
    return null;
  }

  function dataUrlToFile(dataUrl, filename, mimeType) {
    const [, base64] = dataUrl.split(',');
    const bstr = atob(base64);
    const u8arr = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
    return new File([u8arr], filename, { type: mimeType });
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function simulateTyping(el, value) {
    el.focus();
    if (el.isContentEditable) {
      document.execCommand('selectAll', false, null);
      if (!document.execCommand('insertText', false, value)) {
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      }
    } else {
      setNativeValue(el, value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
      el.dispatchEvent(new Event('change',  { bubbles: true }));
    }
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true }));
  }

  /** Set exactly ONE file on a file input, replacing any existing selection. */
  function setOneFile(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input',  { bubbles: true }));
  }

  // ── Clear lingering attachments ───────────────────────────
  // Grok's React component tracks attachments in its own state.
  // We must remove previous files via the UI before each upload
  // to avoid the "max 3 files" error.

  async function clearAttachments() {
    // Click every remove/close button on existing attachment thumbnails
    const removeSelectors = [
      'button[aria-label*="remove" i]',
      'button[aria-label*="delete" i]',
      'button[aria-label*="clear" i]',
      'button[aria-label*="dismiss" i]',
      '[data-testid*="remove-attachment" i]',
      '[data-testid*="delete-attachment" i]',
    ];
    let removed = 0;
    for (const sel of removeSelectors) {
      for (const btn of document.querySelectorAll(sel)) {
        btn.click();
        removed++;
      }
    }

    // Also reset the native file input value so its FileList is empty
    for (const input of document.querySelectorAll('input[type="file"]')) {
      const empty = new DataTransfer();
      input.files = empty.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (removed > 0) {
      log(`Cleared ${removed} existing attachment(s)`);
      await sleep(500);
    }
  }

  // ── Submit Pair ───────────────────────────────────────────

  async function handleSubmitPair(imageData, prompt, index) {
    if (submitting) {
      log(`Item ${index + 1}: Already submitting – ignoring duplicate`, 'warning');
      return;
    }
    submitting = true;

    const label = `Item ${index + 1}`;
    log(`${label}: Starting`);

    try {
      // ── 0. Clear any leftover attachments ────────────────
      await clearAttachments();

      // ── 1. Upload exactly ONE image ──────────────────────
      const fileInput = await findElement([
        'input[type="file"][accept*="image"]',
        'input[type="file"]',
      ], 6000);

      if (!fileInput) {
        log(`${label}: File input not found`, 'error');
        try { chrome.runtime.sendMessage({ action: 'item_error', index, text: 'File input not found' }); } catch (_) {}
        return;
      }

      const file = dataUrlToFile(imageData.dataUrl, imageData.name, imageData.type);
      log(`${label}: Uploading "${imageData.name}"`);
      setOneFile(fileInput, file);

      // ── 2. Wait 5 s for image to load ───────────────────
      log(`${label}: Waiting 5 s for image to load…`);
      await sleep(5000);

      // ── 3. Ensure Video mode ─────────────────────────────
      const videoToggle = findClickableByText('video');
      if (videoToggle) {
        const alreadyActive = videoToggle.getAttribute('aria-selected') === 'true'
          || videoToggle.getAttribute('data-state') === 'active'
          || !!videoToggle.closest('[aria-selected="true"]');
        if (!alreadyActive) {
          log(`${label}: Selecting Video mode`);
          videoToggle.click();
          await sleep(400);
        }
      }

      // ── 4. Type the prompt ───────────────────────────────
      const textarea = await findElement([
        'textarea[placeholder*="imagine" i]',
        'textarea[placeholder*="type" i]',
        'textarea',
      ], 5000);

      if (!textarea) {
        log(`${label}: Textarea not found`, 'error');
        try { chrome.runtime.sendMessage({ action: 'item_error', index, text: 'Textarea not found' }); } catch (_) {}
        return;
      }

      log(`${label}: Typing prompt`);
      simulateTyping(textarea, prompt);

      // ── 5. Wait 2 s ──────────────────────────────────────
      log(`${label}: Waiting 2 s before sending…`);
      await sleep(2000);

      // ── 6. Click send button ─────────────────────────────
      let sendBtn = document.querySelector(
        'button[type="submit"], button[aria-label*="send" i], button[aria-label*="submit" i]'
      );
      if (!sendBtn) sendBtn = findClickableByText('send') || findClickableByText('submit');
      if (!sendBtn) {
        // Find the last button in the same container as the textarea
        const container = textarea.closest('form')
          || textarea.closest('[role="form"]')
          || textarea.parentElement?.parentElement?.parentElement;
        if (container) {
          const btns = Array.from(container.querySelectorAll('button'));
          if (btns.length) sendBtn = btns[btns.length - 1];
        }
      }

      if (sendBtn) {
        log(`${label}: Clicking send`);
        sendBtn.click();
      } else {
        log(`${label}: No send button found – pressing Enter`);
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
      }

      await sleep(500);
      log(`${label}: Done – telling background to navigate to favorites`);

    } finally {
      submitting = false;
    }

    // Tell background to navigate to favorites for the next pair
    try { chrome.runtime.sendMessage({ action: 'pair_done', index }); } catch (_) {}
  }

  // ── Message Handler ───────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.action) return;
    if (message.action === 'submit_pair') {
      handleSubmitPair(message.image, message.prompt, message.index)
        .catch(err => {
          log(`Submit error: ${err.message}`, 'error');
          submitting = false;
          try { chrome.runtime.sendMessage({ action: 'item_error', index: message.index, text: err.message }); } catch (_) {}
          try { chrome.runtime.sendMessage({ action: 'pair_done',   index: message.index }); } catch (_) {}
        });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false });
    }
  });

  log('Content script ready.');
}

/* =========================================================
   Grok Video Automator – Content Script
   Injected into: grok.com/*

   Handles 'submit_pair' on grok.com/imagine/favorites:
     1. Upload image to bottom bar file input
     2. Type video prompt in "Type to imagine" textarea
     3. Ensure Video mode is selected
     4. Click the send button → Grok navigates to post page
   ========================================================= */

'use strict';

if (window.__grokAutomatorLoaded) {
  console.log('[GrokAutomator] Already loaded, skipping re-init.');
} else {
  window.__grokAutomatorLoaded = true;

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
          try {
            const el = document.querySelector(sel);
            if (el) return resolve(el);
          } catch (_) {}
        }
        if (Date.now() < end) setTimeout(attempt, 300);
        else resolve(null);
      })();
    });
  }

  /** Find ANY clickable element (button, a, div, label, span) whose text includes `text`. */
  function findClickableByText(text) {
    const lower = text.toLowerCase();
    const tags = ['button', 'a', 'div[role="button"]', 'label', 'span[role="button"]'];
    for (const tag of tags) {
      const els = document.querySelectorAll(tag);
      for (const el of els) {
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
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true }));
  }

  function simulateFileUpload(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input',  { bubbles: true }));
  }

  // ── Submit Pair (favorites page) ───────────────────────────

  async function handleSubmitPair(imageData, prompt, index) {
    const label = `Item ${index + 1}`;
    log(`${label}: Starting submission`);

    // ── Step 1: Upload image ────────────────────────────────
    const fileInput = await findElement([
      'input[type="file"][accept*="image"]',
      'input[type="file"]',
    ], 5000);

    if (!fileInput) {
      log(`${label}: File input not found`, 'error');
      return;
    }

    const file = dataUrlToFile(imageData.dataUrl, imageData.name, imageData.type);
    log(`${label}: Uploading "${imageData.name}"`);
    simulateFileUpload(fileInput, file);
    await sleep(2000); // Wait for image thumbnail to appear in the bar

    // ── Step 2: Ensure "Video" mode ─────────────────────────
    const videoToggle = findClickableByText('video');
    if (videoToggle) {
      // Check if it's already active — look for aria-selected, data-active, or active class
      const isActive = videoToggle.getAttribute('aria-selected') === 'true'
        || videoToggle.getAttribute('data-state') === 'active'
        || videoToggle.classList.contains('active')
        || videoToggle.closest('[aria-selected="true"]');
      if (!isActive) {
        log(`${label}: Selecting Video mode`);
        videoToggle.click();
        await sleep(500);
      } else {
        log(`${label}: Video mode already active`);
      }
    } else {
      log(`${label}: Video toggle not found — assuming Video mode is default`, 'warning');
    }

    // ── Step 3: Type the prompt ─────────────────────────────
    const textarea = await findElement([
      'textarea[placeholder*="imagine" i]',
      'textarea[placeholder*="type" i]',
      'textarea',
    ], 5000);

    if (!textarea) {
      log(`${label}: Textarea not found`, 'error');
      return;
    }

    log(`${label}: Typing prompt`);
    simulateTyping(textarea, prompt);
    await sleep(500);

    // ── Step 4: Click the send button ───────────────────────
    let sendBtn = null;

    // Try common selectors
    sendBtn = document.querySelector(
      'button[type="submit"], button[aria-label*="send" i], button[aria-label*="submit" i]'
    );

    // Try finding by text
    if (!sendBtn) sendBtn = findClickableByText('send') || findClickableByText('submit');

    // Fallback: find the last button inside the same container as the textarea
    if (!sendBtn) {
      const container = textarea.closest('form')
        || textarea.closest('[role="form"]')
        || textarea.parentElement?.parentElement?.parentElement;
      if (container) {
        const buttons = Array.from(container.querySelectorAll('button'));
        if (buttons.length > 0) sendBtn = buttons[buttons.length - 1];
      }
    }

    if (sendBtn) {
      log(`${label}: Clicking send button`);
      sendBtn.click();
    } else {
      // Last resort: press Enter in the textarea
      log(`${label}: No send button found – pressing Enter`);
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
      }));
    }

    await sleep(500);
    log(`${label}: Submission complete – waiting for Grok to navigate`);
    // Background's tabs.onUpdated will detect the post page and continue
  }

  // ── Message Handler ───────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.action) return;

    if (message.action === 'submit_pair') {
      handleSubmitPair(message.image, message.prompt, message.index)
        .catch(err => {
          log(`Submit error: ${err.message}`, 'error');
          try { chrome.runtime.sendMessage({ action: 'item_error', index: message.index, text: err.message }); } catch (_) {}
        });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false });
    }
  });

  log('Content script ready.');
}

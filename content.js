/* =========================================================
   Grok Video Automator – Content Script
   Injected into: grok.com/*, grok.x.ai/*, x.com/grok*

   Page-specific responsibilities:
   - grok.com/imagine/favorites  → handle 'upload_image'
   - grok.com/imagine/post/<id>  → handle 'fill_video_prompt'
   ========================================================= */

'use strict';

if (window.__grokAutomatorLoaded) {
  console.log('[GrokAutomator] Already loaded, skipping re-init.');
} else {
  window.__grokAutomatorLoaded = true;

  // ── Utilities ────────────────────────────────────────────

  function log(text, type = 'info') {
    console.log(`[GrokAutomator] [${type}] ${text}`);
    try { chrome.runtime.sendMessage({ action: 'log', text, type }); } catch (_) {}
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Poll for first matching element across a list of CSS selectors. */
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

  /** Find a <button> whose visible text contains `text` (case-insensitive). */
  function findButtonByText(text) {
    const lower = text.toLowerCase();
    return Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent.trim().toLowerCase().includes(lower)) || null;
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
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
  }

  /** Type text into an input/textarea in a way React/Vue synthetic events detect. */
  function simulateTyping(el, value) {
    el.focus();
    if (el.isContentEditable) {
      document.execCommand('selectAll', false, null);
      if (!document.execCommand('insertText', false, value)) {
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true, cancelable: true, inputType: 'insertText', data: value,
        }));
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

  // ── Handler: Upload Image (favorites page) ────────────────
  // Attaches the file to Grok's hidden file input.
  // Grok then navigates automatically to /imagine/post/<id>.

  async function handleUploadImage(imageData, index) {
    const label = `Item ${index + 1}`;
    log(`${label}: Looking for "Upload image" button`);

    // The favorites page has TWO file inputs:
    //  1. The top-right "Upload image" button  → navigates to /imagine/post/<id>  ✓
    //  2. The bottom bar attachment icon       → queues for text generation        ✗
    // We must target the top-right one. Strategy: find the "Upload image" button
    // by text, click it to reveal its file input, then set files on that input.

    // Step 1: locate and click the "Upload image" button
    const uploadBtn = findButtonByText('upload image')
      || document.querySelector(
          'button[aria-label*="upload image" i], [data-testid*="upload-image" i]'
        );

    if (uploadBtn) {
      log(`${label}: Clicking "Upload image" button`);
      uploadBtn.click();
      await sleep(600);
    }

    // Step 2: grab the file input that just became active.
    // After clicking the button a file input is either already in the DOM
    // or gets appended by Grok's JS. We pick ALL file inputs and prefer the
    // one closest to the upload button (i.e. not inside the bottom prompt bar).
    const allInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    let fileInput = null;

    if (allInputs.length === 1) {
      fileInput = allInputs[0];
    } else if (allInputs.length > 1) {
      // Prefer whichever input is NOT inside the element that contains the
      // "Type to imagine" / bottom prompt textarea
      const bottomBar = document.querySelector('textarea[placeholder*="imagine" i]')
        ?.closest('form, [role="form"], div[class*="input"], div[class*="prompt"], div[class*="composer"]');
      fileInput = allInputs.find(inp => !bottomBar || !bottomBar.contains(inp))
               ?? allInputs[0];
      log(`${label}: Found ${allInputs.length} file inputs – picked the one outside the bottom bar`);
    }

    if (!fileInput) {
      // Fallback: look for a hidden file input anywhere
      fileInput = await findElement(['input[type="file"]'], 4000);
    }

    if (!fileInput) {
      const msg = `${label}: File input not found`;
      log(msg, 'error');
      try { chrome.runtime.sendMessage({ action: 'item_error', index, text: msg }); } catch (_) {}
      return;
    }

    const file = dataUrlToFile(imageData.dataUrl, imageData.name, imageData.type);
    log(`${label}: Uploading "${imageData.name}"`);
    simulateFileUpload(fileInput, file);
    // Grok will navigate to /imagine/post/<id> — background drives the next step
  }

  // ── Handler: Fill Video Prompt (post page) ────────────────
  // Finds the "Type to customize video…" textarea, types the prompt,
  // clicks "Make video", then tells the background to move on.

  async function handleFillVideoPrompt(prompt, index) {
    const label = `Item ${index + 1}`;
    log(`${label}: Filling video prompt`);

    // Find the video prompt textarea
    const promptSelectors = [
      'textarea[placeholder*="customize" i]',
      'textarea[placeholder*="video" i]',
      'textarea[placeholder*="prompt" i]',
      'textarea',
    ];
    const promptEl = await findElement(promptSelectors, 10000);

    if (!promptEl) {
      const msg = `${label}: Video prompt textarea not found`;
      log(msg, 'error');
      try { chrome.runtime.sendMessage({ action: 'item_error', index, text: msg }); } catch (_) {}
      // Tell background to move on so we don't get stuck
      try { chrome.runtime.sendMessage({ action: 'video_submitted', index }); } catch (_) {}
      return;
    }

    log(`${label}: Typing video prompt`);
    simulateTyping(promptEl, prompt);
    await sleep(600);

    // Find the "Make video" button
    let makeVideoBtn = findButtonByText('make video');
    if (!makeVideoBtn) {
      makeVideoBtn = document.querySelector(
        'button[aria-label*="make video" i], button[aria-label*="generate video" i]'
      );
    }

    if (!makeVideoBtn) {
      const msg = `${label}: "Make video" button not found`;
      log(msg, 'error');
      try { chrome.runtime.sendMessage({ action: 'item_error', index, text: msg }); } catch (_) {}
      try { chrome.runtime.sendMessage({ action: 'video_submitted', index }); } catch (_) {}
      return;
    }

    if (makeVideoBtn.disabled || makeVideoBtn.getAttribute('aria-disabled') === 'true') {
      const msg = `${label}: "Make video" button is disabled – prompt may not have registered`;
      log(msg, 'error');
      try { chrome.runtime.sendMessage({ action: 'item_error', index, text: msg }); } catch (_) {}
      try { chrome.runtime.sendMessage({ action: 'video_submitted', index }); } catch (_) {}
      return;
    }

    log(`${label}: Clicking "Make video"`);
    makeVideoBtn.click();
    await sleep(400);

    // Notify background → it will navigate back to favorites
    try { chrome.runtime.sendMessage({ action: 'video_submitted', index }); } catch (_) {}
  }

  // ── Message Handler ───────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.action) return;

    switch (message.action) {

      case 'upload_image':
        handleUploadImage(message.image, message.index)
          .catch(err => {
            log(`Upload error: ${err.message}`, 'error');
            try { chrome.runtime.sendMessage({ action: 'item_error', index: message.index, text: err.message }); } catch (_) {}
          });
        sendResponse({ ok: true });
        break;

      case 'fill_video_prompt':
        handleFillVideoPrompt(message.prompt, message.index)
          .catch(err => {
            log(`Fill-prompt error: ${err.message}`, 'error');
            try { chrome.runtime.sendMessage({ action: 'item_error', index: message.index, text: err.message }); } catch (_) {}
            try { chrome.runtime.sendMessage({ action: 'video_submitted', index: message.index }); } catch (_) {}
          });
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false });
    }
  });

  log('Content script ready.');
}

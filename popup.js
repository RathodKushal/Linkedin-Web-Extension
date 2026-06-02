document.addEventListener('DOMContentLoaded', () => {

  // ── DOM References ──────────────────────────────────────────
  const btnComment     = document.getElementById('btnComment');
  const btnReply       = document.getElementById('btnReply');
  const openSettingsBtn = document.getElementById('openSettingsBtn');
  const voicePreview   = document.getElementById('voicePreview');
  const postContent    = document.getElementById('postContent');
  const specificInsight = document.getElementById('specificInsight');
  const generateBtn    = document.getElementById('generateBtn');
  const resultsArea    = document.getElementById('resultsArea');
  const variationsList = document.getElementById('variationsList');

  let contextType = 'comment'; // 'comment' | 'reply'

  // ── Context Toggle ──────────────────────────────────────────
  btnComment.addEventListener('click', () => {
    contextType = 'comment';
    btnComment.classList.add('active');
    btnReply.classList.remove('active');
  });

  btnReply.addEventListener('click', () => {
    contextType = 'reply';
    btnReply.classList.add('active');
    btnComment.classList.remove('active');
  });

  // ── Settings Button ─────────────────────────────────────────
  openSettingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // ── Load Theme & Listen for Changes ───────────────────────
  chrome.storage.local.get(['theme'], (result) => {
    if (result.theme) {
      document.documentElement.setAttribute('data-theme', result.theme);
    }
  });

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.theme) {
      document.documentElement.setAttribute('data-theme', changes.theme.newValue || 'fire');
    }
  });

  // ── Voice Signature Preview ─────────────────────────────────
  chrome.storage.local.get(['styleProfile'], (result) => {
    const profile = result.styleProfile;
    if (profile && profile.comments && profile.comments.length > 0) {
      const recent = profile.comments[profile.comments.length - 1].text;
      voicePreview.textContent = `"${recent.substring(0, 100)}${recent.length > 100 ? '…' : ''}"`;
    }
  });

  // ── Tag Toggle Logic ────────────────────────────────────────
  document.querySelectorAll('.tag-cloud').forEach(cloud => {
    cloud.addEventListener('click', (e) => {
      const tag = e.target.closest('.tag');
      if (!tag) return;
      tag.classList.toggle('active');
    });
  });

  // ── Get selected tags from a cloud ──────────────────────────
  function getSelectedTags(cloudId) {
    return [...document.querySelectorAll(`#${cloudId} .tag.active`)]
      .map(t => t.dataset.value);
  }

  // ── Get selected comment mode ────────────────────────────────
  function getSelectedMode() {
    const radio = document.querySelector('input[name="commentMode"]:checked');
    return radio ? radio.value : 'tone_1';
  }

  // ── Tone strategy descriptions for the prompt ────────────────
  const toneStrategies = {
    tone_1: 'Agree → reframe → Sharp Questions: Elevate their point, add an up-to-date market truth (Australia/UK EdTech context), end with a question they cannot ignore.',
    tone_2: 'Agree → bold counter → Invite take: Validate their point first, then challenge one hidden assumption directly, close by asking what they would do differently.',
    tone_3: 'Pattern from 20+ projects: Drop a lived, specific observation from real exam prep builds you have done. Create authority and curiosity, and explicitly give an example of a company related to it.',
    tone_4: 'Cryptic Hook → Question: Open with a counterintuitive or provocative truth. Keep it short. End with a single open question that does the lead generation work.'
  };

  // ── Generate Button ──────────────────────────────────────────
  generateBtn.addEventListener('click', async () => {
    const postText = postContent.value.trim();
    if (!postText) {
      postContent.style.borderColor = '#f87171';
      postContent.focus();
      setTimeout(() => { postContent.style.borderColor = ''; }, 2000);
      return;
    }

    const selectedDomains = getSelectedTags('domainTags');
    const commentMode     = getSelectedMode();
    const insight         = specificInsight.value.trim();

    generateBtn.disabled  = true;
    generateBtn.textContent = '⏳  Generating variations…';
    resultsArea.classList.add('hidden');
    variationsList.innerHTML = '';

    chrome.storage.local.get(['targetPersona', 'targetMarket', 'selectedTopics'], (result) => {
      const persona = result.targetPersona || '';
      const market = result.targetMarket || 'australia';
      const selectedTopics = result.selectedTopics || [];

      chrome.runtime.sendMessage({
        action:         'GENERATE_ICP_COMMENT',
        contextType,
        postText,
        targetPersona:  persona,
        targetMarket:   market,
        selectedTopics,
        selectedDomains,
        commentMode,
        toneStrategy:   toneStrategies[commentMode],
        specificInsight: insight
      }, (response) => {
      generateBtn.disabled  = false;
      generateBtn.innerHTML = '✦&nbsp;&nbsp;Generate 3 variations in your voice';

      if (chrome.runtime.lastError || !response || !response.success) {
        const errMsg = response?.error || chrome.runtime.lastError?.message || 'Unknown error. Check the console.';
        showError(errMsg);
        return;
      }

      const variations = response.variations || [];
      if (variations.length === 0) {
        showError('AI returned no variations. Please try again.');
        return;
      }

      variations.forEach((text, i) => {
        const card = document.createElement('div');
        card.className = 'variation-card';
        card.innerHTML = `<div class="variation-text">${escapeHtml(text)}</div><span class="copy-hint">Click to copy</span>`;
        card.addEventListener('click', () => {
          navigator.clipboard.writeText(text).then(() => {
            card.classList.add('copied');
            card.querySelector('.copy-hint').textContent = '✓ Copied!';
            setTimeout(() => {
              card.classList.remove('copied');
              card.querySelector('.copy-hint').textContent = 'Click to copy';
            }, 2000);
          });
        });
        variationsList.appendChild(card);
      });

      resultsArea.classList.remove('hidden');
    });
    }); // end storage get
  });

  // ── Helpers ──────────────────────────────────────────────────
  function showError(msg) {
    variationsList.innerHTML = `<div style="color:#ef4444;font-size:12px;padding:10px;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;">⚠ ${msg}</div>`;
    resultsArea.classList.remove('hidden');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

});

document.addEventListener('DOMContentLoaded', () => {
  // Show / Hide toggle for API key inputs inside Advanced Settings
  document.querySelectorAll('.btn-toggle-visibility').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  const defaultToneSelect = document.getElementById('defaultTone');
  const commentLengthSelect = document.getElementById('commentLength');
  const userDesignationSelect = document.getElementById('userDesignation');
  const customDesignationGroup = document.getElementById('customDesignationGroup');
  const customDesignationInput = document.getElementById('customDesignation');
  const emojisEnabledCheckbox = document.getElementById('emojisEnabled');
  const addHookCheckbox = document.getElementById('addHook');
  const customPromptTextarea = document.getElementById('customPrompt');
  const saveBtn = document.getElementById('saveBtn');
  const statusToast = document.getElementById('statusToast');
  const themeSelect = document.getElementById('themeSelect');
  const styleEnabledCheckbox = document.getElementById('styleEnabled');
  const styleCountEl = document.getElementById('styleCount');
  const styleProgressFill = document.getElementById('styleProgressFill');
  const styleHint = document.getElementById('styleHint');
  const styleCommentsList = document.getElementById('styleCommentsList');
  const styleEmptyState = document.getElementById('styleEmptyState');
  const clearStyleBtn = document.getElementById('clearStyleBtn');
  const syncCommentsBtn = document.getElementById('syncCommentsBtn');
  const resetAnalyticsBtn = document.getElementById('resetAnalyticsBtn');

  // Details Tab Elements
  const targetPersonaInput = document.getElementById('targetPersona');
  const targetMarketSelect = document.getElementById('targetMarket');
  const saveDetailsBtn = document.getElementById('saveDetailsBtn');

  const MAX_STYLE = 30;

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.target).classList.add('active');

      if (btn.dataset.target === 'analytics-tab') loadAnalytics();
      if (btn.dataset.target === 'style-tab') loadStyleProfile();
    });
  });

  // Load saved settings
  chrome.storage.local.get([
    'defaultTone', 'commentLength', 'userDesignation', 'customDesignation',
    'emojisEnabled', 'addHook', 'customPrompt', 'stylePromptCount',
    'targetPersona', 'targetMarket', 'selectedTopics', 'theme',
    'apiKey_GEMINI', 'apiKey_GROQ'
  ], (result) => {
    if (result.defaultTone) defaultToneSelect.value = result.defaultTone;
    if (result.commentLength) commentLengthSelect.value = result.commentLength;
    if (result.userDesignation) {
      userDesignationSelect.value = result.userDesignation;
      if (result.userDesignation === 'custom') customDesignationGroup.classList.remove('hidden');
    }
    if (result.customDesignation) customDesignationInput.value = result.customDesignation;
    if (result.emojisEnabled !== undefined) emojisEnabledCheckbox.checked = result.emojisEnabled;
    if (result.addHook !== undefined) addHookCheckbox.checked = result.addHook;
    if (result.customPrompt) customPromptTextarea.value = result.customPrompt;
    if (result.theme && themeSelect) {
      themeSelect.value = result.theme;
      document.documentElement.setAttribute('data-theme', result.theme);
    }
    if (result.stylePromptCount) {
      const styleSelect = document.getElementById('stylePromptCount');
      if (styleSelect) styleSelect.value = result.stylePromptCount;
    }
    if (result.targetPersona && targetPersonaInput) targetPersonaInput.value = result.targetPersona;
    if (result.targetMarket && targetMarketSelect) targetMarketSelect.value = result.targetMarket;
    // Pre-fill API key inputs
    const geminiInput = document.getElementById('apiKeyGemini');
    const groqInput   = document.getElementById('apiKeyGroq');
    if (geminiInput && result.apiKey_GEMINI) geminiInput.value = result.apiKey_GEMINI;
    if (groqInput   && result.apiKey_GROQ)   groqInput.value   = result.apiKey_GROQ;
    
    if (result.selectedTopics) {
      document.querySelectorAll('#topicTags .tag').forEach(tag => {
        if (result.selectedTopics.includes(tag.dataset.value)) {
          tag.classList.add('active');
        }
      });
    }
  });

  // Tag Toggle Logic
  const topicTagsCloud = document.getElementById('topicTags');
  if (topicTagsCloud) {
    topicTagsCloud.addEventListener('click', (e) => {
      const tag = e.target.closest('.tag');
      if (!tag) return;
      tag.classList.toggle('active');
    });
  }

  userDesignationSelect.addEventListener('change', () => {
    if (userDesignationSelect.value === 'custom') {
      customDesignationGroup.classList.remove('hidden');
    } else {
      customDesignationGroup.classList.add('hidden');
    }
  });

  const stylePromptCountSelect = document.getElementById('stylePromptCount');
  if (stylePromptCountSelect) {
    stylePromptCountSelect.addEventListener('change', () => {
      chrome.storage.local.set({ stylePromptCount: stylePromptCountSelect.value }, () => {
        if (typeof loadStyleProfile === 'function') {
          loadStyleProfile();
        }
      });
    });
  }

  if (themeSelect) {
    themeSelect.addEventListener('change', () => {
      document.documentElement.setAttribute('data-theme', themeSelect.value);
    });
  }

  function showStatus(message, type = 'success') {
    statusToast.textContent = message;
    statusToast.className = `toast ${type}`;
    statusToast.classList.remove('hidden');
    setTimeout(() => statusToast.classList.add('hidden'), 4000);
  }

  saveBtn.addEventListener('click', () => {
    const geminiKey = document.getElementById('apiKeyGemini')?.value.trim();
    const groqKey   = document.getElementById('apiKeyGroq')?.value.trim();
    const toSave = {
      defaultTone: defaultToneSelect.value,
      commentLength: commentLengthSelect.value,
      emojisEnabled: emojisEnabledCheckbox.checked,
      addHook: addHookCheckbox.checked,
      customPrompt: customPromptTextarea.value.trim(),
      theme: themeSelect ? themeSelect.value : 'fire',
      stylePromptCount: document.getElementById('stylePromptCount') ? document.getElementById('stylePromptCount').value : '10'
    };
    if (geminiKey !== undefined) toSave.apiKey_GEMINI = geminiKey;
    if (groqKey   !== undefined) toSave.apiKey_GROQ   = groqKey;
    chrome.storage.local.set(toSave, () => {
      showStatus('Settings saved successfully!', 'success');
    });
  });

  if (saveDetailsBtn) {
    saveDetailsBtn.addEventListener('click', () => {
      const selectedTopics = [...document.querySelectorAll('#topicTags .tag.active')].map(t => t.dataset.value);
      chrome.storage.local.set({
        userDesignation: userDesignationSelect.value,
        customDesignation: customDesignationInput.value.trim(),
        targetPersona: targetPersonaInput.value.trim(),
        targetMarket: targetMarketSelect.value,
        selectedTopics: selectedTopics
      }, () => {
        showStatus('Details saved successfully!', 'success');
      });
    });
  }

  // Analytics
  function loadAnalytics() {
    chrome.storage.local.get(['analytics'], (result) => {
      const analytics = result.analytics || { history: [], tonesUsed: {} };
      const now = Date.now();
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
      const weekCount = analytics.history.filter(ts => ts > weekAgo).length;
      document.getElementById('stat-weekly').textContent = weekCount;
      const totalMinutes = weekCount * 2;
      let timeText = '';
      if (totalMinutes < 60) {
        timeText = `${totalMinutes}m`;
      } else {
        const hours = Math.floor(totalMinutes / 60);
        const mins = totalMinutes % 60;
        timeText = mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
      }
      document.getElementById('stat-time').textContent = timeText;
      const tones = analytics.tonesUsed || {};
      const topTone = Object.entries(tones).sort((a, b) => b[1] - a[1])[0];
      document.getElementById('stat-tone').textContent = topTone ? topTone[0] : '-';
    });
  }

  resetAnalyticsBtn.addEventListener('click', () => {
    chrome.storage.local.set({ analytics: { history: [], tonesUsed: {} } }, () => {
      loadAnalytics();
      showStatus('Analytics reset.', 'success');
    });
  });

  // My Style tab
  function loadStyleProfile() {
    chrome.storage.local.get(['styleProfile', 'stylePromptCount', 'cachedVoiceSignature'], (result) => {
      const profile = result.styleProfile || { enabled: true, comments: [] };
      // Use the user's chosen reference count as the display cap (default 30)
      const displayMax = parseInt(result.stylePromptCount) || 30;
      const count = profile.comments ? profile.comments.length : 0;

      styleEnabledCheckbox.checked = profile.enabled !== false;
      styleCountEl.textContent = `${count} / ${displayMax}`;
      styleProgressFill.style.width = `${Math.min(100, (count / displayMax) * 100)}%`;

      if (count === 0) {
        styleHint.textContent = 'Post a few comments on LinkedIn and the AI will start learning your style.';
        styleEmptyState.style.display = 'flex';
      } else {
        styleHint.textContent = `${count} comment${count > 1 ? 's' : ''} saved. AI is actively matching your tone.`;
        styleEmptyState.style.display = 'none';
      }

      // Voice Signature Logic
      const voiceContainer = document.getElementById('voiceSignatureContainer');
      const voiceText = document.getElementById('voiceSignatureText');
      const voiceLoader = document.getElementById('voiceSignatureLoader');
      
      if (count >= 5) {
        voiceContainer.style.display = 'block';
        voiceContainer.classList.remove('hidden');
        
        if (result.cachedVoiceSignature) {
          voiceText.textContent = `"${result.cachedVoiceSignature}"`;
          voiceText.style.display = 'block';
          voiceLoader.style.display = 'none';
        } else {
          // Trigger generation
          voiceText.style.display = 'none';
          voiceLoader.style.display = 'block';
          
          chrome.runtime.sendMessage({ action: 'GENERATE_VOICE_SIGNATURE' }, (response) => {
            if (response && response.success && response.signature) {
              chrome.storage.local.set({ cachedVoiceSignature: response.signature }, () => {
                voiceText.textContent = `"${response.signature}"`;
                voiceText.style.display = 'block';
                voiceLoader.style.display = 'none';
              });
            } else {
              voiceText.textContent = `Failed to analyze signature: ${response?.error || 'Unknown error'}`;
              voiceText.style.display = 'block';
              voiceLoader.style.display = 'none';
            }
          });
        }
      } else {
        voiceContainer.style.display = 'none';
        voiceContainer.classList.add('hidden');
      }

      // Render saved comments
      const existing = styleCommentsList.querySelectorAll('.style-comment-item');
      existing.forEach(el => el.remove());

      if (profile.comments && profile.comments.length > 0) {
        [...profile.comments].reverse().forEach(c => {
          const item = document.createElement('div');
          item.className = 'style-comment-item';
          const preview = document.createElement('p');
          preview.className = 'style-comment-preview';
          preview.textContent = c.text.length > 120 ? c.text.substring(0, 120) + '…' : c.text;
          const meta = document.createElement('span');
          meta.className = 'style-comment-meta';
          meta.textContent = new Date(c.timestamp).toLocaleDateString();
          item.appendChild(preview);
          item.appendChild(meta);
          styleCommentsList.appendChild(item);
        });
      }
    });
  }

  const regenerateSignatureBtn = document.getElementById('regenerateSignatureBtn');
  if (regenerateSignatureBtn) {
    regenerateSignatureBtn.addEventListener('click', () => {
      const voiceText = document.getElementById('voiceSignatureText');
      const voiceLoader = document.getElementById('voiceSignatureLoader');
      
      voiceText.style.display = 'none';
      voiceLoader.style.display = 'block';
      
      chrome.runtime.sendMessage({ action: 'GENERATE_VOICE_SIGNATURE' }, (response) => {
        if (response && response.success && response.signature) {
          chrome.storage.local.set({ cachedVoiceSignature: response.signature }, () => {
            voiceText.textContent = `"${response.signature}"`;
            voiceText.style.display = 'block';
            voiceLoader.style.display = 'none';
            showStatus('Voice signature regenerated!', 'success');
          });
        } else {
          voiceText.textContent = `Failed to analyze signature: ${response?.error || 'Unknown error'}`;
          voiceText.style.display = 'block';
          voiceLoader.style.display = 'none';
          showStatus(`Failed: ${response?.error || 'Unknown error'}`, 'error');
        }
      });
    });
  }

  styleEnabledCheckbox.addEventListener('change', () => {
    chrome.runtime.sendMessage({ action: 'SET_STYLE_ENABLED', enabled: styleEnabledCheckbox.checked });
  });

  clearStyleBtn.addEventListener('click', () => {
    if (!confirm('Clear all saved style samples? This cannot be undone.')) return;
    chrome.runtime.sendMessage({ action: 'CLEAR_STYLE_PROFILE' }, () => {
      loadStyleProfile();
      showStatus('Style data cleared.', 'success');
    });
  });

  if (syncCommentsBtn) {
    syncCommentsBtn.addEventListener('click', () => {
      const originalText = syncCommentsBtn.innerHTML;
      syncCommentsBtn.innerHTML = '🔄 Syncing...';
      syncCommentsBtn.disabled = true;

      chrome.runtime.sendMessage({ action: 'IMPORT_PAST_COMMENTS' }, (response) => {
        syncCommentsBtn.innerHTML = originalText;
        syncCommentsBtn.disabled = false;
        
        if (response && response.success) {
          loadStyleProfile();
          showStatus(`Successfully imported ${response.count} comments!`, 'success');
        } else {
          showStatus(`Sync failed: ${response?.error || 'Unknown error'}. Try manual import.`, 'error');
        }
      });
    });
  }

  const saveManualCommentsBtn = document.getElementById('saveManualCommentsBtn');
  const manualCommentsTextarea = document.getElementById('manualCommentsTextarea');
  
  if (saveManualCommentsBtn && manualCommentsTextarea) {
    saveManualCommentsBtn.addEventListener('click', () => {
      const text = manualCommentsTextarea.value;
      if (!text || text.trim().length === 0) {
        showStatus('Please paste at least one comment.', 'error');
        return;
      }
      
      const originalBtnText = saveManualCommentsBtn.innerHTML;
      saveManualCommentsBtn.innerHTML = 'Saving...';
      saveManualCommentsBtn.disabled = true;
      
      // Split by newline and filter out empty lines
      const comments = text.split('\n').map(c => c.trim()).filter(c => c.length >= 2);
      
      if (comments.length === 0) {
        saveManualCommentsBtn.innerHTML = originalBtnText;
        saveManualCommentsBtn.disabled = false;
        showStatus('No valid comments found.', 'error');
        return;
      }
      
      // Save each one sequentially
      let saved = 0;
      comments.forEach((comment, index) => {
        chrome.runtime.sendMessage({ action: 'SAVE_USER_COMMENT', text: comment }, () => {
          saved++;
          if (saved === comments.length) {
            manualCommentsTextarea.value = '';
            saveManualCommentsBtn.innerHTML = originalBtnText;
            saveManualCommentsBtn.disabled = false;
            loadStyleProfile();
            showStatus(`Successfully saved ${saved} manual comments!`, 'success');
          }
        });
      });
    });
  }
});

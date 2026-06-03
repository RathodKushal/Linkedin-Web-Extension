// Background service worker for LinkedIn AI Comment Assistant

// Register a listener for message events sent from other parts of the extension (e.g. content script, popup)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Handle new post detected for Auto-Share
  if (request.action === 'NEW_POST_DETECTED') {
    handleNewPostDetected(request.url).catch(console.error);
    sendResponse({ success: true });
    return true;
  }

  // Check if the received message has the action type 'GENERATE_SUGGESTIONS'
  if (request.action === 'GENERATE_SUGGESTIONS') {
    // Call the asynchronous handler to get comment suggestions, passing the parent comment text, image URL, reply flag, and main post context
    handleGenerateSuggestions(request.postText, request.imageUrl, request.isReply, request.mainPostText, request.userTypedText)
      // If suggestions are successfully generated, send them back in the response object
      .then(result => sendResponse({ success: true, suggestions: result }))
      // If generation fails, catch the error and send the error message in the response object
      .catch(error => sendResponse({ success: false, error: error.message }));

    // Return true to keep the message channel open for asynchronous sendResponse calls
    return true;
  }

  // Check if the received message has the action type 'GENERATE_BULK_REPLIES'
  if (request.action === 'GENERATE_BULK_REPLIES') {
    handleGenerateBulkReplies(request.comments)
      .then(result => sendResponse({ success: true, drafts: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));

    // Return true to keep the message channel open for asynchronous sendResponse calls
    return true;
  }

  // Check if the received message has the action type 'GENERATE_SINGLE_COMMENT' (Slash Commands)
  if (request.action === 'GENERATE_SINGLE_COMMENT') {
    handleGenerateSingleComment(request.style, request.userContext, request.postText, request.imageUrl, request.isReply, request.mainPostText, request.userTypedText)
      .then(result => sendResponse({ success: true, draft: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // Check if the received message has the action type 'TRACK_ANALYTICS'
  if (request.action === 'TRACK_ANALYTICS') {
    trackAnalytics([request.tone], 1).catch(console.error);
    sendResponse({ success: true });
    return true;
  }

  // Saves a comment the user manually typed and posted — used for style learning
  if (request.action === 'SAVE_USER_COMMENT') {
    saveUserComment(request.text)
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  // Returns the stored style profile (for the popup My Style tab)
  if (request.action === 'GET_STYLE_PROFILE') {
    chrome.storage.local.get(['styleProfile'])
      .then(s => sendResponse({ success: true, styleProfile: s.styleProfile || { enabled: true, comments: [] } }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  // Updates the styleProfile.enabled toggle from the popup
  if (request.action === 'SET_STYLE_ENABLED') {
    chrome.storage.local.get(['styleProfile']).then(s => {
      const profile = s.styleProfile || { enabled: true, comments: [] };
      profile.enabled = request.enabled;
      return chrome.storage.local.set({ styleProfile: profile });
    }).then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  // Clears all saved style samples
  if (request.action === 'CLEAR_STYLE_PROFILE') {
    chrome.storage.local.get(['styleProfile']).then(s => {
      const profile = s.styleProfile || { enabled: true, comments: [] };
      profile.comments = [];
      return chrome.storage.local.set({ styleProfile: profile });
    }).then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (request.action === 'IMPORT_PAST_COMMENTS') {
    chrome.tabs.create({ url: 'https://www.linkedin.com/in/me/recent-activity/comments/', active: false }, (tab) => {
      const tabId = tab.id;

      const listener = (updatedTabId, changeInfo, updatedTab) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          // Wait for the redirect from /in/me/ to /in/your-profile-slug/
          if (updatedTab.url && updatedTab.url.includes('/recent-activity/comments')) {
            chrome.tabs.onUpdated.removeListener(listener);

            // Wait 10 seconds for React to fetch and render the feed
            setTimeout(() => {
              chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: () => {
                  const mePhoto = document.querySelector('.global-nav__me-photo');
                  let myName = "The User";
                  if (mePhoto && mePhoto.alt) {
                    myName = mePhoto.alt.trim();
                  } else {
                    myName = document.title.split('|')[0].replace('Post Activity', '').replace('Comments', '').trim();
                  }

                  const cards = document.querySelectorAll('.profile-creator-shared-feed-update__container, .feed-shared-update-v2, li.activity-item, .scaffold-finite-scroll__content > ul > li');
                  let rawTextBlocks = [];
                  const seenElements = new Set();

                  cards.forEach(card => {
                    if (card.closest('.profile-creator-shared-feed-update__container') !== card &&
                      card.closest('.feed-shared-update-v2') !== card &&
                      seenElements.has(card.parentElement)) return;

                    if (card.innerText) {
                      const text = card.innerText.trim();
                      if (text.length > 20) {
                        rawTextBlocks.push(text);
                        seenElements.add(card);
                      }
                    }
                  });

                  rawTextBlocks = [...new Set(rawTextBlocks)];
                  return { myName, rawTextBlocks: rawTextBlocks.slice(0, 10) };
                }
              }, async (results) => {
                chrome.tabs.remove(tabId); // cleanup

                if (chrome.runtime.lastError || !results || !results[0] || !results[0].result) {
                  sendResponse({ success: false, error: 'Failed to scrape' });
                  return;
                }

                const data = results[0].result;
                if (!data.rawTextBlocks || data.rawTextBlocks.length === 0) {
                  sendResponse({ success: false, error: 'No comments found on page' });
                  return;
                }

                try {
                  const env = await loadEnvKeys();
                  if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY) {
                    sendResponse({ success: false, error: 'No AI API Key found' });
                    return;
                  }

                  const systemPrompt = "You are a strict data parser extracting comments from LinkedIn activity cards. Your ONLY job is to extract comments written EXACTLY by the 'Primary User Name'.\n\nOutput a JSON array of objects evaluating EACH card. Format:\n[\n  {\n    \"author_of_comment\": \"Name of the person who wrote the comment\",\n    \"is_primary_user\": true/false,\n    \"comment_text\": \"The exact comment text\"\n  }\n]\n\nCRITICAL RULES:\n1. Determine who actually wrote the comment in the card.\n2. If the comment was written by someone else, 'is_primary_user' MUST be false. IGNORE replies by other people on the user's posts.\n3. Do not summarize or alter the 'comment_text'.\n4. Do NOT wrap your response in markdown blocks. Return ONLY the JSON array.";
                  const userPrompt = `Primary User Name: ${data.myName}\n\nRaw Activity Cards:\n\n${data.rawTextBlocks.map((b, i) => `--- CARD ${i + 1} ---\n${b}`).join('\n\n')}`;

                  let extractedComments = [];

                  if (env.GEMINI_API_KEY) {
                    extractedComments = await callGeminiApi(env.GEMINI_API_KEY, systemPrompt, userPrompt, null);
                  } else if (env.GROQ_API_KEY) {
                    extractedComments = await callGroqApi(env.GROQ_API_KEY, systemPrompt, userPrompt, null);
                  }

                  if (!Array.isArray(extractedComments)) {
                    if (typeof extractedComments === 'string') {
                      if (extractedComments.includes('```')) {
                        const match = extractedComments.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                        if (match && match[1]) {
                          extractedComments = match[1];
                        }
                      }
                      try { extractedComments = JSON.parse(extractedComments); } catch (e) { extractedComments = []; }
                    } else if (extractedComments.comments) {
                      extractedComments = extractedComments.comments;
                    } else {
                      extractedComments = Object.values(extractedComments);
                    }
                  }

                  let validComments = [];
                  if (Array.isArray(extractedComments)) {
                    if (extractedComments.length > 0 && typeof extractedComments[0] === 'object' && extractedComments[0] !== null) {
                      validComments = extractedComments
                        .filter(item => item.is_primary_user === true && typeof item.comment_text === 'string' && item.comment_text.length >= 10)
                        .map(item => item.comment_text);
                    } else {
                      validComments = extractedComments.filter(t => typeof t === 'string' && t.length >= 10);
                    }
                  }

                  if (validComments.length === 0) {
                    sendResponse({ success: false, error: 'AI found no valid comments' });
                    return;
                  }

                  chrome.storage.local.get(['styleProfile']).then(s => {
                    const profile = s.styleProfile || { enabled: true, comments: [] };
                    const now = Date.now();

                    validComments.forEach(text => {
                      const isDuplicate = profile.comments.some(c => c.text.trim() === text);
                      if (!isDuplicate) {
                        profile.comments.push({ text, timestamp: now });
                      }
                    });

                    if (profile.comments.length > 30) {
                      profile.comments = profile.comments.slice(profile.comments.length - 30);
                    }

                    chrome.storage.local.set({ styleProfile: profile }).then(() => {
                      sendResponse({ success: true, count: validComments.length });
                    });
                  });
                } catch (e) {
                  console.error(e);
                  sendResponse({ success: false, error: 'AI Extraction failed' });
                }
              });
            }, 10000); // Wait 10 secondsit
          }
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });
    return true;
  }

  // Check if the received message has the action type 'OPEN_OPTIONS'
  if (request.action === 'OPEN_OPTIONS') {
    // Open the extension's options page in a new browser tab
    chrome.runtime.openOptionsPage(() => {
      // Check if there was an error opening the options page
      if (chrome.runtime.lastError) {
        // Send a failure response indicating the options page couldn't be opened
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        // Send a success response back to the sender
        sendResponse({ success: true });
      }
    });
    // Return true to keep the message channel open for asynchronous response
    return true;
  }

  // ICP-targeted comment generation using the new generation popup UI
  if (request.action === 'GENERATE_ICP_COMMENT') {
    handleGenerateICPComment(request)
      .then(result => sendResponse({ success: true, variations: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // Generate Voice Signature (auto-applied template)
  if (request.action === 'GENERATE_VOICE_SIGNATURE') {
    handleGenerateVoiceSignature(request)
      .then(result => sendResponse({ success: true, signature: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

// Asynchronously fetches an image from a URL and converts it into a Base64 string suitable for LLM APIs
async function fetchImageAsBase64(imageUrl) {
  try {
    // Check if the image URL is already in Base64 data format
    if (imageUrl.startsWith('data:')) {
      // Match the MIME type and base64 payload from the data URL using a regular expression
      const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
      // Verify if the regex match successfully captured both sections
      if (matches && matches.length === 3) {
        // Return an object containing the resolved mimeType and the raw base64 data
        return {
          mimeType: matches[1],
          data: matches[2]
        };
      }
      // If the data URL format was invalid, return null
      return null;
    }

    // Check if the image URL is not a standard web address (http/https)
    if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
      // Return null for unsupported URL protocols (e.g., local files, chrome extensions)
      return null;
    }

    // Fetch the image from the web URL using a standard HTTP request
    const response = await fetch(imageUrl);
    // If the HTTP status is not OK (200-299), return null
    if (!response.ok) return null;
    // Read the body response data as a raw binary array buffer
    const arrayBuffer = await response.arrayBuffer();

    // Convert the array buffer into an unsigned 8-bit integer array
    const bytes = new Uint8Array(arrayBuffer);
    // Initialize an empty string to accumulate binary characters
    let binary = '';
    // Store the total number of bytes in a variable for loop boundary
    const len = bytes.byteLength;
    // Loop through each byte in the binary array
    for (let i = 0; i < len; i++) {
      // Convert the byte value to its corresponding ASCII character and append it
      binary += String.fromCharCode(bytes[i]);
    }
    // Encode the binary string into a base64 string using the browser's btoa function
    const base64 = btoa(binary);

    // Retrieve the MIME type from the response headers, defaulting to image/jpeg if missing
    const mimeType = response.headers.get('content-type') || 'image/jpeg';
    // Return the final mimeType and the base64 encoded data
    return {
      mimeType: mimeType,
      data: base64
    };
  } catch (e) {
    // Log the error to the console if fetching or conversion fails
    console.error('[LinkedIn Background] Error converting image to base64:', e);
    // Return null in case of any exceptions
    return null;
  }
}

// Asynchronously loads API keys from chrome.storage.local (set via the extension's Settings UI)
async function loadEnvKeys() {
  try {
    const storage = await chrome.storage.local.get([
      'apiKey_GEMINI',
      'apiKey_GROQ'
    ]);
    return {
      GEMINI_API_KEY: storage.apiKey_GEMINI || '',
      GROQ_API_KEY: storage.apiKey_GROQ || ''
    };
  } catch (e) {
    console.error('[LinkedIn Background] Failed to load API keys from storage:', e);
    return {};
  }
}

// ─── Personal Style Learning Storage ─────────────────────────────────────────

// Maximum number of past comments to keep (older ones are evicted FIFO)
const MAX_STYLE_COMMENTS = 30;
// Number of comments to inject into the LLM prompt (most recent N)
const STYLE_PROMPT_COUNT = 10;
// Comments older than this are pruned automatically (180 days in ms)
const STYLE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Saves a user-posted comment as a style sample to chrome.storage.local.
 * Maintains a FIFO cap of MAX_STYLE_COMMENTS entries; prunes old entries.
 * @param {string} text - The comment text the user posted.
 */
async function saveUserComment(text) {
  if (!text || text.trim().length < 2) return;

  const storage = await chrome.storage.local.get(['styleProfile']);
  const profile = storage.styleProfile || { enabled: true, comments: [] };

  // Always initialise enabled to true if not explicitly set
  if (profile.enabled === undefined) profile.enabled = true;

  const now = Date.now();

  // Prune comments older than STYLE_MAX_AGE_MS
  profile.comments = profile.comments.filter(c => (now - c.timestamp) < STYLE_MAX_AGE_MS);

  // Avoid saving near-duplicate comments (same text saved twice by accident)
  const isDuplicate = profile.comments.some(c => c.text.trim() === text.trim());
  if (isDuplicate) return;

  // Append new sample
  profile.comments.push({ text: text.trim(), timestamp: now });

  // Evict oldest if over cap
  if (profile.comments.length > MAX_STYLE_COMMENTS) {
    profile.comments = profile.comments.slice(profile.comments.length - MAX_STYLE_COMMENTS);
  }

  await chrome.storage.local.set({ styleProfile: profile });
  console.log(`[LinkedIn AI] Style sample saved. Total samples: ${profile.comments.length}`);
}

/**
 * Builds an LLM prompt block that instructs the AI to mimic the user's writing style.
 * Returns an empty string if style learning is disabled or no samples exist.
 * @param {Array<{text:string, timestamp:number}>} comments - Saved style samples.
 * @param {number} [count=10] - How many recent comments to include in the prompt.
 * @returns {string} The prompt injection block, or empty string.
 */
function buildStyleContext(comments, count = 10, voiceSignature = '') {
  let contextStr = `\n\n=== TONE & VOICE SIGNATURE ===\n`;

  if (voiceSignature) {
    contextStr += `You MUST structure your response using this exact conceptual framework and tone:\n"${voiceSignature}"\n`;
    contextStr += `=============================`;
    return contextStr;
  }

  const maxComments = Math.min(count, 3); // Cap at 3 to prevent overwhelming the LLM
  const recent = comments ? comments.slice(-Math.max(1, maxComments)) : [];
  const numbered = recent.map((c, i) => `${i + 1}. "${c.text.replace(/"/g, '\\"')}"`).join('\n');

  if (numbered) {
    contextStr += `Examples of the user's past comments (Mimic their tone, rhythm, and punctuation. DO NOT reference the topics in these examples):\n${numbered}\n`;
    contextStr += `=============================`;
    return contextStr;
  }

  return '';
}

// ─────────────────────────────────────────────────────────────────────────────

// Function to track analytics in chrome.storage.local
async function trackAnalytics(tonesGenerated, historyCount = 1) {
  try {
    const storage = await chrome.storage.local.get(['analytics']);
    let analytics = storage.analytics || {
      history: [],
      tonesUsed: {}
    };

    const now = Date.now();
    // Keep history array from growing infinitely (keep last 90 days max)
    const ninetyDaysAgo = now - (90 * 24 * 60 * 60 * 1000);
    analytics.history = analytics.history.filter(ts => ts > ninetyDaysAgo);

    // Add history entries (representing actual comments the user will post)
    for (let i = 0; i < historyCount; i++) {
      analytics.history.push(now);
    }

    // Track tones generated
    for (let i = 0; i < tonesGenerated.length; i++) {
      let tone = tonesGenerated[i].toLowerCase().trim();
      // Remove leading slash if it was a slash command (e.g. "/funny" -> "funny")
      if (tone.startsWith('/')) {
        tone = tone.substring(1);
      }
      analytics.tonesUsed[tone] = (analytics.tonesUsed[tone] || 0) + 1;
    }

    await chrome.storage.local.set({ analytics });
  } catch (e) {
    console.error('[LinkedIn AI] Failed to track analytics:', e);
  }
}

// Main asynchronous orchestrator to load configurations, build prompts, and call LLM APIs
async function handleGenerateSuggestions(postText, imageUrl, isReply = false, mainPostText = '', userTypedText = '') {
  // Load configuration API keys from the local config.env file
  const env = await loadEnvKeys();
  // Extract the saved Gemini API key from environment variables
  const geminiApiKey = env.GEMINI_API_KEY;
  const groqApiKey = env.GROQ_API_KEY;
  const claudeApiKey = env.CLAUDE_API_KEY;

  // Fetch extension configurations and style profile from chrome local storage
  const storage = await chrome.storage.local.get(['commentLength', 'userDesignation', 'customDesignation', 'emojisEnabled', 'customPrompt', 'styleProfile', 'stylePromptCount', 'defaultTone', 'addHook', 'targetMarket']);

  // If no keys are configured in the extension, throw a specific NO_API_KEY error
  if (!geminiApiKey && !groqApiKey && !claudeApiKey) {
    throw new Error('NO_API_KEY');
  }

  // Get the preferred comment length, defaulting to 'medium'
  const commentLength = storage.commentLength || 'medium';
  // Get the user's role designation selection, defaulting to 'general'
  const userDesignation = storage.userDesignation || 'general';
  // Get any custom designation specified by the user
  const customDesignation = storage.customDesignation || '';
  // Check if emojis are enabled (converting to boolean value)
  const emojisEnabled = !!storage.emojisEnabled;

  const targetMarket = storage.targetMarket || 'general';
  const marketMap = {
    australia: 'Australia', uk: 'United Kingdom', usa: 'United States',
    canada: 'Canada', india: 'India', uae: 'UAE / Middle East',
    singapore: 'Singapore / SEA', general: 'Global'
  };
  const marketLabel = marketMap[targetMarket] || 'Global';
  const marketContext = `\n  - Target market: ${marketLabel} — only reference companies, trends, and events current to 2024-2026 within this market. NEVER reference outdated companies or events unless directly applicable.`;

  // Get any custom prompt specified by the user
  const customPrompt = storage.customPrompt || '';

  // Initialize variable to hold the formatted designation context text
  let designationText = "";
  // Check if the user selected custom role option and provided non-empty text
  if (userDesignation === 'custom' && customDesignation.trim()) {
    // Set the designation text to the user's custom entry
    designationText = customDesignation.trim();
  } else if (userDesignation && userDesignation !== 'general') {
    // Map internal key values to clean, user-facing profession names
    const designationMap = {
      software_engineer: "Software Engineer",
      product_manager: "Product Manager",
      recruiter: "Recruiter / HR",
      founder: "Founder / CEO",
      student: "Student / Job Seeker"
    };
    // Get the mapped designation name, defaulting to empty string if not matched
    designationText = designationMap[userDesignation] || "";
  }

  // Initialize string to hold prompt guidance regarding user role
  let roleContext = "";
  // If a role designation is specified, write detailed instructions for the LLM
  if (designationText) {
    roleContext = `\n- The user's role/designation is: "${designationText}". You MUST tailor the generated comments to sound like they are written by someone in this specific role. Use appropriate vocabulary, domain knowledge, and perspective that matches this profession.`;
  }

  // Initialize string to hold prompt guidance regarding emojis
  let emojiContext = "";
  // Check if user enabled emojis
  if (emojisEnabled) {
    // Add prompt instructions asking for 1 to 3 relevant emojis naturally in each comment
    emojiContext = `\n- You MUST include relevant emojis in each comment naturally (1-3 emojis per comment). Make sure the emojis match the professional/humorous context of the comment.`;
  } else {
    // Add prompt instructions strictly prohibiting emojis
    emojiContext = `\n- You MUST NOT include any emojis in the comments. Absolutely no emojis.`;
  }

  // Initialize string to hold prompt guidance regarding comment length
  let lengthContext = "";
  // Check if preferred length is short
  if (commentLength === 'short') {
    // Add prompt instructions for short, 1-sentence comments
    lengthContext = `\n- LENGTH CONSTRAINT: You MUST write exactly 1 sentence on exactly 1 line. Maximum 25 words. DO NOT EXCEED 1 SENTENCE OR 1 LINE.`;
  } else if (commentLength === 'long') {
    // Add prompt instructions for long, detailed comments
    lengthContext = `\n- LENGTH CONSTRAINT: You MUST write exactly 3 to 5 sentences. Around 60-100 words.`;
  } else {
    // Add prompt instructions for balanced, medium-length comments
    lengthContext = `\n- LENGTH CONSTRAINT: You MUST write exactly 3 or 4 sentences across a maximum of 3 to 4 lines. DO NOT EXCEED 4 SENTENCES. This is a strict hard limit.`;
  }

  // Build personal style context from the user's past comments (if enabled)
  let styleContext = "";
  const styleProfile = storage.styleProfile || { enabled: true, comments: [] };
  const stylePromptCount = storage.stylePromptCount || 10;
  const cachedVoiceSignature = storage.cachedVoiceSignature || '';
  if (styleProfile.enabled !== false && (styleProfile.comments?.length > 0 || cachedVoiceSignature)) {
    styleContext = buildStyleContext(styleProfile.comments, stylePromptCount, cachedVoiceSignature);
  }

  // Define custom context
  let customContext = "";
  if (customPrompt) {
    customContext = `\n\n=== CUSTOM USER INSTRUCTIONS (HIGHEST PRIORITY) ===\n${customPrompt}\n===================================================`;
  }

  // Clean the retrieved post text, capping it at 3000 characters and trimming whitespace
  const cleanPostText = (postText || '').substring(0, 3000).trim();
  // If both post text and image URL are missing, throw an error
  if (!cleanPostText && !imageUrl) {
    throw new Error('POST_TEXT_EMPTY');
  }

  // Define the comprehensive ruleset for the AI system prompt
  const toneStrategies = {
    "tone_1": "Agree -> reframe -> Sharp Questions (elevates point, adds market truth, ends with a question they can't ignore)",
    "tone_2": "Agree -> bold counter -> Invite take (validates first, challenges a hidden assumption, asks what they'd do differently)",
    "tone_3": "Pattern from 20+ projects (drop a lived observation from real exam prep builds. Create authority and curiosity, and explicitly give an example of a company related to it)",
    "tone_4": "Cryptic Hook -> Question (open with a counterintuitive truth, let the question do the lead gen work)"
  };

  const selectedToneStrategy = (storage.defaultTone && toneStrategies[storage.defaultTone])
    ? `\n- TONE STRATEGY: You MUST format your response using this exact strategy: "${toneStrategies[storage.defaultTone]}". Generate 3 distinct variations that all strictly follow this specific strategy.`
    : `\n- Make each reply fit one of these specific styles:
  1. "insightful": Offers a brief additional perspective or shares a related trend replying to their point.
  2. "appreciative": A warm, specific comment thanking or agreeing with the commentator.
  3. "inquisitive": Asks a highly relevant, intelligent question that opens up further discussion.`;

  let systemInstruction = "";
  if (isReply) {
    systemInstruction = `You are an elite LinkedIn engagement assistant. Your job is to read a specific user's comment and generate 3 highly precise, professional, and natural-sounding replies directly to THAT comment.
Guidelines for replies:${roleContext}${emojiContext}${lengthContext}${marketContext}
- CRITICAL: You MUST reply directly to the "Parent comment content". If original post context is provided, use it ONLY for background understanding, do NOT reply to the original post.
- PROFESSIONAL HUMANIZATION: You MUST write exactly like a real human professional on LinkedIn. Do NOT sound like an AI or a corporate robot.
- TONE & ORIGIN: You MUST write in authentic Kathiyawadi Indian English. Your grammar should NOT be perfect native-speaker English. Use slightly imperfect grammar, very simple vocabulary, and typical Gujarati/Indian phrasing. It must look exactly like someone from Gujarat whose English is not their first language, but who is still respectful and professional. Do NOT use fancy words or perfect native sentence structures.
- ZERO "CONSULTANT SPEAK": Do not use overly flowery or dramatic corporate jargon. Keep sentences straightforward and practical, typical of an Indian business professional.
- ROLE ALIGNMENT: Strongly maintain the user's specified designation and market context in how the comment is framed.
- NEVER start with generic filler like "Great post!" or "I completely agree!". Dive straight into your specific insight or perspective.
- BANNED AI WORDS: "kudos", "delighted", "deep dive", "game-changer", "spot on", "essential read", "couldn't agree more", "revolutionary", "insightful", "valuable perspective", "unleash", "elevate", "in today's rapidly evolving", "navigating".
- The final output MUST look like a genuine, manually typed professional comment.${selectedToneStrategy}

You MUST reply ONLY with a valid JSON object in the following format:
{
  "insightful": "the first variation text",
  "appreciative": "the second variation text",
  "inquisitive": "the third variation text"
}${customContext}`;
  } else {
    systemInstruction = `You are an elite LinkedIn engagement assistant. Your job is to read a LinkedIn post (which may consist of text, an image/meme, or both) and generate 3 highly precise, professional, and natural-sounding comments.
Guidelines for comments:${roleContext}${emojiContext}${lengthContext}${marketContext}
- PROFESSIONAL HUMANIZATION: You MUST write exactly like a real human professional on LinkedIn. Do NOT sound like an AI or a corporate robot.
- TONE & ORIGIN: You MUST write in authentic Kathiyawadi Indian English. Your grammar should NOT be perfect native-speaker English. Use slightly imperfect grammar, very simple vocabulary, and typical Gujarati/Indian phrasing. It must look exactly like someone from Gujarat whose English is not their first language, but who is still respectful and professional. Do NOT use fancy words or perfect native sentence structures.
- ZERO "CONSULTANT SPEAK": Do not use overly flowery or dramatic corporate jargon. Keep sentences straightforward and practical, typical of an Indian business professional.
- ROLE ALIGNMENT: Strongly maintain the user's specified designation and market context in how the comment is framed.
- NEVER start with generic filler like "Great post!" or "I completely agree!". Dive straight into your specific insight or perspective.
- BANNED AI WORDS: "kudos", "delighted", "deep dive", "game-changer", "spot on", "essential read", "couldn't agree more", "revolutionary", "insightful", "valuable perspective", "unleash", "elevate", "in today's rapidly evolving", "navigating".
- The final output MUST look like a genuine, manually typed professional comment.${selectedToneStrategy}${styleContext}

You MUST reply ONLY with a valid JSON object in the following format:
{
  "insightful": "the first variation text",
  "appreciative": "the second variation text",
  "inquisitive": "the third variation text"
}${customContext}`;
  }

  // Download and base64-encode the post image if an image URL exists
  const imageData = imageUrl ? await fetchImageAsBase64(imageUrl) : null;

  // Initialize string to hold the user prompt payload
  let userText = "";

  if (isReply) {
    const cleanParentComment = cleanPostText;
    const cleanMainPost = (mainPostText || '').substring(0, 2000).trim();

    userText += `=== PARENT COMMENT TO REPLY TO ===\n"""\n${cleanParentComment}\n"""\n\n`;
    if (userTypedText) {
      userText += `=== USER'S IN-PROGRESS DRAFT (REQUIRED CONTEXT) ===\nThe user has already started their reply with: "${userTypedText}". You MUST incorporate this context (like the mentioned user's name) directly into your reply.\n\n`;
    }
    if (cleanMainPost) {
      userText += `=== ORIGINAL POST (FOR BACKGROUND CONTEXT ONLY, DO NOT REPLY TO THIS) ===\n"""\n${cleanMainPost}\n"""\n\n`;
    }
    if (imageData) {
      userText += `The original post also attached an image/meme (attached for background context).\n`;
    }
  } else {
    // Format the user prompt depending on whether we have text, an image, or both
    if (cleanPostText && imageData) {
      // Add instructions to analyze both the post text and the attached image
      userText += `Post text content:\n"""\n${cleanPostText}\n"""\n\nAn accompanying image/meme from the post is attached. Please read the image and the text, and synthesize both to generate the comments. Ensure the comments match the tone/context of the post (e.g. humorous, serious, etc.).\n`;
    } else if (cleanPostText) {
      // Add instructions to analyze the text content only
      userText += `Post text content:\n"""\n${cleanPostText}\n"""\n`;
    } else if (imageData) {
      // Add instructions to inspect the image content only
      userText += `The post consists of an image/meme (attached). Please analyze the image content (including any text written inside the image) and generate comments on it.\n`;
    } else {
      // Throw an error if neither could be processed
      throw new Error('Could not retrieve readable post text or image data.');
    }

    const addHook = storage.addHook !== undefined ? storage.addHook : true;
    const userPromptHook = addHook ? '\n\nCRITICAL REQUIREMENT: Instead of generating full comments, ALL 3 of your variations MUST be ONLY a standalone, thought-provoking question or hook that forces the original poster to reply. Do NOT output any filler or agreements. JUST the question. Furthermore, EVERY SINGLE variation MUST be framed around a specific, real-world company example from the target market.' : '';
    userText += userPromptHook;
  }

  // Initialize an array to track error failures from API calls
  const errors = [];

  // If a Gemini API key is configured, try calling Gemini first
  if (geminiApiKey) {
    try {
      // Log connection attempt to console
      console.log(`[LinkedIn AI] Attempting suggestions generation using Gemini (gemini-2.5-flash)`);
      // Call the Gemini helper and wait for suggestions response
      const suggestions = await callGeminiApi(geminiApiKey, systemInstruction, userText, imageData);

      // Return suggestions immediately if successful
      return suggestions;
    } catch (err) {
      // Log a warning if Gemini fails, tracking the failure details
      console.warn(`[LinkedIn AI] Gemini call failed:`, err.message);
      // Push error information to the errors array
      errors.push({ provider: 'Gemini', error: err });
    }
  }

  // If Gemini failed or key wasn't set, try calling Groq if a Groq key is configured
  if (groqApiKey) {
    try {
      // Log connection attempt to console
      console.log(`[LinkedIn AI] Attempting suggestions generation using Groq`);
      // Call the Groq helper and wait for response
      const suggestions = await callGroqApi(groqApiKey, systemInstruction, userText, imageData);
      // Return suggestions immediately if successful
      return suggestions;
    } catch (err) {
      // Log a warning if Groq fails
      console.warn(`[LinkedIn AI] Groq call failed:`, err.message);
      // Push error information to the errors array
      errors.push({ provider: 'Groq', error: err });
    }
  }

  // If both models failed to generate suggestions, inspect errors and throw diagnostic details
  if (errors.length > 0) {
    // Find any tracked error related to the Gemini provider
    const geminiError = errors.find(e => e.provider === 'Gemini')?.error;
    if (geminiError) {
      // Extract status and message parameters from the error
      const status = geminiError.status;
      const msg = geminiError.message || "";
      // Check if error corresponds to an API rate limit or quota issue
      if (status === 429 || msg.includes("429") || msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("rate limit") || msg.toLowerCase().includes("resource exhausted")) {
        throw new Error(`Rate limit exceeded on Gemini. If OpenAI key is set, it also failed. Please try again in a minute.`);
      }
      // Check if error corresponds to an invalid API key
      if (status === 400 && (msg.toLowerCase().includes("key not valid") || msg.toLowerCase().includes("invalid key") || msg.toLowerCase().includes("api key"))) {
        throw new Error(`Invalid Gemini API Key. Please check your Gemini API key in the extension settings.`);
      }
    }

    // Find any tracked error related to the Groq provider
    const groqError = errors.find(e => e.provider === 'Groq')?.error;
    if (groqError) {
      // Extract status and message parameters
      const status = groqError.status;
      const msg = groqError.message || "";
      // Check if error corresponds to a rate limit or quota issue
      if (status === 429 || msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("rate limit")) {
        throw new Error(`Rate limit or quota exceeded on Groq. Please check your Groq account limit.`);
      }
      // Check if error corresponds to an invalid API key
      if (status === 401 || (msg.toLowerCase().includes("api key") && msg.toLowerCase().includes("incorrect"))) {
        throw new Error(`Invalid Groq API Key. Please check your Groq API key in the extension settings.`);
      }
    }

    // Fallback: throw a combined error message detailing failures of both APIs
    throw new Error(errors.map(e => `[${e.provider}] ${e.error.message}`).join(' | '));
  }

  // Throw key error if no configuration keys were resolved
  throw new Error('NO_API_KEY');
}

// Handles generation for Slash Commands (single comment with custom style)
async function handleGenerateSingleComment(style, userContextText, postText, imageUrl, isReply = false, mainPostText = '', userTypedText = '') {
  const env = await loadEnvKeys();
  const geminiApiKey = env.GEMINI_API_KEY;
  const groqApiKey = env.GROQ_API_KEY;

  const storage = await chrome.storage.local.get(['commentLength', 'userDesignation', 'customDesignation', 'emojisEnabled', 'customPrompt', 'styleProfile', 'stylePromptCount']);

  if (!geminiApiKey && !groqApiKey) {
    throw new Error('NO_API_KEY');
  }

  const commentLength = storage.commentLength || 'medium';
  const userDesignation = storage.userDesignation || 'general';
  const customDesignation = storage.customDesignation || '';
  const emojisEnabled = !!storage.emojisEnabled;

  let designationText = "";
  if (userDesignation === 'custom' && customDesignation.trim()) {
    designationText = customDesignation.trim();
  } else if (userDesignation && userDesignation !== 'general') {
    const designationMap = {
      software_engineer: "Software Engineer",
      product_manager: "Product Manager",
      recruiter: "Recruiter / HR",
      founder: "Founder / CEO",
      student: "Student / Job Seeker"
    };
    designationText = designationMap[userDesignation] || "";
  }

  let roleContext = "";
  if (designationText) {
    roleContext = `\n- The user's role/designation is: "${designationText}". You MUST tailor the generated comments to sound like they are written by someone in this specific role.`;
  }

  let emojiContext = emojisEnabled ? `\n- Include 1-2 relevant emojis.` : `\n- Absolutely no emojis.`;

  let lengthContext = "";
  if (commentLength === 'short') lengthContext = `\n- LENGTH CONSTRAINT: You MUST write exactly 1 sentence on exactly 1 line. Maximum 25 words. DO NOT EXCEED 1 SENTENCE OR 1 LINE.`;
  else if (commentLength === 'long') lengthContext = `\n- LENGTH CONSTRAINT: You MUST write exactly 3 to 5 sentences. Around 60-100 words.`;
  else lengthContext = `\n- LENGTH CONSTRAINT: You MUST write exactly 3 or 4 sentences across a maximum of 3 to 4 lines. DO NOT EXCEED 4 SENTENCES. This is a strict hard limit.`;

  let userThoughtContext = "";
  if (userContextText) {
    userThoughtContext = `\n\n=== USER'S PARTIAL THOUGHT ===\nThe user has already started drafting their comment with the following text: "${userContextText}". You MUST use this text as the foundation, expand upon it seamlessly, and finish the thought in the requested style. DO NOT output the original text separately, just write the final unified comment.`;
  }

  const customPrompt = storage.customPrompt || '';

  // Build personal style context for slash-command / single comment generation
  const styleProfile = storage.styleProfile || { enabled: true, comments: [] };
  const stylePromptCount = storage.stylePromptCount || 10;
  const cachedVoiceSignature = storage.cachedVoiceSignature || '';
  let styleContext = "";
  if (styleProfile.enabled !== false && (styleProfile.comments?.length > 0 || cachedVoiceSignature)) {
    styleContext = buildStyleContext(styleProfile.comments, stylePromptCount, cachedVoiceSignature);
  }

  let customContext = "";
  if (customPrompt) {
    customContext = `\n\n=== CUSTOM USER INSTRUCTIONS (HIGHEST PRIORITY) ===\n${customPrompt}\n===================================================`;
  }

  const cleanPostText = (postText || '').substring(0, 3000).trim();
  if (!cleanPostText && !imageUrl) {
    throw new Error('POST_TEXT_EMPTY');
  }

  let systemInstruction = "";
  if (isReply) {
    systemInstruction = `You are an elite LinkedIn engagement assistant. Your job is to read a specific user's comment and generate ONE highly precise, professional, and natural-sounding reply directly to THAT comment.
Guidelines:${roleContext}${emojiContext}${lengthContext}
- CRITICAL: You MUST reply directly to the "Parent comment content". If original post context is provided, use it ONLY for background understanding, do NOT reply to the original post.
- PROFESSIONAL HUMANIZATION: You MUST write exactly like a real human professional on LinkedIn. Do NOT sound like an AI or a corporate robot.
- TONE & ORIGIN: You MUST write in authentic Kathiyawadi Indian English. Your grammar should NOT be perfect native-speaker English. Use slightly imperfect grammar, very simple vocabulary, and typical Gujarati/Indian phrasing. It must look exactly like someone from Gujarat whose English is not their first language, but who is still respectful and professional. Do NOT use fancy words or perfect native sentence structures.
- ZERO "CONSULTANT SPEAK": Do not use overly flowery or dramatic corporate jargon. Keep sentences straightforward and practical, typical of an Indian business professional.
- ROLE ALIGNMENT: Strongly maintain the user's specified designation and market context in how the comment is framed.
- NEVER start with generic filler like "Great post!" or "I completely agree!". Dive straight into your specific insight or perspective.
- BANNED AI WORDS: "kudos", "delighted", "deep dive", "game-changer", "spot on", "essential read", "couldn't agree more", "revolutionary", "insightful", "valuable perspective", "unleash", "elevate", "in today's rapidly evolving", "navigating".
- The final output MUST look like a genuine, manually typed professional comment.
- The user requested the following specific style/tone for this reply: "${style}". Ensure the reply strongly embodies this style.
- You MUST explicitly reference specific topics, insights, or arguments mentioned in the PARENT COMMENT. Do not generate a generic reply!${userThoughtContext}${styleContext}

You MUST reply ONLY with a valid JSON object in the following format:
{
  "comment": "the generated reply text here"
}${customContext}`;
  } else {
    systemInstruction = `You are an elite LinkedIn engagement assistant. Your job is to generate ONE highly precise, professional, and natural-sounding comment based on the post content provided.
Guidelines:${roleContext}${emojiContext}${lengthContext}
- PROFESSIONAL HUMANIZATION: You MUST write exactly like a real human professional on LinkedIn. Do NOT sound like an AI or a corporate robot.
- TONE & ORIGIN: You MUST write in authentic Kathiyawadi Indian English. Your grammar should NOT be perfect native-speaker English. Use slightly imperfect grammar, very simple vocabulary, and typical Gujarati/Indian phrasing. It must look exactly like someone from Gujarat whose English is not their first language, but who is still respectful and professional. Do NOT use fancy words or perfect native sentence structures.
- ZERO "CONSULTANT SPEAK": Do not use overly flowery or dramatic corporate jargon. Keep sentences straightforward and practical, typical of an Indian business professional.
- ROLE ALIGNMENT: Strongly maintain the user's specified designation and market context in how the comment is framed.
- NEVER start with generic filler like "Great post!" or "I completely agree!". Dive straight into your specific insight or perspective.
- BANNED AI WORDS: "kudos", "delighted", "deep dive", "game-changer", "spot on", "essential read", "couldn't agree more", "revolutionary", "insightful", "valuable perspective", "unleash", "elevate", "in today's rapidly evolving", "navigating".
- The final output MUST look like a genuine, manually typed professional comment.
- The user requested the following specific style/tone for this comment: "${style}". Ensure the comment strongly embodies this style.
- You MUST explicitly reference specific topics, insights, or arguments mentioned in the post text. Do not generate a generic comment. Read the post thoroughly!${userThoughtContext}${styleContext}

You MUST reply ONLY with a valid JSON object in the following format:
{
  "comment": "the generated comment text here"
}${customContext}`;
  }

  const imageData = imageUrl ? await fetchImageAsBase64(imageUrl) : null;
  let textPayload = "";

  if (isReply) {
    const cleanParentComment = cleanPostText;
    const cleanMainPost = (mainPostText || '').substring(0, 2000).trim();

    textPayload += `=== PARENT COMMENT TO REPLY TO ===\n"""\n${cleanParentComment}\n"""\n\n`;
    if (userTypedText) {
      textPayload += `=== USER'S IN-PROGRESS DRAFT (REQUIRED CONTEXT) ===\nThe user has already started their reply with: "${userTypedText}". You MUST incorporate this context (like the mentioned user's name) directly into your reply.\n\n`;
    }
    if (cleanMainPost) textPayload += `=== ORIGINAL POST (FOR BACKGROUND CONTEXT ONLY) ===\n"""\n${cleanMainPost}\n"""\n\n`;
  } else {
    textPayload += `=== POST CONTENT ===\n"""\n${cleanPostText}\n"""\n`;
  }

  const errors = [];
  if (geminiApiKey) {
    try {
      const resp = await callGeminiApi(geminiApiKey, systemInstruction, textPayload, imageData);
      if (resp && resp.comment) {
        trackAnalytics([style], 1).catch(console.error);
        return resp.comment;
      } else {
        throw new Error("Invalid response format (missing comment field).");
      }
    } catch (err) {
      errors.push({ provider: 'Gemini', error: err });
    }
  }

  if (groqApiKey) {
    try {
      const resp = await callGroqApi(groqApiKey, systemInstruction, textPayload, imageData);
      if (resp && resp.comment) {
        trackAnalytics([style], 1).catch(console.error);
        return resp.comment;
      } else {
        throw new Error("Invalid response format (missing comment field).");
      }
    } catch (err) {
      errors.push({ provider: 'Groq', error: err });
    }
  }

  throw new Error("Failed to generate slash command comment: " + errors.map(e => `[${e.provider}] ${e.error.message}`).join(' | '));
}

// ─── ICP Comment Generator ────────────────────────────────────────────────────

/**
 * Handles the GENERATE_ICP_COMMENT action from the new generation popup.
 * Assembles a market-aware, voice-matched prompt and returns 3 comment variations.
 */

async function handleGenerateICPComment(request) {
  const env = await loadEnvKeys();
  const geminiApiKey = env.GEMINI_API_KEY;
  const groqApiKey = env.GROQ_API_KEY;

  if (!geminiApiKey && !groqApiKey) {
    throw new Error('NO_API_KEY — Add your Gemini or Groq API key in the extension settings.');
  }

  const storage = await chrome.storage.local.get(['commentLength', 'emojisEnabled', 'addHook', 'customPrompt', 'styleProfile', 'stylePromptCount', 'cachedVoiceSignature']);

  const commentLength = storage.commentLength || 'medium';
  const emojisEnabled = !!storage.emojisEnabled;
  const addHook = storage.addHook !== undefined ? storage.addHook : true;
  const customPrompt = storage.customPrompt || '';

  console.log("addHook status:", addHook);
  const styleProfile = storage.styleProfile || { enabled: true, comments: [] };
  const stylePromptCount = parseInt(storage.stylePromptCount) || 10;
  const cachedVoiceSignature = storage.cachedVoiceSignature || '';

  // Build style context from the user's own saved comments
  let styleContext = '';
  if (styleProfile.enabled !== false && (styleProfile.comments?.length > 0 || cachedVoiceSignature)) {
    styleContext = buildStyleContext(styleProfile.comments, stylePromptCount, cachedVoiceSignature);
  }

  // Build length instruction
  let lengthContext = '';
  if (commentLength === 'short') lengthContext = '\n- LENGTH CONSTRAINT: You MUST write exactly 1 sentence on exactly 1 line. Maximum 25 words. DO NOT EXCEED 1 SENTENCE OR 1 LINE.';
  else if (commentLength === 'long') lengthContext = '\n- LENGTH CONSTRAINT: You MUST write exactly 3 to 5 sentences. Around 60-100 words.';
  else lengthContext = '\n- LENGTH CONSTRAINT: You MUST write exactly 3 or 4 sentences across a maximum of 3 to 4 lines. DO NOT EXCEED 4 SENTENCES. This is a strict hard limit.';

  const emojiContext = emojisEnabled
    ? '\n- Include 1-2 relevant emojis naturally.'
    : '\n- No emojis whatsoever.';

  const {
    contextType = 'comment',
    postText = '',
    targetPersona = '',
    targetMarket = 'general',
    selectedTopics = [],
    selectedDomains = [],
    toneStrategy = '',
    specificInsight = ''
  } = request;

  const hookRule = addHook ? '\nCRITICAL REQUIREMENT: You MUST end EVERY SINGLE variation with a thought-provoking question, hook, or open loop that practically forces the original poster to reply.' : '';

  const marketMap = {
    australia: 'Australia', uk: 'United Kingdom', usa: 'United States',
    canada: 'Canada', india: 'India', uae: 'UAE / Middle East',
    singapore: 'Singapore / SEA', general: 'Global'
  };
  const marketLabel = marketMap[targetMarket] || 'Global';

  const systemPrompt = `You are a senior LinkedIn engagement strategist helping a professional craft highly targeted, human-sounding comments for their Ideal Customer Profile (ICP) outreach.

CONTEXT:
- Comment type: ${contextType === 'reply' ? "Reply to a comment on the user's own post" : "Comment on an ICP prospect's post"}
- Target persona: ${targetPersona || 'Not specified'}
- Target market: ${marketLabel} — only reference companies, trends, and events current to 2024-2026 within this market. NEVER reference outdated companies or events unless directly applicable.
- Post topics: ${selectedTopics.length > 0 ? selectedTopics.join(', ') : 'General'}
- Relevant exam/domain context: ${selectedDomains.length > 0 ? selectedDomains.join(', ') : 'General'}
${specificInsight ? `- Specific insight or stat to weave in: "${specificInsight}"` : ''}

COMMENT STRATEGY — Apply this exact pattern:
${toneStrategy}

  VIRAL ALGORITHM REQUIREMENTS:
  1. The "Hook": Your first line MUST be highly controversial, deeply relatable, or completely counterintuitive to immediately stop the scroll before the "see more" cutoff.
  2. The "Meat": Provide a contrarian take or unique lived insight that no one else in the comments is saying. Add massive value quickly.
  3. The "Format": Strictly obey the LENGTH CONSTRAINT below. Use short punchy sentences. Make it instantly skimmable without exceeding the line limit.

  RULES:
- PROFESSIONAL HUMANIZATION: You MUST write exactly like a real human professional on LinkedIn. Do NOT sound like an AI or a corporate robot.
- TONE & ORIGIN: You MUST write in authentic Kathiyawadi Indian English. Your grammar should NOT be perfect native-speaker English. Use slightly imperfect grammar, very simple vocabulary, and typical Gujarati/Indian phrasing. It must look exactly like someone from Gujarat whose English is not their first language, but who is still respectful and professional. Do NOT use fancy words or perfect native sentence structures.
- ZERO "CONSULTANT SPEAK": Do not use overly flowery or dramatic corporate jargon. Keep sentences straightforward and practical, typical of an Indian business professional.
- ROLE ALIGNMENT: Strongly maintain the user's specified designation and market context in how the comment is framed.
- NEVER start with generic filler like "Great post!" or "I completely agree!". Dive straight into your specific insight or perspective.
- Reference specific points from the post — do not be vague or generic.
- Whenever possible, seamlessly drop a specific real-world company example from your knowledge (e.g. 'This reminds me of how companies like [Company Name] handled this...').
- BANNED AI WORDS: "kudos", "delighted", "deep dive", "game-changer", "spot on", "essential read", "couldn't agree more", "revolutionary", "insightful", "valuable perspective", "unleash", "elevate", "in today's rapidly evolving", "navigating".
- The final output MUST look like a genuine, manually typed professional comment.
- Market knowledge must be updated to the current date: June 2026.
${emojiContext}${lengthContext}${styleContext}${customPrompt ? `\n\n=== CUSTOM INSTRUCTIONS (HIGHEST PRIORITY) ===\n${customPrompt}` : ''}

OUTPUT FORMAT — Return ONLY valid JSON with exactly 3 keys:
{
  "v1": "...",
  "v2": "...",
  "v3": "..."
}

All 3 variations MUST follow the same strategy but use different angles, opening lines, or references.`;

  const userPromptHook = addHook ? '\n\nCRITICAL REQUIREMENT: Instead of generating a full comment, you MUST output ONLY a standalone, thought-provoking question or hook that practically forces the original poster to reply. Do NOT output any filler or agreements. JUST the question. Furthermore, EVERY SINGLE variation MUST be framed around a specific, real-world company example from the target market.' : '';
  const userPrompt = `Generate 3 comment variations for this LinkedIn ${contextType === 'reply' ? 'comment' : 'post'}:\n\n"""\n${postText.substring(0, 3000)}\n"""${userPromptHook}`;

  const errors = [];

  // 1. Try Gemini first (primary)
  if (geminiApiKey) {
    try {
      console.log('[LinkedIn AI ICP] Trying Gemini API...');
      const result = await callGeminiApi(geminiApiKey, systemPrompt, userPrompt, null);
      if (result && (result.v1 || result.v2 || result.v3)) {
        trackAnalytics([request.commentMode || 'icp'], 1).catch(console.error);
        return [result.v1, result.v2, result.v3].filter(Boolean);
      }
      // Gemini may return other keys — grab string values gracefully
      const vals = Object.values(result).filter(v => typeof v === 'string' && v.trim());
      if (vals.length > 0) return vals.slice(0, 3);
      throw new Error('Gemini returned no usable variations.');
    } catch (err) {
      console.warn('[LinkedIn AI ICP] Gemini failed:', err.message);
      errors.push({ provider: 'Gemini', error: err });
    }
  }

  // 2. Fall back to Groq
  if (groqApiKey) {
    try {
      console.log('[LinkedIn AI ICP] Trying Groq API...');
      const result = await callGroqApi(groqApiKey, systemPrompt, userPrompt, null);
      if (result && (result.v1 || result.v2 || result.v3)) {
        trackAnalytics([request.commentMode || 'icp'], 1).catch(console.error);
        return [result.v1, result.v2, result.v3].filter(Boolean);
      }
      const vals = Object.values(result).filter(v => typeof v === 'string' && v.trim());
      if (vals.length > 0) return vals.slice(0, 3);
      throw new Error('Groq returned no usable variations.');
    } catch (err) {
      console.warn('[LinkedIn AI ICP] Groq failed:', err.message);
      errors.push({ provider: 'Groq', error: err });
    }
  }

  throw new Error('All AI providers failed: ' + errors.map(e => `[${e.provider}] ${e.error.message}`).join(' | '));
}


// Primary Gemini model
const GEMINI_MODELS = [
  'gemini-2.0-flash'           // Primary
];

// Helper function to call the Google Gemini API with automatic model fallback
async function callGeminiApi(apiKey, systemInstruction, userText, imageData) {
  // Initialize parts array with user text prompt
  const parts = [{ text: userText }];

  // If base64 image data is provided, append it to the parts array in Gemini's expected format
  if (imageData) {
    parts.push({
      inlineData: {
        mimeType: imageData.mimeType,
        data: imageData.data
      }
    });
  }

  let lastError = null;

  // Try each Gemini model in order until one succeeds
  for (const model of GEMINI_MODELS) {
    // Skip gemini-1.0-pro if there is image data (it doesn't support vision)
    if (model === 'gemini-1.0-pro' && imageData) {
      console.log(`[LinkedIn AI] Skipping ${model} (no vision support)`);
      continue;
    }

    try {
      console.log(`[LinkedIn AI] Trying Gemini model: ${model}`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: parts }],
          systemInstruction: { parts: [{ text: systemInstruction }] },
          generationConfig: {
            responseMimeType: model === 'gemini-1.0-pro' ? undefined : 'application/json',
            temperature: 0.7
          }
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const message = errorData.error?.message || `HTTP error! Status: ${response.status}`;
        const errObj = new Error(message);
        errObj.status = response.status;
        const msgLower = message.toLowerCase();
        // If rate-limited, not found, or unsupported/decommissioned, try next model
        if (response.status === 429 || response.status === 404 || msgLower.includes('quota') || msgLower.includes('resource exhausted') || msgLower.includes('not found') || msgLower.includes('not supported') || msgLower.includes('decommissioned')) {
          console.warn(`[LinkedIn AI] Gemini ${model} failed (Rate limit/Not Found/Unsupported). Trying next model...`);
          lastError = errObj;
          continue;
        }
        throw errObj;
      }

      const data = await response.json();
      if (!data.candidates || data.candidates.length === 0 || !data.candidates[0].content?.parts?.length) {
        throw new Error(`Invalid response structure from Gemini model: ${model}`);
      }

      let textResponse = data.candidates[0].content.parts[0].text;
      if (textResponse.includes('```')) {
        const match = textResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match && match[1]) textResponse = match[1];
      }
      const suggestions = JSON.parse(textResponse.trim());
      if (!suggestions || typeof suggestions !== 'object' || Object.keys(suggestions).length === 0) {
        throw new Error('API returned empty JSON object');
      }

      console.log(`[LinkedIn AI] Gemini ${model} succeeded.`);
      return suggestions;

    } catch (err) {
      const errMsg = err.message ? err.message.toLowerCase() : '';
      if (err.status === 429 || err.status === 404 || errMsg.includes('quota') || errMsg.includes('rate limit') || errMsg.includes('resource exhausted') || errMsg.includes('not found') || errMsg.includes('not supported') || errMsg.includes('decommissioned')) {
        console.warn(`[LinkedIn AI] Gemini ${model} failed (Rate limit/Not Found/Unsupported). Trying next model...`);
        lastError = err;
        continue;
      }
      // For other errors, throw immediately
      throw err;
    }
  }

  // All Gemini models exhausted
  const errObj = lastError || new Error('All Gemini models are rate-limited or unavailable.');
  errObj.status = errObj.status || 429;
  throw errObj;
}

// Groq fallback model
const GROQ_TEXT_MODELS = [
  'llama-3.3-70b-versatile'    // Fallback
];

// Helper function to call the Groq API
async function callGroqApi(apiKey, systemInstruction, userPrompt, imageData) {
  const modelsToTry = GROQ_TEXT_MODELS;

  let lastError = null;

  for (const modelName of modelsToTry) {
    // Build the user content format: image+text for vision models, text-only otherwise
    const isVisionModel = modelName.includes('vision');
    let userContent;
    if (imageData && isVisionModel) {
      userContent = [
        { type: 'text', text: userPrompt },
        { type: 'image_url', image_url: { url: `data:${imageData.mimeType};base64,${imageData.data}` } }
      ];
    } else {
      // Text-only (either no image, or vision models exhausted)
      userContent = userPrompt;
    }

    try {
      console.log(`[LinkedIn AI] Trying Groq model: ${modelName}`);
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: userContent }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.7
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const message = errorData.error?.message || `HTTP error! Status: ${response.status}`;
        const errObj = new Error(message);
        errObj.status = response.status;
        const msgLower = message.toLowerCase();
        // If rate-limited, not found, or decommissioned, try next model
        if (response.status === 429 || response.status === 404 || msgLower.includes('rate limit') || msgLower.includes('quota') || msgLower.includes('not found') || msgLower.includes('decommissioned') || msgLower.includes('not supported')) {
          console.warn(`[LinkedIn AI] Groq ${modelName} failed (Rate limit/Not Found/Decommissioned). Trying next model...`);
          lastError = errObj;
          continue;
        }
        throw errObj;
      }

      const data = await response.json();
      if (!data.choices || data.choices.length === 0 || !data.choices[0].message?.content) {
        throw new Error(`Invalid response structure from Groq model: ${modelName}`);
      }

      let textResponse = data.choices[0].message.content;
      if (textResponse.includes('```')) {
        const match = textResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match && match[1]) textResponse = match[1];
      }
      const suggestions = JSON.parse(textResponse.trim());
      if (!suggestions || typeof suggestions !== 'object' || Object.keys(suggestions).length === 0) {
        throw new Error('API returned empty JSON object');
      }

      console.log(`[LinkedIn AI] Groq ${modelName} succeeded.`);
      return suggestions;

    } catch (err) {
      const errMsg = err.message ? err.message.toLowerCase() : '';
      if (err.status === 429 || err.status === 404 || errMsg.includes('rate limit') || errMsg.includes('quota') || errMsg.includes('not found') || errMsg.includes('decommissioned') || errMsg.includes('not supported')) {
        console.warn(`[LinkedIn AI] Groq ${modelName} failed (Rate limit/Not Found/Decommissioned). Trying next model...`);
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  const errObj = lastError || new Error('All Groq models are rate-limited or unavailable.');
  errObj.status = errObj.status || 429;
  throw errObj;
}

// Helper function to handle bulk reply generation
async function handleGenerateBulkReplies(commentsList) {
  const env = await loadEnvKeys();
  const geminiApiKey = env.GEMINI_API_KEY;
  const groqApiKey = env.GROQ_API_KEY;
  const storage = await chrome.storage.local.get(['commentLength', 'userDesignation', 'customDesignation', 'emojisEnabled', 'customPrompt', 'styleProfile', 'stylePromptCount']);

  if (!geminiApiKey && !groqApiKey) throw new Error('NO_API_KEY');

  const commentLength = storage.commentLength || 'medium';
  const userDesignation = storage.userDesignation || 'general';
  const customDesignation = storage.customDesignation || '';
  const emojisEnabled = !!storage.emojisEnabled;
  const customPrompt = storage.customPrompt || '';

  let designationText = "";
  if (userDesignation === 'custom' && customDesignation.trim()) {
    designationText = customDesignation.trim();
  } else if (userDesignation && userDesignation !== 'general') {
    const designationMap = {
      software_engineer: "Software Engineer",
      product_manager: "Product Manager",
      recruiter: "Recruiter / HR",
      founder: "Founder / CEO",
      student: "Student / Job Seeker"
    };
    designationText = designationMap[userDesignation] || "";
  }

  let roleContext = designationText ? `\n- The user's role/designation is: "${designationText}". You MUST tailor the generated replies to sound like they are written by someone in this specific role.` : "";
  let emojiContext = emojisEnabled ? `\n- You MUST include relevant emojis in each reply naturally (1-2 emojis per reply).` : `\n- You MUST NOT include any emojis in the replies.`;

  let lengthContext = "";
  if (commentLength === 'short') {
    lengthContext = `\n- LENGTH CONSTRAINT: You MUST write exactly 1 sentence on exactly 1 line. Maximum 25 words. DO NOT EXCEED 1 SENTENCE OR 1 LINE.`;
  } else if (commentLength === 'long') {
    lengthContext = `\n- LENGTH CONSTRAINT: You MUST write exactly 3 to 5 sentences.`;
  } else {
    lengthContext = `\n- LENGTH CONSTRAINT: You MUST write exactly 1 or 2 sentences across a maximum of 1 or 2 lines. DO NOT EXCEED 2 SENTENCES OR 2 LINES TOTAL. This is a strict hard limit.`;
  }

  // Build personal style context for bulk replies
  let bulkStyleContext = "";
  const bulkStyleProfile = storage.styleProfile || { enabled: true, comments: [] };
  const bulkStylePromptCount = storage.stylePromptCount || 10;
  if (bulkStyleProfile.enabled !== false && bulkStyleProfile.comments && bulkStyleProfile.comments.length > 0) {
    bulkStyleContext = buildStyleContext(bulkStyleProfile.comments, bulkStylePromptCount);
  }

  let customContext = customPrompt ? `\n\n=== CUSTOM USER INSTRUCTIONS (HIGHEST PRIORITY) ===\n${customPrompt}\n===================================================` : "";

  const systemInstruction = `You are an elite LinkedIn engagement assistant acting as a "Bulk Replier" for a creator who received many comments on their post.
You will be provided a JSON string containing an array of comments: [{"id": "...", "text": "..."}].
Your job is to read these comments and do the following:
1. Identify trivial/noise comments (e.g., "Thanks for sharing", "Great post!", "CFBR", "Agreed").
2. Identify substantial comments that warrant a personalized reply.
3. For ONLY the substantial comments, draft a personalized reply from the post author to the commenter.

Guidelines for replies:${roleContext}${emojiContext}${lengthContext}
- Speak like a real human professional but keep normal English as I am from Gujarat, India. Do NOT use generic praise or filler phrases.
- Reference specific topics or questions mentioned in their comments.
- Avoid AI-like buzzwords: "delighted", "deep dive", "game-changer", "spot on", "couldn't agree more", "absolutely", "exactly", "perfectly", "nailed it", "spot on", "well said", "couldn't agree more", "on point", "perfect", "excellent", "great", "wonderful", "super", "impressive", "remarkable", "stellar", "terrific", "splendid", "magnificent", "splendid", "splendid".

You MUST reply ONLY with a valid JSON object where the keys are the stringified \`id\` of the substantial comments, and the values are the \`drafted_reply\`. Do NOT include trivial comments in the output JSON.
Example output format:
{
  "0": "Thanks! I actually found the second point to be the hardest to implement.",
  "2": "Great question. I usually prefer X over Y because of Z."
}${bulkStyleContext}${customContext}`;

  const userText = JSON.stringify(commentsList);
  const errors = [];

  if (geminiApiKey) {
    try {
      console.log(`[LinkedIn AI Bulk] Calling Gemini`);
      const resp = await callGeminiBulkApi(geminiApiKey, systemInstruction, userText);

      const numDrafts = Object.keys(resp).length;
      if (numDrafts > 0) trackAnalytics(Array(numDrafts).fill("bulk"), numDrafts).catch(console.error);

      return resp;
    } catch (err) {
      console.warn(`[LinkedIn AI] Gemini bulk failed:`, err.message);
      errors.push({ provider: 'Gemini', error: err });
    }
  }

  if (groqApiKey) {
    try {
      console.log(`[LinkedIn AI Bulk] Calling Groq`);
      const resp = await callGroqBulkApi(groqApiKey, systemInstruction, userText);

      const numDrafts = Object.keys(resp).length;
      if (numDrafts > 0) trackAnalytics(Array(numDrafts).fill("bulk"), numDrafts).catch(console.error);

      return resp;
    } catch (err) {
      console.warn(`[LinkedIn AI] Groq bulk failed:`, err.message);
      errors.push({ provider: 'Groq', error: err });
    }
  }

  throw new Error("Bulk reply generation failed: " + errors.map(e => `[${e.provider}] ${e.error.message}`).join(' | '));
}

async function callGeminiBulkApi(apiKey, systemInstruction, userText) {
  // Try each Gemini model in order, falling back on rate-limit
  for (const model of GEMINI_MODELS) {
    try {
      console.log(`[LinkedIn AI Bulk] Trying Gemini model: ${model}`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          systemInstruction: { parts: [{ text: systemInstruction }] },
          generationConfig: { responseMimeType: model === 'gemini-1.0-pro' ? undefined : 'application/json', temperature: 0.7 }
        })
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const msg = errData.error?.message || `HTTP ${response.status}`;
        const msgLower = msg.toLowerCase();
        if (response.status === 429 || response.status === 404 || msgLower.includes('quota') || msgLower.includes('resource exhausted') || msgLower.includes('not found') || msgLower.includes('not supported') || msgLower.includes('decommissioned')) {
          console.warn(`[LinkedIn AI Bulk] Gemini ${model} failed (Rate limit/Not Found/Unsupported), trying next...`);
          continue;
        }
        throw new Error(msg);
      }
      const data = await response.json();
      let textResponse = data.candidates[0].content.parts[0].text;

      // Safely strip markdown
      if (textResponse.includes('```')) {
        const match = textResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match && match[1]) {
          textResponse = match[1];
        }
      }

      return JSON.parse(textResponse.trim());
    } catch (err) {
      const errMsg = err.message ? err.message.toLowerCase() : '';
      if (err.status === 429 || err.status === 404 || errMsg.includes('quota') || errMsg.includes('rate limit') || errMsg.includes('resource exhausted') || errMsg.includes('not found') || errMsg.includes('not supported') || errMsg.includes('decommissioned')) {
        console.warn(`[LinkedIn AI Bulk] Gemini ${model} failed (Rate limit/Not Found/Unsupported), trying next...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error('All Gemini models rate-limited for bulk generation.');
}

async function callGroqBulkApi(apiKey, systemInstruction, userPrompt) {
  // Try each Groq text model in order, falling back on rate-limit
  for (const model of GROQ_TEXT_MODELS) {
    try {
      console.log(`[LinkedIn AI Bulk] Trying Groq model: ${model}`);
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'system', content: systemInstruction }, { role: 'user', content: userPrompt }],
          response_format: { type: 'json_object' },
          temperature: 0.7
        })
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const msg = errData.error?.message || `HTTP ${response.status}`;
        const msgLower = msg.toLowerCase();
        if (response.status === 429 || response.status === 404 || msgLower.includes('rate limit') || msgLower.includes('quota') || msgLower.includes('not found') || msgLower.includes('decommissioned') || msgLower.includes('not supported')) {
          console.warn(`[LinkedIn AI Bulk] Groq ${model} failed (Rate limit/Not Found/Decommissioned), trying next...`);
          continue;
        }
        throw new Error(msg);
      }
      const data = await response.json();
      let textResponse = data.choices[0].message.content;

      // Safely strip markdown code blocks if the LLM added them
      if (textResponse.includes('```')) {
        const match = textResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match && match[1]) {
          textResponse = match[1];
        }
      }

      return JSON.parse(textResponse.trim());
    } catch (err) {
      const errMsg = err.message ? err.message.toLowerCase() : '';
      if (err.status === 429 || err.status === 404 || errMsg.includes('rate limit') || errMsg.includes('quota') || errMsg.includes('not found') || errMsg.includes('decommissioned') || errMsg.includes('not supported')) {
        console.warn(`[LinkedIn AI Bulk] Groq ${model} failed (Rate limit/Not Found/Decommissioned), trying next...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error('All Groq models rate-limited for bulk generation.');
}

async function handleGenerateVoiceSignature(request) {
  const env = await loadEnvKeys();
  if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY) {
    throw new Error('No API key configured.');
  }

  const s = await chrome.storage.local.get(['styleProfile']);
  const profile = s.styleProfile || { comments: [] };
  if (!profile.comments || profile.comments.length === 0) {
    throw new Error('No comments found to analyze.');
  }

  const commentsText = profile.comments.map(c => `- "${c.text}"`).join('\n');

  const systemPrompt = `You are an expert ghostwriter and copywriter. Analyze the following LinkedIn comments written by the user. 
Extract their underlying "Voice Signature" — the abstract structural template or framework they consistently use when commenting.

Output ONLY a JSON object with a single key "signature" containing the template string. 
For example: {"signature": "I completely agree — [reframe at higher level]. It wonders me in 2026, is the real competition still about [X], or about who can [Y] longer?"}

Do not output ANY extra text, introductions, or markdown formatting around the JSON. Keep the signature under 150 characters.

User's Comments:
${commentsText}`;

  let result = '';
  if (env.GEMINI_API_KEY) {
    try {
      result = await callGeminiApi(env.GEMINI_API_KEY, systemPrompt, "Analyze the comments and output my voice signature template.", null);
    } catch (err) {
      console.warn('[LinkedIn Voice Signature] Gemini failed, falling back to Groq...', err);
      if (env.GROQ_API_KEY) {
        result = await callGroqApi(env.GROQ_API_KEY, systemPrompt, "Analyze the comments and output my voice signature template.", null);
      } else {
        throw err;
      }
    }
  } else if (env.GROQ_API_KEY) {
    result = await callGroqApi(env.GROQ_API_KEY, systemPrompt, "Analyze the comments and output my voice signature template.", null);
  }

  if (!result || typeof result !== 'object' || !result.signature) {
    throw new Error('Invalid response from AI (expected JSON object with "signature" key)');
  }

  return result.signature.replace(/^"|"$/g, '').trim();
}
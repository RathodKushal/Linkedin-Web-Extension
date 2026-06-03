// LinkedIn AI Comment Assistant Content Script
// This script runs in the context of the LinkedIn website. It injects the Smile Trigger Button,
// extracts post text and image data, handles suggestion clicks, and writes generated comments to the DOM.

// Helper function to determine if a specific DOM element resides inside a commenting box or any of the extension's UI components
function isInsideCommentOrUI(el) {
  // Return false if element is null/undefined
  if (!el) return false;
  
  // 1. Check standard class names and attributes using closest()
  if (
    el.closest('.comments-comments-list') ||
    el.closest('.comments-comment-item') ||
    el.closest('.ln-ai-panel-wrapper') ||
    el.closest('.ln-ai-suggestions-panel') ||
    el.closest('.ln-ai-trigger-btn') ||
    el.closest('.comments-comment-box') ||
    el.closest('.comments-comment-box__form-container') ||
    el.closest('.ql-editor') ||
    el.closest('.feed-shared-update-v2__comments-container') ||
    el.closest('[class*="comments-container"]') ||
    el.closest('[class*="comments-list"]') ||
    el.closest('[data-comment-id]') ||
    el.closest('[role="comment"]')
  ) {
    return true;
  }
  
  // 2. Check data-urn containing comment
  const urnEl = el.closest('[data-urn]');
  if (urnEl) {
    const urn = urnEl.getAttribute('data-urn') || '';
    if (urn.includes('comment')) {
      return true;
    }
  }
  
  return false;
}

// Utility to filter out noise text elements (such as profile details, social icons, dates, likes counters)
function isNoiseText(el) {
  // If element is empty, treat it as noise
  if (!el) return true;
  // If element resides within a comment thread or the extension UI, skip it
  if (isInsideCommentOrUI(el)) {
    return true;
  }
  
  // List of CSS selectors representing noise containers we want to ignore
  const noiseSelectors = [
    '.feed-shared-actor',
    '.update-components-actor',
    '.feed-shared-update-v2__actor',
    '.feed-shared-header',
    '.update-components-header',
    '.feed-shared-social-action-bar',
    '.feed-shared-update-v2__social-row',
    '.social-community-react-button',
    'button',
    'a',
    '[class*="actor"]',
    '[class*="header"]',
    '[class*="social-action"]',
    '[class*="social-row"]'
  ];
  
  // Check if this text element belongs to any of the noise containers
  for (const selector of noiseSelectors) {
    if (el.closest(selector)) {
      return true;
    }
  }
  
  // Explicit text match filtering for obfuscated UI buttons
  const text = (el.innerText || '').trim().toLowerCase();
  if (text === 'like' || text === 'reply' || text.includes('reaction button state') || text.includes('reactions') || text === 'share' || text === 'repost' || text === 'send' || text === 'comment') {
    return true;
  }
  
  // If none match, it is considered clean content text
  return false;
}

// Helper function to filter out layout icons, avatars, reactions, and tiny decorative images from main post images
function isNoiseImage(img) {
  // Return true if image is empty
  if (!img) return true;
  // Ignore images located inside comment feeds or our AI panels
  if (isInsideCommentOrUI(img)) {
    return true;
  }

  // CSS selectors that represent noise image zones (like profile pictures, logos, reactions)
  const noiseSelectors = [
    '.feed-shared-actor',
    '.update-components-actor',
    '.feed-shared-update-v2__actor',
    '.feed-shared-header',
    '.update-components-header',
    '.comments-post-meta__avatar',
    '.comments-comment-meta__avatar',
    '.comments-comment-box__avatar',
    '.ivm-image-view-model__circle-img',
    '.EntityPhoto-circle',
    '.EntityPhoto-square',
    '.feed-shared-social-action-bar',
    '.feed-shared-update-v2__social-row',
    '.reactions-react-button',
    '.social-community-react-button',
    '[class*="actor"]',
    '[class*="header"]',
    '[class*="avatar"]',
    '[class*="social-action"]',
    '[class*="social-row"]',
    '[class*="react-button"]'
  ];

  // Check if image belongs to any of these noise zones
  for (const sel of noiseSelectors) {
    if (img.closest(sel)) {
      return true;
    }
  }

  // Retrieve the image source attribute
  const src = img.getAttribute('data-delayed-url') || img.getAttribute('data-src') || img.src || '';
  // If no source is found, skip it
  if (!src) return true;

  // Filter out emojis, SVGs, bookmarks, hashes, and small icons
  if (src.includes('emoji') || 
      src.includes('/emoji/') || 
      src.startsWith('data:image/svg+xml') || 
      src.includes('bookmark') || 
      src.includes('hash-') ||
      src.includes('mail-') ||
      src.includes('icon-')) {
    return true;
  }

  // Filter out LinkedIn profile photos, display photos, ghost/empty avatars, and company logos
  if (src.includes('/profile-') || 
      src.includes('/ghost-') || 
      src.includes('profile-displayphoto') || 
      src.includes('profile-displaydecryptedphoto') ||
      src.includes('ghost-person') ||
      src.includes('company-logo') ||
      src.includes('/company-')) {
    return true;
  }

  // Filter out small thumbnails/shrink sizes (e.g. shrink_100_100, shrink_200_200, shrink_400_400)
  // while keeping full-size/large images (e.g. shrink_800, shrink_1280, or no shrink)
  if (src.includes('shrink_')) {
    const shrinkMatch = src.match(/shrink_(\d+)/);
    if (shrinkMatch && shrinkMatch[1]) {
      const size = parseInt(shrinkMatch[1], 10);
      // Filter out small thumbnails < 500px (like profile avatars/logos)
      if (size < 500) {
        return true; 
      }
    }
  }

  // If the image is loaded, check its natural dimensions
  const width = img.naturalWidth || img.width || 0;
  const height = img.naturalHeight || img.height || 0;
  if (width > 0 && height > 0) {
    // If dimensions are smaller than 100x100px, it's considered an icon/decorative element
    if (width < 100 || height < 100) {
      return true;
    }
  }

  // Image is valid post content
  return false;
}

// Cleans up typical LinkedIn boilerplate text strings and compresses redundant spaces
function cleanText(text) {
  if (!text) return '';
  return text.replace(/\bsee\s+more\b/gi, '')
             .replace(/\bsee\s+translation\b/gi, '')
             .replace(/\.\.\.\s*more\b/gi, '')
             .replace(/\bsee\s+less\b/gi, '')
             .replace(/\s+/g, ' ')
             .trim();
}

function isPostCard(el) {
  if (!el) return false;
  // A post card cannot be nested inside a comments area or the extension's UI components
  if (isInsideCommentOrUI(el)) {
    return false;
  }
  
  if (el.hasAttribute('data-urn')) {
    const urn = el.getAttribute('data-urn') || '';
    if (urn.startsWith('urn:li:') && 
        !urn.includes('comment') && 
        !urn.includes('member') && 
        !urn.includes('profile') && 
        !urn.includes('company') && 
        !urn.includes('messaging')) {
      return true;
    }
  }
  if (el.hasAttribute('data-activity-id')) {
    return true;
  }
  if (el.classList.contains('feed-shared-update-v2') || 
      el.classList.contains('feed-shared-update') ||
      el.classList.contains('occludable-update') ||
      el.classList.contains('feed-shared-activity-card')) {
    return true;
  }
  return false;
}

// Finds the parent post card container for a given comment box or editor, utilizing comments section boundary
function findPostContainer(commentBox, commentsSection) {
  let el = commentsSection || commentBox;
  
  // 1. Traverse up and find the outermost/highest element matching isPostCard (Fast path)
  let highestPostCard = null;
  while (el && el !== document.body) {
    if (isPostCard(el)) {
      highestPostCard = el;
    }
    el = el.parentElement;
  }
  
  let candidate = highestPostCard;
  if (!candidate) {
    // 2. Fallback: Climb up from commentsSection, but at most 3 levels to stay local to the card
    el = commentsSection || commentBox;
    candidate = el.parentElement || el;
    let steps = 0;
    const layoutClasses = [
      'scaffold-layout',
      'scaffold-layout__main',
      'scaffold-finite-scroll',
      'feed-shared-update-v2__comments-container',
      'comments-comments-list'
    ];

    while (el && el !== document.body && steps < 3) {
      const tagName = el.tagName.toLowerCase();
      const classStr = el.className || '';
      
      if (tagName === 'main' || layoutClasses.some(cls => el.classList.contains(cls) || classStr.includes(cls))) {
        break;
      }
      
      candidate = el;
      el = el.parentElement;
      steps++;
    }
  }

  // 3. Outermost Safeguard: If the candidate does not contain the post description,
  // we must climb up to its parent/grandparent until we wrap the post description.
  // This handles obfuscated comments wrappers duplicating post URNs.
  let climbEl = candidate;
  while (climbEl && climbEl !== document.body && !containsPostDescription(climbEl)) {
    const parent = climbEl.parentElement;
    if (!parent || parent.tagName.toLowerCase() === 'main' || (parent.className || '').includes('scaffold-layout')) {
      break;
    }
    climbEl = parent;
    candidate = climbEl;
  }
  
  return candidate;
}

// Finds the parent comment item we are replying to, using structural and document position checks.
function findParentComment(commentBox, postContainer) {
  // 1. Check if the comment box is directly inside a comment item
  const closestComment = commentBox.closest('.comments-comment-item, [data-comment-id], article');
  if (closestComment && postContainer.contains(closestComment)) {
    return closestComment;
  }
  
  // 2. If appended as a sibling or outside, find all comments in the post container
  const allComments = Array.from(postContainer.querySelectorAll('.comments-comment-item, [data-comment-id], article, [role="comment"]'))
      .filter(el => !commentBox.contains(el)); // ignore if somehow inside the editor
  
  // Iterate in document order and find the last comment that appears BEFORE the comment box
  let closestBefore = null;
  for (const comment of allComments) {
    const pos = comment.compareDocumentPosition(commentBox);
    // DOCUMENT_POSITION_FOLLOWING (4) means commentBox follows comment
    // DOCUMENT_POSITION_CONTAINED_BY (16) means commentBox is inside comment
    if ((pos & Node.DOCUMENT_POSITION_FOLLOWING) || (pos & Node.DOCUMENT_POSITION_CONTAINED_BY)) {
      closestBefore = comment;
    } else {
      break;
    }
  }
  
  if (closestBefore) {
    // If structural checking gave us a comment, let's keep it as a fallback
    // But we still prefer the exact name match if available, to avoid edge cases where DOM order is disconnected.
  }
  
  // 3. Fallback: Search by targeted author name (The ultimate foolproof check)
  // Extract name from placeholder (e.g. "Reply to Manoj...") or typed text (e.g. "Manoj Rajoriya")
  let targetName = '';
  const editor = commentBox.classList.contains('ql-editor') ? commentBox : (commentBox.querySelector('.ql-editor') || commentBox.querySelector('[contenteditable="true"]') || commentBox);
  
  if (editor) {
      let placeholder = (editor.getAttribute('data-placeholder') || editor.getAttribute('aria-label') || '').toLowerCase();
      if (!placeholder) {
          const childPlaceholder = editor.querySelector('[data-placeholder], [aria-label]');
          if (childPlaceholder) {
              placeholder = (childPlaceholder.getAttribute('data-placeholder') || childPlaceholder.getAttribute('aria-label') || '').toLowerCase();
          }
      }
      if (placeholder.includes('reply to')) {
          targetName = placeholder.replace('reply to', '').replace(/\.+$/, '').trim();
      }
  }
  
  if (!targetName) {
      targetName = extractUserTypedText(commentBox).trim().toLowerCase();
  }
  
  if (targetName) {
     const cleanTarget = targetName.replace(/[\n\r].*/g, '').replace(/[^a-z0-9 ]/gi, '').trim();
     
     if (cleanTarget.length > 2) {
       for (const comment of allComments) {
           const authorEl = comment.querySelector('.comments-post-meta__name-text, .comments-comment-meta__name-text, .update-components-actor__name, .comments-comment-meta__description-title');
           if (authorEl) {
               const authorName = (authorEl.innerText || '').toLowerCase();
               const cleanAuthor = authorName.replace(/[\n\r].*/g, '').replace(/[^a-z0-9 ]/gi, '').trim();
               
               if (cleanAuthor && cleanTarget && (cleanAuthor.includes(cleanTarget) || cleanTarget.includes(cleanAuthor))) {
                   console.log('[LinkedIn AI] Found parent comment by author name match:', cleanAuthor);
                   return comment;
               }
           }
       }
       
       // Global fallback: If postContainer was broken, search the whole page for that author!
       const globalComments = document.querySelectorAll('.comments-comment-item, [data-comment-id], article, [role="comment"]');
       for (const comment of globalComments) {
           if (commentBox.contains(comment)) continue;
           const authorEl = comment.querySelector('.comments-post-meta__name-text, .comments-comment-meta__name-text, .update-components-actor__name, .comments-comment-meta__description-title');
           if (authorEl) {
               const authorName = (authorEl.innerText || '').toLowerCase();
               const cleanAuthor = authorName.replace(/[\n\r].*/g, '').replace(/[^a-z0-9 ]/gi, '').trim();
               
               if (cleanAuthor && cleanTarget && (cleanAuthor.includes(cleanTarget) || cleanTarget.includes(cleanAuthor))) {
                   console.log('[LinkedIn AI] Found parent comment via GLOBAL author name match:', cleanAuthor);
                   return comment;
               }
           }
       }
     }
  }
  
   if (closestBefore) {
       return closestBefore;
   }
   
   // Ultimate global structural fallback if targetName fails and postContainer was broken
   const globalCommentsBackup = document.querySelectorAll('.comments-comment-item, [data-comment-id], article');
   let globalClosestBefore = null;
   for (const comment of globalCommentsBackup) {
       if (commentBox.contains(comment)) continue;
       const pos = comment.compareDocumentPosition(commentBox);
       if ((pos & Node.DOCUMENT_POSITION_FOLLOWING) || (pos & Node.DOCUMENT_POSITION_CONTAINED_BY)) {
           globalClosestBefore = comment;
       } else {
           break;
       }
   }
   
   return globalClosestBefore;
}


// Helper to verify if a candidate container wraps the main post description/commentary
function containsPostDescription(element) {
  const elements = element.querySelectorAll('span, p, div');
  let totalTextLength = 0;
  for (const el of elements) {
    // Must not be inside comments or UI
    if (isInsideCommentOrUI(el)) continue;
    if (el.closest('a') || el.closest('button')) continue;
    
    // Target leaf text elements (no child formatting blocks)
    if (!el.querySelector('span, p, div')) {
      const txt = (el.innerText || '').trim();
      totalTextLength += txt.length;
      if (totalTextLength > 10) {
        return true;
      }
    }
  }
  return false;
}

// Finds the comments section wrapper starting from commentBox
// This lets us block comment elements structural-wise, independent of dynamic classes!
function findCommentsSection(commentBox) {
  let el = commentBox;
  
  // 1. Try to find the closest ancestor that matches comment containers
  while (el && el !== document.body) {
    const classStr = el.className || '';
    if (
      el.classList.contains('feed-shared-update-v2__comments-container') ||
      el.classList.contains('comments-comments-list') ||
      classStr.includes('comments-container') ||
      classStr.includes('comments-list') ||
      classStr.includes('comment-box')
    ) {
      return el;
    }
    el = el.parentElement;
  }

  // 2. Fallback: Traverse up from commentBox.
  // We want the highest ancestor that has siblings with substantial text under the same parent (ignoring comment/UI siblings).
  // We limit the climb to at most 8 levels to support deeply nested reply editors, but terminate early if we hit layout, post cards, or wrap the post description.
  el = commentBox;
  let candidate = commentBox;
  let depth = 0;
  while (el && el.parentElement && depth < 8) {
    const parent = el.parentElement;
    const tagName = parent.tagName.toLowerCase();
    const classStr = parent.className || '';
    
    // Stop climbing if we hit major layout boundaries or post card containers,
    // or if the parent wraps the main post description (which means el is the comments boundary!)
    if (tagName === 'main' || 
        isPostCard(parent) ||
        isPostCard(el) ||
        containsPostDescription(parent) ||
        classStr.includes('scaffold-layout') || 
        classStr.includes('scaffold-finite-scroll') || 
        classStr.includes('feed-shared-update-v2__comments-container') || 
        classStr.includes('comments-comments-list')) {
      break;
    }
    
    // Find siblings of the current element at this level
    const siblings = Array.from(parent.children).filter(child => child !== el);
    let siblingsHaveText = false;
    
    for (const sib of siblings) {
      // Skip comments list, comment items, or custom AI trigger/suggestions wrappers
      if (isInsideCommentOrUI(sib)) continue;
      // Skip actor headers, social row bars, and other noise siblings
      if (isNoiseText(sib)) continue;
      
      const sibText = sib.innerText || '';
      if (sibText.trim().replace(/\s+/g, ' ').length > 15) {
        siblingsHaveText = true;
        break;
      }
    }
    
    if (siblingsHaveText) {
      // el has siblings with substantial text, meaning el does not wrap the whole post content card yet.
      // So el is a valid candidate for the comments section wrapper.
      candidate = el;
    }
    
    el = parent;
    depth++;
  }
  
  return candidate;
}

// Extracts all text content related to the post from within its container, excluding the comments section
function extractPostText(postContainer, commentsSection, commentBox) {
  // 1. Try specific commentary classes first
  const selectors = [
    '.feed-shared-update-v2__commentary',
    '.update-components-text',
    '.feed-shared-inline-show-more-text',
    '.feed-shared-update-v2__description',
    '.feed-shared-text-view',
    '.feed-shared-update-v2__text',
    '[data-test-id="main-feed-activity-card__commentary"]',
    '[class*="commentary"]',
    // Fallbacks
    'span.break-words',
    'p'
  ];

  let foundTexts = [];

  for (const selector of selectors) {
    const elements = postContainer.querySelectorAll(selector);
    for (const el of elements) {
      if (commentBox && commentBox.contains(el)) continue;
      if (commentsSection && commentsSection.contains(el)) continue;
      if (isNoiseText(el)) continue;

      let text = el.innerText.trim();
      text = cleanText(text);

      if (text.length > 10) {
        if (isInsideCommentOrUI(el)) continue;

        let isDuplicate = false;
        for (let i = 0; i < foundTexts.length; i++) {
          const existing = foundTexts[i];
          if (existing.includes(text)) {
            isDuplicate = true;
            break;
          }
          if (text.includes(existing)) {
            foundTexts[i] = text;
            isDuplicate = true;
            break;
          }
        }
        if (!isDuplicate) {
          foundTexts.push(text);
        }
      }
    }
  }

  // 2. Generic Fallback: If no text was resolved (classes completely obfuscated/generic)
  if (foundTexts.length === 0) {
    const elements = postContainer.querySelectorAll('span, p, div');
    for (const el of elements) {
      if (commentBox && commentBox.contains(el)) continue;
      if (commentsSection && commentsSection.contains(el)) continue;
      if (isNoiseText(el)) continue;
      if (el.closest('a') || el.closest('button')) continue;

      let text = el.innerText.trim();
      text = cleanText(text);

      if (text.length > 8) {
        if (isInsideCommentOrUI(el)) continue;

        let isDuplicate = false;
        for (let i = 0; i < foundTexts.length; i++) {
          const existing = foundTexts[i];
          if (existing.includes(text)) {
            isDuplicate = true;
            break;
          }
          if (text.includes(existing)) {
            foundTexts[i] = text;
            isDuplicate = true;
            break;
          }
        }
        if (!isDuplicate) {
          foundTexts.push(text);
        }
      }
    }
  }

  return foundTexts.join('\n\n');
}

// Extracts the primary content image URL related to the post, excluding the comments section
function extractPostImage(postContainer, commentsSection) {
  const imageSelectors = [
    '.update-components-image img',
    '.feed-shared-image__container img',
    '.feed-shared-image img',
    '.update-components-article__image img',
    '.feed-shared-article__image img',
    '.update-components-image__image img',
    '.feed-shared-update-v2__content img',
    'img.feed-shared-image',
    'img'
  ];

  for (const selector of imageSelectors) {
    const images = postContainer.querySelectorAll(selector);
    for (const img of images) {
      if (commentsSection && commentsSection.contains(img)) continue;
      if (isNoiseImage(img)) continue;
      
      const src = img.getAttribute('data-delayed-url') || img.getAttribute('data-src') || img.src;
      if (src) {
        return src;
      }
    }
  }
  return '';
}

// Extracts the text of the parent comment we are replying to, independent of class names.
function extractParentCommentText(parentComment, commentBox) {
  const textParts = [];
  
  // Specific selectors that typically hold comment text
  const selectors = [
    '.comments-comment-item__main-content',
    '.comments-comment-item__text',
    '.comments-comment-item-content-body',
    '.update-components-text',
    '.break-words'
  ];
  
  for (const selector of selectors) {
    const elements = parentComment.querySelectorAll(selector);
    for (const el of elements) {
      if (commentBox && commentBox.contains(el)) continue;
      if (el.closest('.ln-ai-panel-wrapper') || el.closest('.ln-ai-suggestions-panel')) continue;
      if (el.closest('[contenteditable="true"]') || el.closest('.ql-editor') || el.closest('.tiptap')) continue;
      if (el.closest('a') || el.closest('button')) continue;
      let text = el.innerText.trim();
      text = cleanText(text);
      if (text.length > 0 && !textParts.includes(text)) {
        textParts.push(text);
      }
    }
    if (textParts.length > 0) break;
  }
  
  // Fallback
  if (textParts.length === 0) {
    const allEls = parentComment.querySelectorAll('span, p');
    for (const el of allEls) {
      if (commentBox && commentBox.contains(el)) continue;
      if (el.closest('.ln-ai-panel-wrapper') || el.closest('.ln-ai-suggestions-panel')) continue;
      if (el.closest('[contenteditable="true"]') || el.closest('.ql-editor') || el.closest('.tiptap')) continue;
      if (el.closest('a') || el.closest('button')) continue;
      if (!el.querySelector('span, p')) {
        let text = (el.innerText || '').trim();
        text = cleanText(text);
        if (text.length > 0 && !textParts.includes(text)) {
          textParts.push(text);
        }
      }
    }
  }
  
  return textParts.join(' ').trim();
}


// Extracts any text currently typed in the comment editor (e.g., an auto-populated @Username)
function extractUserTypedText(commentBox) {
  try {
    let editor = commentBox.classList.contains('ql-editor') ? commentBox : (commentBox.querySelector('.ql-editor') || null);
    if (!editor) {
       editor = commentBox.hasAttribute('contenteditable') ? commentBox : commentBox.querySelector('[contenteditable="true"]');
    }
    if (!editor) {
       editor = commentBox;
    }
    
    let text = '';
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        if (node.parentElement && (
            node.parentElement.closest('.ln-ai-panel-wrapper') ||
            node.parentElement.closest('.ln-ai-action-row') ||
            node.parentElement.closest('.ln-ai-trigger-btn') ||
            node.parentElement.closest('.ln-ai-regen-btn') ||
            node.parentElement.closest('.ln-ai-suggestions-panel') ||
            node.parentElement.closest('button')
        )) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    
    while(walker.nextNode()) {
      text += walker.currentNode.nodeValue + ' ';
    }
    
    text = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    text = text.replace(/\s+/g, ' ');
    return text;
  } catch (err) {
    console.warn('[LinkedIn AI] Failed to extract typed text:', err);
    return '';
  }
}

// Fallback algorithm that walks backwards through the DOM from the commentBox
// looking for the first substantial chunk of non-UI text.
function backwardExtractParentText(commentBox) {
  let el = commentBox;
  let fallbackText = '';
  let steps = 0;
  
  while (el && el !== document.body && steps < 500) {
    let prev = el.previousSibling;
    while (prev) {
      if (prev.nodeType === Node.ELEMENT_NODE) {
        // Collect all text from this element
        const texts = Array.from(prev.querySelectorAll('*')).map(child => {
          if (child.childNodes.length === 1 && child.childNodes[0].nodeType === Node.TEXT_NODE) {
            return { el: child, text: child.innerText?.trim() };
          }
          return null;
        }).filter(Boolean);
        
        // Also check the element itself if it has no children
        if (prev.childNodes.length === 1 && prev.childNodes[0].nodeType === Node.TEXT_NODE) {
            texts.push({ el: prev, text: prev.innerText?.trim() });
        }
        
        // Process collected texts in reverse order (closest to commentBox first)
        for (let i = texts.length - 1; i >= 0; i--) {
          const item = texts[i];
          if (!item.text || item.text.length < 2) continue;
          if (isInsideCommentOrUI(item.el)) continue;
          if (item.el.closest('a') || item.el.closest('button')) continue;
          if (isNoiseText(item.el)) continue;
          
          fallbackText = item.text + ' ' + fallbackText;
          
          // If we've gathered at least a reasonable amount of text, assume we found the comment
          if (fallbackText.length > 5) {
            return cleanText(fallbackText);
          }
        }
      } else if (prev.nodeType === Node.TEXT_NODE) {
         const text = prev.nodeValue.trim();
         if (text.length > 5) {
             return cleanText(text);
         }
      }
      prev = prev.previousSibling;
      steps++;
    }
    el = el.parentElement;
    steps++;
  }
  return cleanText(fallbackText);
}

// Extract post description text and image URL by walking up from the comment box
function extractPostContent(commentBox, forceReplyMode = false) {
  console.log('[LinkedIn AI] Starting content extraction from comment box...', { forceReplyMode });

  // 1. First find the comments section boundaries
  const commentsSection = findCommentsSection(commentBox);

  // 2. Find the post card ancestor container using the comments section
  const postContainer = findPostContainer(commentBox, commentsSection);
  if (!postContainer) {
    console.warn('[LinkedIn AI] Could not find post container ancestor');
    return {
      postText: '',
      imageUrl: '',
      isReply: false,
      mainPostText: '',
      diagnostics: 'No post container found'
    };
  }

  // Detect if this comment box is inside a parent comment (meaning it is a reply)
  const parentComment = findParentComment(commentBox, postContainer);
  const isReply = forceReplyMode || !!parentComment;
  let parentCommentText = '';

  if (isReply) {
    console.log('[LinkedIn AI] Detected reply comment box. Extracting parent comment text...');
    if (parentComment) {
      parentCommentText = extractParentCommentText(parentComment, commentBox);
    } 
    
    // Fallback: If structural extraction failed or parentComment was null, use the backwards visual walker
    if (!parentCommentText) {
      console.log('[LinkedIn AI] Using backward visual walker to find parent comment text...');
      parentCommentText = backwardExtractParentText(commentBox);
    }
  }

  // Extract both text and image from the resolved post container, excluding the comments section
  const mainPostText = extractPostText(postContainer, commentsSection, commentBox);
  const imageUrl = extractPostImage(postContainer, commentsSection);
  const userTypedText = extractUserTypedText(commentBox);
  
  // Format container diagnostic descriptor
  const classStr = postContainer.className || '';
  const containerDesc = `${postContainer.tagName}.${classStr.trim().replace(/\s+/g, '.')}`;

  console.log('[LinkedIn AI] Extraction results:', {
    isReply: isReply,
    parentCommentLength: parentCommentText.length,
    mainPostTextLength: mainPostText.length,
    imageUrl: imageUrl,
    userTypedText: userTypedText,
    diagnostics: containerDesc
  });

  let diagnostics = `Resolved container: ${containerDesc}`;
  const targetText = isReply ? parentCommentText : mainPostText;
  if (!targetText && !imageUrl) {
    const directChildren = Array.from(postContainer.children).map(c => `${c.tagName}.${(c.className || '').trim().replace(/\s+/g, '.')}`);
    diagnostics += `\nDirect children of container: ${directChildren.join(', ')}`;
    diagnostics += `\nComments section: ${commentsSection ? `${commentsSection.tagName}.${(commentsSection.className || '').trim().replace(/\s+/g, '.')}` : 'null'}`;
    if (commentsSection) {
      const commChildren = Array.from(commentsSection.children).map(c => `${c.tagName}.${(c.className || '').trim().replace(/\s+/g, '.')}`);
      diagnostics += `\nDirect children of comments section: ${commChildren.join(', ')}`;
    }
    diagnostics += `\nChild elements with text:`;
    const childList = [];
    const elements = postContainer.querySelectorAll('*');
    diagnostics += `\nTotal elements in container: ${elements.length}`;
    let count = 0;
    for (const el of elements) {
      // Get elements that have direct text content (leaf-like)
      const children = Array.from(el.childNodes);
      const hasDirectText = children.some(node => node.nodeType === 3 && node.nodeValue.trim().length > 0);
      if (hasDirectText) {
        const txt = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        if (txt.length > 2) {
          const inCommentsSec = commentsSection && commentsSection !== postContainer && commentsSection.contains(el);
          const inLinkOrBtn = !!(el.closest('a') || el.closest('button'));
          const inUI = isInsideCommentOrUI(el);
          const isNoise = isNoiseText(el);
          
          childList.push(`- [${el.tagName}] class="${el.className}" text="${txt.substring(0, 50)}" (inCommentsSec: ${inCommentsSec}, inLinkOrBtn: ${inLinkOrBtn}, inUI: ${inUI}, isNoise: ${isNoise})`);
          count++;
          if (count >= 30) break;
        }
      }
    }
    diagnostics += `\n${childList.length > 0 ? childList.join('\n') : 'None found'}`;
  }

  return {
    postText: isReply ? parentCommentText : mainPostText,
    imageUrl: imageUrl,
    isReply: isReply,
    mainPostText: isReply ? mainPostText : '',
    userTypedText: userTypedText,
    diagnostics: diagnostics
  };
}

// Injects the comment text into LinkedIn's contenteditable editor
function injectComment(editor, commentText) {
  if (!editor) return;

  // LinkedIn's editor is Quill rich text editor, which uses paragraphs
  editor.innerHTML = `<p>${commentText}</p>`;
  editor.focus();

  // Dispatch events to notify LinkedIn's React framework of the input change
  // This enables the native "Post" button
  const inputEvent = new Event('input', { bubbles: true });
  editor.dispatchEvent(inputEvent);

  const changeEvent = new Event('change', { bubbles: true });
  editor.dispatchEvent(changeEvent);

  const keyupEvent = new KeyboardEvent('keyup', { bubbles: true, key: ' ' });
  editor.dispatchEvent(keyupEvent);

  // Position the cursor at the end of the text
  try {
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(editor);
    range.collapse(false); // false means collapse to end
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) {
    console.error('LinkedIn AI: Error setting focus range', e);
  }
}

// Renders the skeleton loading shimmer in the suggestions panel
function renderLoadingState(panelWrapper) {
  // Set HTML payload displaying custom smiley SVG and shimmer loading bars
  panelWrapper.innerHTML = `
    <div class="ln-ai-suggestions-panel">
      <div class="ln-ai-panel-header">
        <div class="ln-ai-header-title">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-3.5-9c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm7 0c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8s-1.5 8.67-1.5 1.5.67 1.5 1.5 1.5zm-5 5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/></svg>
          <span>Generating precise AI comments...</span>
        </div>
        <button class="ln-ai-close-btn" title="Close">&times;</button>
      </div>
      <div class="ln-ai-suggestions-list">
        <div class="ln-ai-skeleton-card">
          <div class="ln-ai-shimmer ln-ai-shimmer-line-long"></div>
          <div class="ln-ai-shimmer ln-ai-shimmer-line-med"></div>
          <div class="ln-ai-shimmer ln-ai-shimmer-line-short"></div>
        </div>
        <div class="ln-ai-skeleton-card">
          <div class="ln-ai-shimmer ln-ai-shimmer-line-long"></div>
          <div class="ln-ai-shimmer ln-ai-shimmer-line-med"></div>
          <div class="ln-ai-shimmer ln-ai-shimmer-line-short"></div>
        </div>
      </div>
    </div>
  `;

  // Attach close click listener
  const closeBtn = panelWrapper.querySelector('.ln-ai-close-btn');
  closeBtn.addEventListener('click', () => {
    panelWrapper.style.display = 'none';
  });
}

// Renders the API key setup warning
function renderApiKeyWarning(panelWrapper) {
  // Set HTML payload alerting missing API key configurations
  panelWrapper.innerHTML = `
    <div class="ln-ai-suggestions-panel">
      <div class="ln-ai-panel-header">
        <div class="ln-ai-header-title">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-3.5-9c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm7 0c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8s-1.5 8.67-1.5 1.5.67 1.5 1.5 1.5zm-5 5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/></svg>
          <span>API Key Required</span>
        </div>
        <button class="ln-ai-close-btn" title="Close">&times;</button>
      </div>
      <div class="ln-ai-warning-box">
        <div class="ln-ai-warning-title">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
            <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
          </svg>
          Missing API Keys
        </div>
        <p class="ln-ai-warning-text" style="color: #ef4444 !important; font-weight: 500; margin-top: 8px;">Please add your <code>GEMINI_API_KEY</code> or <code>GROQ_API_KEY</code> to the local <code>config.env</code> file inside the extension folder to start generating comments.</p>
        <button class="ln-ai-warning-btn">Open Settings Page</button>
      </div>
    </div>
  `;

  // Attach close click listener
  const closeBtn = panelWrapper.querySelector('.ln-ai-close-btn');
  closeBtn.addEventListener('click', () => {
    panelWrapper.style.display = 'none';
  });

  // Attach click listener to navigate to settings/options page
  const settingsBtn = panelWrapper.querySelector('.ln-ai-warning-btn');
  settingsBtn.addEventListener('click', () => {
    // Check if extension context is valid before messaging
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage({ action: 'OPEN_OPTIONS' });
      } catch (err) {
        alert('Extension context was invalidated. Please refresh the webpage.');
      }
    } else {
      alert('Extension context invalidated. Please reload the webpage.');
    }
  });
}

// Renders an error message in the suggestions panel
function renderError(panelWrapper, message) {
  // Set HTML payload displaying custom error details
  panelWrapper.innerHTML = `
    <div class="ln-ai-suggestions-panel">
      <div class="ln-ai-panel-header">
        <div class="ln-ai-header-title">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-3.5-9c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm7 0c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8s-1.5 8.67-1.5 1.5.67 1.5 1.5 1.5zm-5 5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/></svg>
          <span>Generation Error</span>
        </div>
        <button class="ln-ai-close-btn" title="Close">&times;</button>
      </div>
      <div class="ln-ai-warning-box" style="background-color: rgba(239, 68, 68, 0.08); border-color: rgba(239, 68, 68, 0.3);">
        <div class="ln-ai-warning-title" style="color: #ef4444;">
          Error Generating Suggestions
        </div>
        <p class="ln-ai-warning-text" style="color: #ef4444 !important; white-space: pre-wrap; text-align: left; font-family: monospace; font-size: 11px; line-height: 1.4; max-height: 200px; overflow-y: auto; background: rgba(0,0,0,0.03); padding: 8px; border-radius: 6px; margin: 8px 0; border: 1px dashed rgba(239, 68, 68, 0.2);">${message}</p>
      </div>
    </div>
  `;

  // Attach close click listener
  const closeBtn = panelWrapper.querySelector('.ln-ai-close-btn');
  closeBtn.addEventListener('click', () => {
    panelWrapper.style.display = 'none';
  });
}

// Renders suggestions list in the suggestions panel
function renderSuggestions(panelWrapper, suggestions, editor) {
  // Set HTML template containing suggestion cards for the three tones: insightful, appreciative, inquisitive
  panelWrapper.innerHTML = `
    <div class="ln-ai-suggestions-panel">
      <div class="ln-ai-panel-header">
        <div class="ln-ai-header-title">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-3.5-9c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm7 0c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8s-1.5 8.67-1.5 1.5.67 1.5 1.5 1.5zm-5 5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/></svg>
          <span>Suggested Comments (Click to Use)</span>
        </div>
        <button class="ln-ai-close-btn" title="Close">&times;</button>
      </div>
      <div class="ln-ai-suggestions-list">
        <div class="ln-ai-suggestion-card" data-type="insightful">
          <div class="ln-ai-suggestion-text"></div>
          <div class="ln-ai-card-footer">
            <span class="ln-ai-tone-label insightful">Insightful</span>
            <div class="ln-ai-card-actions">
              <button class="ln-ai-icon-btn copy-btn" title="Copy to clipboard">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
              <button class="ln-ai-action-btn use-btn">Use</button>
            </div>
          </div>
        </div>

        <div class="ln-ai-suggestion-card" data-type="appreciative">
          <div class="ln-ai-suggestion-text"></div>
          <div class="ln-ai-card-footer">
            <span class="ln-ai-tone-label appreciative">Appreciative</span>
            <div class="ln-ai-card-actions">
              <button class="ln-ai-icon-btn copy-btn" title="Copy to clipboard">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
              <button class="ln-ai-action-btn use-btn">Use</button>
            </div>
          </div>
        </div>

        <div class="ln-ai-suggestion-card" data-type="inquisitive">
          <div class="ln-ai-suggestion-text"></div>
          <div class="ln-ai-card-footer">
            <span class="ln-ai-tone-label inquisitive">Inquisitive</span>
            <div class="ln-ai-card-actions">
              <button class="ln-ai-icon-btn copy-btn" title="Copy to clipboard">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
              <button class="ln-ai-action-btn use-btn">Use</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Safely insert texts to prevent injection vulnerabilities (XSS attacks)
  panelWrapper.querySelector('.ln-ai-suggestion-card[data-type="insightful"] .ln-ai-suggestion-text').textContent = suggestions.insightful;
  panelWrapper.querySelector('.ln-ai-suggestion-card[data-type="appreciative"] .ln-ai-suggestion-text').textContent = suggestions.appreciative;
  panelWrapper.querySelector('.ln-ai-suggestion-card[data-type="inquisitive"] .ln-ai-suggestion-text').textContent = suggestions.inquisitive;

  // Attach event handlers to cards and buttons
  const cards = panelWrapper.querySelectorAll('.ln-ai-suggestion-card');
  cards.forEach(card => {
    const type = card.getAttribute('data-type');
    const commentText = suggestions[type];

    // Clicking the card body inserts it directly
    card.addEventListener('click', (e) => {
      // Don't trigger if clicked copy or use button directly (we handle those below)
      if (e.target.closest('.copy-btn') || e.target.closest('.use-btn')) return;
      chrome.runtime.sendMessage({ action: 'TRACK_ANALYTICS', tone: type }).catch(() => {});
      injectComment(editor, commentText);
      panelWrapper.style.display = 'none';
      // Show regenerate button for this tone/style
      const commentBox = editor.closest('.comments-comment-box, .comments-comment-box__form-container, .comments-comment-box__input-container, form, .comments-comment-item__reply-form, .comments-reply-box') || editor.parentElement;
      showRegenerateBtn(commentBox, type);
    });

    // Use button action handler
    const useBtn = card.querySelector('.use-btn');
    useBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'TRACK_ANALYTICS', tone: type }).catch(() => {});
      injectComment(editor, commentText);
      panelWrapper.style.display = 'none';
      // Show regenerate button for this tone/style
      const commentBox = editor.closest('.comments-comment-box, .comments-comment-box__form-container, .comments-comment-box__input-container, form, .comments-comment-item__reply-form, .comments-reply-box') || editor.parentElement;
      showRegenerateBtn(commentBox, type);
    });

    // Copy to clipboard action handler
    const copyBtn = card.querySelector('.copy-btn');
    copyBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'TRACK_ANALYTICS', tone: type }).catch(() => {});
      navigator.clipboard.writeText(commentText).then(() => {
        const svg = copyBtn.querySelector('svg');
        const origContent = copyBtn.innerHTML;
        // Temporary feedback checkmark styling to confirm copy
        copyBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        `;
        // Restore standard copy icon after 1.5 seconds
        setTimeout(() => {
          copyBtn.innerHTML = origContent;
        }, 1500);
      });
    });
  });

  // Attach close click listener
  const closeBtn = panelWrapper.querySelector('.ln-ai-close-btn');
  closeBtn.addEventListener('click', () => {
    panelWrapper.style.display = 'none';
  });
}

// Injects the AI Smile button and suggestions panel elements

// ─── Regenerate Button Helpers ───────────────────────────────────────────────

/**
 * Shows (or creates) a Regenerate button below the comment box.
 * At click-time it re-resolves the live editor so stale DOM references are never used.
 * @param {HTMLElement} commentBox - The comment box container.
 * @param {string} style - The tone/style to regenerate (e.g. "funny", "insightful").
 * @param {string} [userContext] - Any extra user-typed text before the slash command.
 */
function showRegenerateBtn(commentBox, style, userContext = '') {
  // Remove any existing regenerate button first
  removeRegenerateBtn(commentBox);

  const btn = document.createElement('button');
  btn.className = 'ln-ai-regen-btn';
  btn.setAttribute('data-ln-ai-regen', 'true');
  btn.innerHTML = `🔁 Regenerate`;
  btn.title = 'Generate a different comment for this post';

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Re-resolve the LIVE editor at click-time (avoids stale DOM reference)
    const liveEditor = commentBox.querySelector('.ql-editor[contenteditable="true"], div[contenteditable="true"], div[role="textbox"]');
    if (!liveEditor) {
      console.warn('[LinkedIn AI] Regenerate: Could not find live editor.');
      return;
    }

    btn.disabled = true;
    btn.innerHTML = `⏳ Regenerating...`;

    // Extract post content — do NOT touch the editor before this!
    let postContent;
    try {
      postContent = extractPostContent(commentBox);
    } catch (err) {
      console.error('[LinkedIn AI] Regenerate: extraction error', err);
      btn.disabled = false;
      btn.innerHTML = `🔁 Regenerate`;
      return;
    }

    // NOTE: Do NOT inject a loading message into the editor here.
    // Injecting text fires an 'input' event which LinkedIn intercepts and clears the editor!
    // The loading state is shown on the button only.

    chrome.runtime.sendMessage({
      action: 'GENERATE_SINGLE_COMMENT',
      style: style,
      userContext: userContext,
      postText: postContent.postText,
      imageUrl: postContent.imageUrl,
      isReply: postContent.isReply,
      mainPostText: postContent.mainPostText
    }, (response) => {
      btn.disabled = false;
      btn.innerHTML = `🔁 Regenerate`;

      if (chrome.runtime.lastError) {
        console.error('[LinkedIn AI] Regenerate lastError:', chrome.runtime.lastError.message);
        return;
      }

      if (response && response.success && response.draft) {
        injectComment(liveEditor, response.draft);
      } else {
        console.error('[LinkedIn AI] Regenerate failed:', response?.error);
        // Show error text on button instead of touching the editor
        btn.innerHTML = `❌ Failed — try again`;
        setTimeout(() => { btn.innerHTML = `🔁 Regenerate`; }, 2500);
      }
    });
  });

  // Always inject into our controlled ln-ai-action-row so it sits on the same line as the smile button
  const actionRow = commentBox.querySelector('[data-ln-ai-action-row="true"]');
  if (actionRow) {
    actionRow.appendChild(btn);
  } else {
    // Fallback: insert after the commentBox
    commentBox.appendChild(btn);
  }
}

/**
 * Removes any regenerate button attached after the given commentBox.
 */
function removeRegenerateBtn(commentBox) {
  // Primary: remove from our ln-ai-action-row
  const actionRow = commentBox.querySelector('[data-ln-ai-action-row="true"]');
  if (actionRow) {
    const existing = actionRow.querySelector('[data-ln-ai-regen="true"]');
    if (existing) existing.remove();
  }
  // Fallback: check anywhere inside commentBox
  const inner = commentBox.querySelector('[data-ln-ai-regen="true"]');
  if (inner) inner.remove();
}

// ─────────────────────────────────────────────────────────────────────────────

// Injects the AI Smile button and suggestions panel elements
function injectAIComponents(commentBox, editor, options = { isReplyMode: false }) {
  console.log('[LinkedIn AI] Injecting components into:', commentBox, 'isReplyMode:', options.isReplyMode);

  // 1. Create the AI Trigger button
  const triggerBtn = document.createElement('button');
  triggerBtn.type = 'button';
  
  if (options.isReplyMode) {
    triggerBtn.className = 'ln-ai-reply-trigger-btn';
    triggerBtn.innerHTML = `🗨️`;
    triggerBtn.title = "Generate AI Reply";
  } else {
    triggerBtn.className = 'ln-ai-trigger-btn';
    triggerBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-3.5-9c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm7 0c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8s-1.5 8.67-1.5 1.5.67 1.5 1.5 1.5zm-5 5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/>
      </svg>
    `;
    triggerBtn.title = "Generate AI Comment";
  }

  // 2. Create panel wrapper
  const panelWrapper = document.createElement('div');
  panelWrapper.className = 'ln-ai-panel-wrapper';
  
  // 1b. Create our own controlled action row that holds both the trigger btn and (later) the regen btn.
  //     This row is flex so we can push the regen btn to the right with margin-left:auto.
  const aiActionRow = document.createElement('div');
  aiActionRow.className = 'ln-ai-action-row';
  aiActionRow.setAttribute('data-ln-ai-action-row', 'true');
  aiActionRow.appendChild(triggerBtn);

  // Try to find LinkedIn's own actions bar to insert our row alongside it
  const linkedinActionBar = commentBox.querySelector(
    '.comments-comment-box__actions, .comments-comment-box__editor-actions, .comments-comment-box__form-action-bar'
  );
  if (linkedinActionBar) {
    // Insert our row right after LinkedIn's action bar
    linkedinActionBar.parentNode.insertBefore(aiActionRow, linkedinActionBar.nextSibling);
    console.log('[LinkedIn AI] Inserted ln-ai-action-row after LinkedIn action bar');
  } else if (editor && editor.parentNode) {
    // Fallback: insert after the editor
    editor.parentNode.insertBefore(aiActionRow, editor.nextSibling);
    console.log('[LinkedIn AI] Inserted ln-ai-action-row after editor');
  } else {
    commentBox.appendChild(aiActionRow);
    console.log('[LinkedIn AI] Appended ln-ai-action-row to commentBox (fallback)');
  }

  // Insert the panel wrapper right outside the commentBox (or fallback inside) to prevent overflow clipping
  const outerContainer = commentBox.closest('.comments-comment-box, form, .feed-shared-update-v2__comments-container') || commentBox;
  if (outerContainer && outerContainer.parentNode) {
    outerContainer.parentNode.insertBefore(panelWrapper, outerContainer.nextSibling);
    console.log('[LinkedIn AI] Injected suggestions panel wrapper outside outerContainer');
  } else {
    commentBox.appendChild(panelWrapper);
    console.log('[LinkedIn AI] Injected suggestions panel wrapper inside commentBox (fallback)');
  }

  // 3. Trigger button click listener
  triggerBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Toggle panel display if already open
    if (panelWrapper.style.display === 'block') {
      panelWrapper.style.display = 'none';
      return;
    }

    // Show panel and render loading screen
    panelWrapper.style.display = 'block';
    renderLoadingState(panelWrapper);

    // Extract the post/reply text and image
    const postContent = extractPostContent(commentBox, options.isReplyMode);
    const postText = postContent.postText;
    const imageUrl = postContent.imageUrl;
    const isReply = postContent.isReply || false;
    const mainPostText = postContent.mainPostText || '';
    const userTypedText = postContent.userTypedText || '';
    
    // If no text or image was resolved, throw a diagnostic warning
    if (!postText && !imageUrl) {
      const diagnosticMsg = `Could not find readable post content or image. Ensure the post is visible.\n\nDiagnostics Path:\n-> ${postContent.diagnostics}`;
      renderError(panelWrapper, diagnosticMsg);
      return;
    }

    console.log('[LinkedIn AI] Extracted content. isReply =', isReply, 'Length =', postText.length, 'Image URL =', imageUrl);

    // Verify that the extension context is still active.
    // chrome.runtime.id throws when the extension has been reloaded/uninstalled.
    if (!isContextValid()) {
      renderError(panelWrapper, 'Extension was reloaded. Please refresh this page (F5) to reconnect the AI assistant.');
      return;
    }

    try {
      // Send content to background worker
      chrome.runtime.sendMessage({
        action: 'GENERATE_SUGGESTIONS',
        postText: postText,
        imageUrl: imageUrl,
        isReply: isReply,
        mainPostText: mainPostText,
        userTypedText: userTypedText
      }, (response) => {
        // Check if context became invalidated during the network call
        if (typeof chrome === 'undefined' || !chrome.runtime) return;

        // Handle message delivery failures
        if (chrome.runtime.lastError) {
          console.error('[LinkedIn AI] Message error', chrome.runtime.lastError);
          renderError(panelWrapper, 'Failed to connect to the background helper script. Try reloading the page.');
          return;
        }

        // Check if background worker indicates a successful generation
        if (response && response.success) {
          renderSuggestions(panelWrapper, response.suggestions, editor);
        } else {
          const errMsg = response ? response.error : 'Unknown error';
          if (errMsg === 'NO_API_KEY') {
            renderApiKeyWarning(panelWrapper);
          } else {
            renderError(panelWrapper, errMsg || 'Failed to generate comments from Gemini API.');
          }
        }
      });
    } catch (err) {
      console.error('[LinkedIn AI] Extension context error:', err);
      renderError(panelWrapper, 'Extension context was invalidated because the extension was reloaded in Chrome. Please refresh this tab (F5 or Ctrl+F5) to reconnect the AI assistant.');
    }
  });
}

// Returns true if the extension context is still valid (not invalidated by a reload/update).
// Accessing chrome.runtime.id throws 'Extension context invalidated' when the context is dead.
function isContextValid() {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  } catch (e) {
    return false;
  }
}

// ─── Personal Style Learning ──────────────────────────────────────────────────

/**
 * Attaches style capture to a comment editor using two reliable signals:
 *
 *  1. INPUT TRACKING — listens to 'input' events on the editor and keeps
 *     a rolling `lastText` of what the user typed.
 *
 *  2. EDITOR-CLEAR DETECTION — watches the editor via MutationObserver.
 *     When LinkedIn posts a comment it clears the editor (innerHTML becomes
 *     empty / just a <br>). That transition is our signal to save lastText.
 *
 * This approach works regardless of LinkedIn's button class names, which
 * change with every frontend deploy.
 *
 * @param {HTMLElement} commentBox - The comment box container element.
 * @param {HTMLElement} editor     - The contenteditable editor element.
 */
function attachStyleCapture(commentBox, editor) {
  if (editor.getAttribute('data-ln-ai-style-bound') === 'true') return;
  editor.setAttribute('data-ln-ai-style-bound', 'true');

  // Rolling snapshot of what the user has typed in this editor
  let lastText = '';

  // ── 1. Track typed text via input events ─────────────────────────────────
  editor.addEventListener('input', () => {
    try {
      const raw = (editor.innerText || editor.textContent || '').trim();
      // Ignore zero-width chars and AI loading placeholders
      const text = raw.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
      if (text.length >= 15 && !text.startsWith('⏳') && !text.startsWith('❌')) {
        lastText = text;
      }
    } catch (_) {}
  });

  // ── 2. Detect editor clearing (post submitted) via MutationObserver ───────
  const editorObserver = new MutationObserver(() => {
    try {
      // Get current visible text, stripping zero-width chars
      const current = (editor.innerText || editor.textContent || '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

      // LinkedIn clears the editor to '' or just '\n' after posting
      const isCleared = current.length === 0 || current === '\n' || current === '\u00A0';

      if (isCleared && lastText && lastText.length >= 15) {
        console.log('[LinkedIn AI] Editor cleared after post — saving style sample:', lastText.substring(0, 60));
        if (isContextValid()) {
          chrome.runtime.sendMessage({
            action: 'SAVE_USER_COMMENT',
            text: lastText
          }).catch(() => {});
        }
        lastText = ''; // Reset so we don't double-save
      }
    } catch (err) {
      console.warn('[LinkedIn AI] Style capture observer error (non-fatal):', err);
    }
  });

  editorObserver.observe(editor, {
    childList: true,
    subtree: true,
    characterData: true
  });

  // ── 3. Also snapshot text on ANY button click near the comment box ─────────
  // This fires before the editor clears, giving us the text one more time.
  commentBox.addEventListener('click', (e) => {
    try {
      const el = e.target.closest('button');
      if (!el) return;
      const raw = (editor.innerText || editor.textContent || '').trim()
        .replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
      if (raw.length >= 15 && !raw.startsWith('⏳') && !raw.startsWith('❌')) {
        lastText = raw; // Refresh snapshot right before potential post
      }
    } catch (_) {}
  }, true); // Use capture phase so it fires before LinkedIn's own handlers
}

// ─────────────────────────────────────────────────────────────────────────────



// Attaches the slash command listener to a specific editor
function attachSlashCommandListener(editor, commentBox) {
  if (editor.getAttribute('data-ln-ai-slash-bound') === 'true') return;
  editor.setAttribute('data-ln-ai-slash-bound', 'true');

  editor.addEventListener('input', async (e) => {
    const text = editor.innerText || '';
    
    // Look for a trailing slash command followed by a space
    // e.g., "This is awesome! /funny " -> match[1] = "funny"
    const match = text.match(/\/([a-zA-Z0-9_-]+)\s$/);
    
    if (match) {
      const style = match[1];
      const userContext = text.slice(0, match.index).trim(); // "This is awesome!"

      // Prevent re-triggering while loading
      if (editor.getAttribute('data-ln-ai-loading') === 'true') return;
      editor.setAttribute('data-ln-ai-loading', 'true');

      // IMPORTANT: Extract post content FIRST before changing the editor text,
      // otherwise the loading indicator "⏳ Generating..." gets picked up as post context!
      let postContentData;
      try {
        postContentData = extractPostContent(commentBox);
      } catch(err) {
        editor.removeAttribute('data-ln-ai-loading');
        console.error('[LinkedIn AI] Failed to extract post content:', err);
        injectComment(editor, userContext);
        return;
      }

      const { postText, imageUrl, isReply, mainPostText } = postContentData;

      // Now it is safe to show the loading indicator
      injectComment(editor, `⏳ Generating /${style}...`);
      
      try {
        
        chrome.runtime.sendMessage({
          action: 'GENERATE_SINGLE_COMMENT',
          style: style,
          userContext: userContext,
          postText: postText,
          imageUrl: imageUrl,
          isReply: isReply,
          mainPostText: mainPostText
        }, (response) => {
          editor.removeAttribute('data-ln-ai-loading');
          if (response && response.success && response.draft) {
            injectComment(editor, response.draft);
            // Show regenerate button so the user can get a fresh variation
            showRegenerateBtn(commentBox, style, userContext);
          } else {
            console.error('[LinkedIn AI] Slash command error:', response?.error);
            // Revert on error
            injectComment(editor, userContext);
          }
        });
      } catch (err) {
        editor.removeAttribute('data-ln-ai-loading');
        console.error('[LinkedIn AI] Context error for slash command:', err);
        injectComment(editor, userContext);
      }
    }
  });
}



// Scans the DOM for un-processed comment editors
function scanAndInject() {
  // Find all active comment editor boxes (broad match for maximum compatibility)
  const editors = document.querySelectorAll('.ql-editor[contenteditable="true"], div[contenteditable="true"], div[role="textbox"]');
  
  if (editors.length > 0) {
    console.log(`[LinkedIn AI] Scan running. Found ${editors.length} potential editors.`);
  }

  editors.forEach(editor => {
    // Avoid injecting on elements that are not editors (e.g. read-only textboxes)
    if (editor.getAttribute('readonly') === 'true' || editor.getAttribute('aria-readonly') === 'true') {
      return;
    }

    // Resolve a container matching comment inputs
    let commentBox = editor.closest('.comments-comment-box, .comments-comment-box__form-container, .comments-comment-box__input-container, form, .comments-comment-item__reply-form, .comments-reply-box');
    if (!commentBox) {
      commentBox = editor.parentElement;
    }
    if (!commentBox) return;

    // Check if we've already injected AI buttons here to avoid duplicates
    if (commentBox.getAttribute('data-ln-ai-injected') === 'true' || editor.getAttribute('data-ln-ai-injected') === 'true') {
      return;
    }
    
    // To infallibly determine if this is a main post comment box vs a nested reply box,
    // we look for the placeholder text. Main post comment boxes ALWAYS have "Add a comment...".
    // Reply boxes usually say "Reply to Name...".
    let isMainPostCommentBox = false;
    
    // Check the editor itself
    const editorPlaceholder = (editor.getAttribute('data-placeholder') || editor.getAttribute('aria-label') || '').toLowerCase();
    if (editorPlaceholder.includes('add a comment')) {
      isMainPostCommentBox = true;
    }
    
    // Check children (LinkedIn sometimes puts the placeholder on a nested <p> tag)
    if (!isMainPostCommentBox) {
      const childPlaceholders = Array.from(editor.querySelectorAll('[data-placeholder], [aria-label]'));
      for (const el of childPlaceholders) {
        const text = (el.getAttribute('data-placeholder') || el.getAttribute('aria-label') || '').toLowerCase();
        if (text.includes('add a comment')) {
          isMainPostCommentBox = true;
          break;
        }
      }
    }
    
    // Check parent/ancestors up to the comment box
    if (!isMainPostCommentBox) {
      let curr = editor.parentElement;
      while (curr && curr !== commentBox.parentElement) {
        const text = (curr.getAttribute('data-placeholder') || curr.getAttribute('aria-label') || '').toLowerCase();
        if (text.includes('add a comment')) {
          isMainPostCommentBox = true;
          break;
        }
        curr = curr.parentElement;
      }
    }

    // Mark as injected
    commentBox.setAttribute('data-ln-ai-injected', 'true');
    editor.setAttribute('data-ln-ai-injected', 'true');

    if (isMainPostCommentBox) {
      // User requested: "remove the smile emoji for reply's just keep that for the post only"
      injectAIComponents(commentBox, editor, { isReplyMode: false });
    } else {
      // User requested: "made another button of reply which appears when i click on reply on someone's comment"
      injectAIComponents(commentBox, editor, { isReplyMode: true });
    }
    
    // Attach slash command listener for ALL editors
    attachSlashCommandListener(editor, commentBox);

    // Attach style capture listener for ALL editors (learn from user's own comments)
    attachStyleCapture(commentBox, editor);
  });
}

// Watch for DOM changes (scrolling, clicking Comment buttons, loading more posts)
// ─── Post Detection for Auto-Share ───────────────────────────────────────────
function detectPostSuccess(addedNodes) {
  for (const node of addedNodes) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      // Find toast messages
      const toasts = node.classList && node.classList.contains('artdeco-toast-item') 
        ? [node] 
        : Array.from(node.querySelectorAll('.artdeco-toast-item'));
        
      for (const toast of toasts) {
        const text = toast.innerText || '';
        if (text.toLowerCase().includes('post successful')) {
          const viewPostLink = toast.querySelector('a');
          if (viewPostLink && viewPostLink.href) {
            console.log('[LinkedIn AI] Detected new post created:', viewPostLink.href);
            // Send to background to trigger Auto-Share flow
            chrome.runtime.sendMessage({
              action: 'NEW_POST_DETECTED',
              url: viewPostLink.href
            }).catch(() => {});
          }
        }
      }
    }
  }
}

function initObserver() {
  console.log('[LinkedIn AI] Extension loaded. Initializing observer...');
  
  // Initial scan on page load
  scanAndInject();

  // ── Load Theme & Listen for Changes ───────────────────────
  try {
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
  } catch(e) {
    console.error("[LinkedIn AI] Error loading theme:", e);
  }

  // Set up MutationObserver to watch for additions to the DOM tree (dynamic scrolls)
  const observer = new MutationObserver((mutations) => {
    // Stop everything if the extension context was invalidated (e.g. extension reloaded)
    if (!isContextValid()) {
      console.log('[LinkedIn AI] Extension context invalidated — disconnecting observer.');
      observer.disconnect();
      clearInterval(periodicScanInterval);
      return;
    }
    let shouldScan = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes && mutation.addedNodes.length > 0) {
        shouldScan = true;
        // Check for "Post successful" toast
        detectPostSuccess(mutation.addedNodes);
      }
    }
    if (shouldScan) {
      scanAndInject();
    }
  });

  // Observe updates in the webpage body
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  
  // Robust Fallback 1: Force scan on user clicks (like clicking "Comment" or "Reply")
  document.addEventListener('click', () => {
    if (!isContextValid()) return;
    setTimeout(scanAndInject, 100);
    setTimeout(scanAndInject, 500);
    setTimeout(scanAndInject, 1000);
  });

  // Robust Fallback 2: Force scan on editor focus
  document.addEventListener('focusin', (e) => {
    if (!isContextValid()) return;
    if (e.target && e.target.getAttribute('contenteditable') === 'true') {
      scanAndInject();
    }
  });
  
  // Robust Fallback 3: Periodically scan every 3 seconds
  const periodicScanInterval = setInterval(() => {
    if (!isContextValid()) {
      console.log('[LinkedIn AI] Extension context invalidated — stopping periodic scan.');
      clearInterval(periodicScanInterval);
      return;
    }
    scanAndInject();
  }, 3000);
}


// Run the script initialization hooks
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initObserver);
} else {
  initObserver();
}

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    console.log('WebCompanion content script initialized.');

    let isPicking = false;
    let overlay: HTMLDivElement | null = null;
    let tooltip: HTMLDivElement | null = null;
    let lastHoveredElement: HTMLElement | null = null;

    // Helper to generate a clean CSS selector
    function getCssSelector(el: HTMLElement): string {
      if (el.id) {
        return `#${el.id}`;
      }
      const path: string[] = [];
      let current: HTMLElement | null = el;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        let selector = current.nodeName.toLowerCase();
        if (current.className && typeof current.className === 'string') {
          const classes = current.className
            .trim()
            .split(/\s+/)
            .filter(c => c && !c.startsWith('webcompanion-'))
            .join('.');
          if (classes) {
            selector += `.${classes}`;
          }
        }
        
        let sibling = current.previousElementSibling;
        let nth = 1;
        while (sibling) {
          if (sibling.nodeName === current.nodeName) nth++;
          sibling = sibling.previousElementSibling;
        }
        
        let nextSibling = current.nextElementSibling;
        let hasSameSibling = false;
        while (nextSibling) {
          if (nextSibling.nodeName === current.nodeName) {
            hasSameSibling = true;
            break;
          }
          nextSibling = nextSibling.nextElementSibling;
        }
        
        if (nth > 1 || hasSameSibling) {
          selector += `:nth-of-type(${nth})`;
        }

        path.unshift(selector);
        current = current.parentElement;
        if (current && (current.tagName === 'BODY' || current.tagName === 'HTML')) {
          break;
        }
      }
      return path.join(' > ');
    }

    // Initialize overlay and tooltip elements
    function createUI() {
      if (overlay) return;

      overlay = document.createElement('div');
      overlay.id = 'webcompanion-picker-overlay';
      Object.assign(overlay.style, {
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: '2147483647',
        backgroundColor: 'rgba(37, 99, 235, 0.12)',
        border: '2px solid #2563eb',
        borderRadius: '4px',
        boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.4)',
        transition: 'all 0.08s cubic-bezier(0.25, 0.8, 0.25, 1)',
        display: 'none',
      });

      tooltip = document.createElement('div');
      tooltip.id = 'webcompanion-picker-tooltip';
      Object.assign(tooltip.style, {
        position: 'fixed',
        zIndex: '2147483647',
        pointerEvents: 'none',
        backgroundColor: '#2563eb',
        color: '#ffffff',
        padding: '4px 8px',
        fontSize: '11px',
        fontWeight: '600',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        borderRadius: '4px',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.16)',
        whiteSpace: 'nowrap',
        display: 'none',
        transition: 'all 0.08s cubic-bezier(0.25, 0.8, 0.25, 1)',
      });

      document.body.appendChild(overlay);
      document.body.appendChild(tooltip);
    }

    // Cleanup UI and listeners
    function cleanup() {
      isPicking = false;
      lastHoveredElement = null;

      if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
      if (tooltip && tooltip.parentNode) {
        tooltip.parentNode.removeChild(tooltip);
      }
      overlay = null;
      tooltip = null;

      document.removeEventListener('mouseover', handleMouseOver, true);
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    }

    // Track mouse movement to highlight elements
    function handleMouseOver(e: MouseEvent) {
      if (!isPicking || !overlay || !tooltip) return;

      const target = e.target as HTMLElement;
      if (!target || target === document.body || target === document.documentElement) {
        return;
      }

      // Skip our own overlay and tooltip
      if (target.id === 'webcompanion-picker-overlay' || target.id === 'webcompanion-picker-tooltip') {
        return;
      }

      lastHoveredElement = target;
      const rect = target.getBoundingClientRect();

      // Update overlay dimensions and position
      overlay.style.top = `${rect.top}px`;
      overlay.style.left = `${rect.left}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      overlay.style.display = 'block';

      // Position tooltip
      let tooltipTop = rect.top - 28;
      if (tooltipTop < 5) {
        tooltipTop = rect.bottom + 8;
      }
      let tooltipLeft = rect.left;
      if (tooltipLeft + 180 > window.innerWidth) {
        tooltipLeft = window.innerWidth - 190;
      }

      tooltip.style.top = `${tooltipTop}px`;
      tooltip.style.left = `${Math.max(5, tooltipLeft)}px`;
      tooltip.style.display = 'block';

      // Set tooltip label
      const tagName = target.tagName.toLowerCase();
      let classString = '';
      if (target.className && typeof target.className === 'string') {
        classString = target.className
          .trim()
          .split(/\s+/)
          .filter(c => c && !c.startsWith('webcompanion-'))
          .map(c => `.${c}`)
          .join('')
          .slice(0, 25);
      }
      tooltip.textContent = `${tagName}${classString} (${Math.round(rect.width)} × ${Math.round(rect.height)})`;
    }

    // Capture element click selection
    function handleClick(e: MouseEvent) {
      if (!isPicking || !lastHoveredElement) return;

      e.preventDefault();
      e.stopPropagation();

      const target = lastHoveredElement;
      const selector = getCssSelector(target);
      const text = (target.innerText || target.textContent || '').trim();

      // Send result back to extension runtime
      try {
        browser.runtime.sendMessage({
          type: 'ELEMENT_PICKED_RESULT',
          selector,
          text: text.slice(0, 600), // reasonably long snippet
        });
      } catch (err) {
        console.error('Error sending message back to WebCompanion:', err);
      }

      cleanup();
    }

    // Cancel selection on Escape
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        try {
          browser.runtime.sendMessage({
            type: 'ELEMENT_PICKED_CANCEL',
          });
        } catch (err) {
          console.error('Error sending cancel message to WebCompanion:', err);
        }
        cleanup();
      }
    }

    // Start picker mode
    function startPicking() {
      if (isPicking) return;
      isPicking = true;

      createUI();

      // Capture phase listeners to prevent page-native actions
      document.addEventListener('mouseover', handleMouseOver, true);
      document.addEventListener('click', handleClick, true,);
      document.addEventListener('keydown', handleKeyDown, true);
    }

    // Listen for events from sidepanel
    browser.runtime.onMessage.addListener((message) => {
      if (message.type === 'START_ELEMENT_PICKER') {
        startPicking();
      } else if (message.type === 'CANCEL_PICKER') {
        cleanup();
      }
      return true;
    });
  },
});

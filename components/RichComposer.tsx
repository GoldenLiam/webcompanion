import React, { forwardRef, useImperativeHandle, useRef, useState, useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Mention from '@tiptap/extension-mention';

// Define Custom Mention Tab Node
export const MentionTab = Mention.extend({
  name: 'mentionTab',
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-id'),
        renderHTML: (attributes) => {
          if (!attributes.id) return {};
          return { 'data-id': attributes.id };
        },
      },
      label: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-label'),
        renderHTML: (attributes) => {
          if (!attributes.label) return {};
          return { 'data-label': attributes.label };
        },
      },
      url: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-url'),
        renderHTML: (attributes) => {
          if (!attributes.url) return {};
          return { 'data-url': attributes.url };
        },
      },
    };
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      {
        ...this.options.HTMLAttributes,
        'data-id': node.attrs.id,
        'data-label': node.attrs.label,
        'data-url': node.attrs.url,
        class: 'mention-tab-pill',
      },
      `@${node.attrs.label || 'Tab'}`,
    ];
  },
});

// Define Custom Mention Element Node (No suggestion popup, inserted programmatically)
export const MentionElement = Mention.extend({
  name: 'mentionElement',
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-id'),
        renderHTML: (attributes) => {
          if (!attributes.id) return {};
          return { 'data-id': attributes.id };
        },
      },
      label: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-label'),
        renderHTML: (attributes) => {
          if (!attributes.label) return {};
          return { 'data-label': attributes.label };
        },
      },
      selector: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-selector'),
        renderHTML: (attributes) => {
          if (!attributes.selector) return {};
          return { 'data-selector': attributes.selector };
        },
      },
      text: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-text'),
        renderHTML: (attributes) => {
          if (!attributes.text) return {};
          return { 'data-text': attributes.text };
        },
      },
    };
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      {
        ...this.options.HTMLAttributes,
        'data-id': node.attrs.id,
        'data-label': node.attrs.label,
        'data-selector': node.attrs.selector,
        'data-text': node.attrs.text,
        class: 'mention-element-pill',
      },
      `#${node.attrs.label || 'Phần tử'}`,
    ];
  },
});

interface RichComposerProps {
  tabsList: any[];
  onSubmit: (prompt: string) => void;
  onTextChange?: (text: string) => void;
}

export interface RichComposerRef {
  insertTab: (tab: { id: number | string; title: string; url: string }) => void;
  insertElement: (element: { selector: string; text: string }) => void;
  insertText: (text: string) => void;
  getFinalPrompt: () => string;
  clear: () => void;
  focus: () => void;
  isEmpty: () => boolean;
}

export const RichComposer = forwardRef<RichComposerRef, RichComposerProps>(
  ({ tabsList, onSubmit, onTextChange }, ref) => {
    const tabsListRef = useRef(tabsList);
    const [dropdown, setDropdown] = useState<{
      visible: boolean;
      x: number;
      y: number;
      items: any[];
      index: number;
    } | null>(null);

    // Sync tabsList prop to ref to avoid stale closures in Tiptap's static configurations
    useEffect(() => {
      tabsListRef.current = tabsList;
    }, [tabsList]);

    // Ref for tracking dropdown details in keyboard event handlers without stale closures
    const suggestionRef = useRef<{
      items: any[];
      index: number;
      command: ((props: any) => void) | null;
    }>({ items: [], index: 0, command: null });

    const editor = useEditor({
      extensions: [
        StarterKit,
        Placeholder.configure({
          placeholder: 'Mô tả điều bạn muốn và AI sẽ làm cho bạn',
        }),
        MentionTab.configure({
          suggestion: {
            char: '@',
            items: ({ query }) => {
              const lowercaseQuery = query.toLowerCase();
              return tabsListRef.current
                .filter((tab) => {
                  const title = tab.title || '';
                  const url = tab.url || '';
                  return (
                    title.toLowerCase().includes(lowercaseQuery) ||
                    url.toLowerCase().includes(lowercaseQuery)
                  );
                })
                .slice(0, 8);
            },
            render: () => {
              return {
                onStart: (props) => {
                  suggestionRef.current = {
                    items: props.items,
                    index: 0,
                    command: props.command,
                  };

                  const rect = props.clientRect?.();
                  if (rect) {
                    setDropdown({
                      visible: true,
                      x: rect.left,
                      y: rect.bottom + window.scrollY,
                      items: props.items,
                      index: 0,
                    });
                  }
                },
                onUpdate: (props) => {
                  suggestionRef.current = {
                    ...suggestionRef.current,
                    items: props.items,
                    index: Math.min(suggestionRef.current.index, props.items.length - 1),
                  };

                  const rect = props.clientRect?.();
                  setDropdown((prev) => {
                    if (!prev) return null;
                    return {
                      ...prev,
                      items: props.items,
                      index: suggestionRef.current.index,
                      ...(rect ? { x: rect.left, y: rect.bottom + window.scrollY } : {}),
                    };
                  });
                },
                onKeyDown: (props) => {
                  const { event } = props;
                  const { items, index, command } = suggestionRef.current;
                  if (!items || items.length === 0) return false;

                  if (event.key === 'ArrowUp') {
                    const nextIndex = (index - 1 + items.length) % items.length;
                    suggestionRef.current.index = nextIndex;
                    setDropdown((prev) => (prev ? { ...prev, index: nextIndex } : null));
                    return true;
                  }
                  if (event.key === 'ArrowDown') {
                    const nextIndex = (index + 1) % items.length;
                    suggestionRef.current.index = nextIndex;
                    setDropdown((prev) => (prev ? { ...prev, index: nextIndex } : null));
                    return true;
                  }
                  if (event.key === 'Enter') {
                    const selectedItem = items[index];
                    if (selectedItem && command) {
                      command({
                        id: selectedItem.id,
                        label: selectedItem.title || selectedItem.label,
                        url: selectedItem.url,
                      });
                    }
                    return true;
                  }
                  if (event.key === 'Escape') {
                    setDropdown(null);
                    return true;
                  }
                  return false;
                },
                onExit: () => {
                  suggestionRef.current = { items: [], index: 0, command: null };
                  setDropdown(null);
                },
              };
            },
          },
        }),
        MentionElement, // Register node structure without suggestion triggers
      ],
      editorProps: {
        attributes: {
          class: 'webcompanion-rich-input-editor',
        },
        handleKeyDown: (view, event) => {
          // If dropdown suggestion is open, let the suggestion plugin handle keyboard events
          if (suggestionRef.current.items.length > 0) {
            return false;
          }

          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            const prompt = getFinalPrompt();
            if (prompt.trim()) {
              onSubmit(prompt);
            }
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor }) => {
        if (onTextChange) {
          onTextChange(editor.getText());
        }
      },
    });

    // Clean up dropdown when component unmounts
    useEffect(() => {
      return () => {
        setDropdown(null);
      };
    }, []);

    const getFinalPrompt = () => {
      if (!editor) return '';
      let promptText = '';
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'paragraph') {
          if (promptText && !promptText.endsWith('\n')) {
            promptText += '\n';
          }
        }
        if (node.isText) {
          promptText += node.text;
        } else if (node.type.name === 'mentionTab') {
          const { label, url } = node.attrs;
          promptText += `[Tab đính kèm: "${label}" | Link: ${url}]`;
        } else if (node.type.name === 'mentionElement') {
          const { label, selector, text } = node.attrs;
          promptText += `[Phần tử được chọn | Selector: "${selector}" | Nội dung chữ: "${text}"]`;
        } else if (node.type.name === 'hardBreak') {
          promptText += '\n';
        }
      });
      return promptText;
    };

    useImperativeHandle(ref, () => ({
      insertTab: (tab) => {
        if (!editor) return;
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'mentionTab',
            attrs: {
              id: tab.id,
              label: tab.title,
              url: tab.url,
            },
          })
          .insertContent(' ')
          .run();
      },
      insertElement: (element) => {
        if (!editor) return;
        const selectorClean = element.selector;
        const labelText = selectorClean.length > 15
          ? selectorClean.substring(0, 15) + '...'
          : selectorClean;
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'mentionElement',
            attrs: {
              id: `elem-${Date.now()}`,
              label: labelText,
              selector: element.selector,
              text: element.text,
            },
          })
          .insertContent(' ')
          .run();
      },
      insertText: (text) => {
        if (!editor) return;
        editor.chain().focus().insertContent(text).run();
      },
      getFinalPrompt,
      clear: () => {
        if (!editor) return;
        editor.commands.clearContent(true);
      },
      focus: () => {
        if (!editor) return;
        editor.commands.focus();
      },
      isEmpty: () => {
        if (!editor) return true;
        return editor.isEmpty;
      },
    }));

    return (
      <div className="webcompanion-rich-input-wrapper">
        <EditorContent editor={editor} className="webcompanion-rich-input" />

        {dropdown && dropdown.visible && (
          <div
            className="webcompanion-mention-dropdown"
            style={{
              position: 'fixed',
              left: dropdown.x,
              top: dropdown.y,
              zIndex: 2147483647,
            }}
          >
            {dropdown.items.length === 0 ? (
              <div className="webcompanion-mention-empty">Không tìm thấy tab nào</div>
            ) : (
              dropdown.items.map((item, idx) => (
                <div
                  key={item.id}
                  className={`webcompanion-mention-item ${idx === dropdown.index ? 'active' : ''
                    }`}
                  onClick={() => {
                    if (suggestionRef.current.command) {
                      suggestionRef.current.command({
                        id: item.id,
                        label: item.title || item.label,
                        url: item.url,
                      });
                    }
                  }}
                >
                  {item.favIconUrl ? (
                    <img src={item.favIconUrl} className="mention-item-favicon" alt="" />
                  ) : (
                    <span className="mention-item-icon-fallback">🌐</span>
                  )}
                  <span className="mention-item-title">{item.title || item.label}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    );
  }
);

RichComposer.displayName = 'RichComposer';

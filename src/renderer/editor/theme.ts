import type { ThemeRegistration } from 'shiki/core';

export const DEFAULT_FG = 'var(--editor-fg)';

// Code colors: the theme's --syn-* tokens (theme.css), so a theme switch needs no new highlight; the workspace background.
export const atelierTheme: ThemeRegistration = {
  name: 'atelier', type: 'dark',
  colors: { 'editor.background': 'var(--bg-2)', 'editor.foreground': DEFAULT_FG },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: 'var(--syn-comment)', fontStyle: 'italic' } },
    { scope: ['keyword', 'storage', 'storage.type', 'keyword.operator.new', 'keyword.control', 'variable.language.this', 'constant.language.boolean', 'constant.language.null', 'constant.language.undefined'], settings: { foreground: 'var(--syn-keyword)' } },
    { scope: ['keyword.operator'], settings: { foreground: 'var(--syn-operator)' } },
    { scope: ['string', 'string.template', 'punctuation.definition.string', 'markup.inline.raw'], settings: { foreground: 'var(--syn-string)' } },
    { scope: ['constant.numeric', 'constant.other', 'constant.character.escape'], settings: { foreground: 'var(--syn-number)' } },
    { scope: ['entity.name.type', 'support.type', 'support.class', 'entity.name.class', 'entity.other.inherited-class', 'storage.type.primitive'], settings: { foreground: 'var(--syn-type)' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function'], settings: { foreground: 'var(--syn-function)' } },
    { scope: ['entity.name.tag', 'support.class.component'], settings: { foreground: 'var(--syn-tag)' } },
    { scope: ['entity.other.attribute-name', 'support.type.property-name', 'meta.object-literal.key'], settings: { foreground: 'var(--syn-key)' } },
    { scope: ['variable.parameter'], settings: { foreground: 'var(--syn-variable)' } },
    { scope: ['punctuation', 'meta.brace', 'punctuation.separator', 'punctuation.terminator'], settings: { foreground: 'var(--syn-punct)' } },
    { scope: ['markup.heading', 'entity.name.section'], settings: { foreground: 'var(--syn-heading)', fontStyle: 'bold' } },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    { scope: ['markup.underline.link', 'string.other.link'], settings: { foreground: 'var(--syn-link)' } },
    { scope: ['markup.inserted'], settings: { foreground: 'var(--syn-inserted)' } },
    { scope: ['markup.deleted'], settings: { foreground: 'var(--syn-deleted)' } },
    { scope: ['variable.other.env', 'variable.other.readwrite.shell', 'variable.other.normal.shell'], settings: { foreground: 'var(--syn-variable)' } }
  ]
};

import type { LanguageRegistration } from 'shiki/core';

// Gosu (Guidewire's JVM language) has no grammar in Shiki: this one covers what its classes, enhancements and programs
// use. Contextual words (get/set, index/iterator) are keywords only where Gosu reads them so, never as plain names.
const ID = '[A-Za-z_$][\\w$]*';
const QUALIFIED = `(?:${ID}\\.)*${ID}`;
const PRIMITIVES = 'boolean|byte|char|short|int|long|float|double|void';

const gosu: LanguageRegistration = {
  name: 'gosu',
  displayName: 'Gosu',
  scopeName: 'source.gosu',
  fileTypes: ['gs', 'gsx', 'gsp'],
  patterns: [{ include: '#code' }],
  repository: {
    code: {
      patterns: [
        { include: '#comments' }, { include: '#strings' }, { include: '#annotations' }, { include: '#declarations' },
        { include: '#types' }, { include: '#keywords' }, { include: '#numbers' }, { include: '#operators' },
        { include: '#calls' }, { include: '#braces' }, { match: '[;,.()\\[\\]]', name: 'punctuation.separator.gosu' }
      ]
    },
    comments: {
      patterns: [
        { begin: '/\\*', end: '\\*/', name: 'comment.block.gosu' },
        { begin: '//', end: '$', name: 'comment.line.double-slash.gosu' }
      ]
    },
    strings: {
      patterns: [
        {
          // Only the literal parts are string-scoped, so ${…} reads as code again.
          begin: '"', end: '"',
          beginCaptures: { 0: { name: 'string.quoted.double.gosu punctuation.definition.string.begin.gosu' } },
          endCaptures: { 0: { name: 'string.quoted.double.gosu punctuation.definition.string.end.gosu' } },
          patterns: [
            { match: '\\\\.', name: 'string.quoted.double.gosu constant.character.escape.gosu' },
            {
              begin: '\\$\\{', end: '\\}',
              beginCaptures: { 0: { name: 'punctuation.definition.template-expression.begin.gosu' } },
              endCaptures: { 0: { name: 'punctuation.definition.template-expression.end.gosu' } },
              name: 'meta.template.expression.gosu',
              patterns: [{ include: '#code' }]
            },
            { match: '[^"\\\\$]+|\\$', name: 'string.quoted.double.gosu' }
          ]
        },
        {
          begin: "'", end: "'", name: 'string.quoted.single.gosu',
          patterns: [{ match: '\\\\.', name: 'constant.character.escape.gosu' }]
        }
      ]
    },
    annotations: {
      match: `@${QUALIFIED}`, name: 'storage.type.annotation.gosu'
    },
    declarations: {
      patterns: [
        {
          match: `\\b(class|interface|enhancement|enum|structure)\\s+(${ID})`,
          captures: { 1: { name: 'storage.type.class.gosu' }, 2: { name: 'entity.name.type.class.gosu' } }
        },
        {
          begin: '\\b(extends|implements)\\b', end: '(?=[{;)>]|\\bimplements\\b)',
          beginCaptures: { 1: { name: 'storage.modifier.extends.gosu' } },
          patterns: [{ include: '#comments' }, { match: QUALIFIED, name: 'entity.other.inherited-class.gosu' }]
        },
        {
          match: `\\b(property)\\s+(get|set)\\s+(${ID})`,
          captures: {
            1: { name: 'storage.type.property.gosu' }, 2: { name: 'storage.type.property.gosu' },
            3: { name: 'entity.name.function.gosu' }
          }
        },
        {
          match: `\\b(function)\\s+(${ID})`,
          captures: { 1: { name: 'storage.type.function.gosu' }, 2: { name: 'entity.name.function.gosu' } }
        },
        { match: '\\b(package|uses)\\b', name: 'keyword.other.import.gosu' }
      ]
    },
    types: {
      patterns: [
        // `: Type` after a name, parameter or signature; only a type-looking name (capitalized or primitive), so a
        // ternary's `: value` stays a value.
        {
          match: `(:)\\s*((?:${ID}\\.)*(?:[A-Z][\\w$]*|(?:${PRIMITIVES})\\b))`,
          captures: { 1: { name: 'punctuation.separator.type.gosu' }, 2: { name: 'entity.name.type.gosu' } }
        },
        {
          match: `\\b(new)\\s+(${QUALIFIED})`,
          captures: { 1: { name: 'keyword.operator.new.gosu' }, 2: { name: 'entity.name.type.gosu' } }
        },
        {
          match: `\\b(typeis|typeas|as)\\s+(${QUALIFIED})`,
          captures: { 1: { name: 'keyword.other.type.gosu' }, 2: { name: 'entity.name.type.gosu' } }
        },
        { match: `\\b(?:${PRIMITIVES})\\b`, name: 'storage.type.primitive.gosu' }
      ]
    },
    keywords: {
      patterns: [
        {
          match: '\\b(?:if|else|for|foreach|while|do|switch|case|default|break|continue|return|try|catch|finally|throw|using|in|eval|assert)\\b',
          name: 'keyword.control.gosu'
        },
        { match: '\\b(?:index|iterator)\\b(?=\\s+[A-Za-z_$][\\w$]*\\s*\\))', name: 'keyword.control.gosu' },
        {
          match: '\\b(?:private|public|protected|internal|static|final|abstract|override|transient|readonly)\\b',
          name: 'storage.modifier.gosu'
        },
        { match: '\\b(?:var|construct|delegate|represents|block)\\b', name: 'storage.type.gosu' },
        { match: '\\b(?:and|or|not|typeis|typeas|as|typeof|statictypeof)\\b', name: 'keyword.other.gosu' },
        { match: '\\bnew\\b', name: 'keyword.operator.new.gosu' },
        { match: '\\b(?:true|false)\\b', name: 'constant.language.boolean.gosu' },
        { match: '\\bnull\\b', name: 'constant.language.null.gosu' },
        { match: '\\b(?:this|outer)\\b', name: 'variable.language.this.gosu' },
        { match: '\\bsuper\\b', name: 'keyword.other.super.gosu' }
      ]
    },
    numbers: {
      patterns: [
        { match: '\\b0[xX][0-9a-fA-F_]+[lLsSbB]?\\b', name: 'constant.numeric.hex.gosu' },
        { match: '\\b0[bB][01_]+[lLsSbB]?\\b', name: 'constant.numeric.binary.gosu' },
        { match: '\\b\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?(?:bd|bi|[dDfFlLsSbB])?\\b', name: 'constant.numeric.decimal.gosu' }
      ]
    },
    operators: {
      patterns: [
        { match: '->', name: 'keyword.operator.arrow.gosu' },
        { match: '\\\\', name: 'keyword.operator.block.gosu' },
        { match: '\\?\\.|\\?:|\\?\\[|\\|?\\.\\.\\|?', name: 'keyword.operator.gosu' },
        { match: '===|!==|==|!=|<=|>=|&&|\\|\\||[+\\-*/%&|^]=?|<<=?|>>>?=?|=|!|~|<|>|\\?|:', name: 'keyword.operator.gosu' }
      ]
    },
    calls: {
      match: `(${ID})\\s*(?=\\()`, captures: { 1: { name: 'entity.name.function.call.gosu' } }
    },
    braces: {
      begin: '\\{', end: '\\}',
      beginCaptures: { 0: { name: 'punctuation.section.block.begin.gosu' } },
      endCaptures: { 0: { name: 'punctuation.section.block.end.gosu' } },
      patterns: [{ include: '#code' }]
    }
  }
};

export default gosu;

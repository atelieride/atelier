import { describe, expect, test } from 'vitest';
import { NOTION_ID, notionId, notionIdFromLink } from './notion-link';

// The full matrix of shapes is in src/main/connectors/notion/markup.test.ts (main re-exports these); here, that the
// renderer's picker and main read a pasted link with the very same rule (Review Focus 2).
const ID = '00000006000040008000000000000006';

describe('notionId', () => {
  test('32 hex, dashes optional, any case → lowercase dashless; else null', () => {
    expect(notionId('00000006-0000-4000-8000-000000000006')).toBe(ID);
    expect(notionId(ID)).toBe(ID);
    expect(notionId(`${ID}0`)).toBeNull();
    expect(NOTION_ID.test(ID)).toBe(true);
  });
});

describe('notionIdFromLink', () => {
  test('Notion links and bare ids → the id', () => {
    expect(notionIdFromLink(`https://www.notion.so/acme/Backlog-${ID}?v=${'b'.repeat(32)}`)).toBe(ID);
    expect(notionIdFromLink(`https://app.notion.com/p/${ID}`)).toBe(ID);
    expect(notionIdFromLink(`notion.so/${ID}#heading`)).toBe(ID);
    expect(notionIdFromLink(`https://acme.notion.site/Roadmap-${ID}`)).toBe(ID);
    expect(notionIdFromLink(`  ${ID.toUpperCase()} `)).toBe(ID);
  });
  test('anything else → null', () => {
    expect(notionIdFromLink('tasks')).toBeNull();
    expect(notionIdFromLink(`https://example.com/${ID}`)).toBeNull();
    expect(notionIdFromLink(`http://www.notion.so/${ID}`)).toBeNull();
    expect(notionIdFromLink(`https://www.notion.so/${ID}x`)).toBeNull();
  });
});

'use strict';

// Slack's mrkdwn does not render pipe tables. The API does support native table blocks, so this
// module recognizes the small Markdown-table shape language models already produce and upgrades
// it at the final delivery boundary. The original text remains the fallback for notifications,
// accessibility, history, and every caller that does not support blocks.

const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMNS = 20;
const MAX_TABLE_CHARS = 10000;
const MAX_SECTION_CHARS = 2900;
const MAX_MESSAGE_BLOCKS = 50;

const SLACK_TABLE_FORMATTING_INSTRUCTION = '\n\nSLACK FORMATTING: When the answer genuinely compares at least two records across at least two labeled columns, use a compact Markdown pipe table with a header separator row. Do not wrap the table in a code fence. The Slack delivery layer renders valid pipe tables as native tables. Use ordinary prose or bullets for everything else.';

function splitMarkdownTableRow(line) {
  let source = String(line || '').trim();
  if (source.startsWith('|')) source = source.slice(1);
  if (source.endsWith('|') && !source.endsWith('\\|')) source = source.slice(0, -1);

  const cells = [];
  let cell = '';
  let escaped = false;
  let inCode = false;
  for (const char of source) {
    if (escaped) {
      cell += char === '|' ? '|' : `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '`') {
      inCode = !inCode;
      cell += char;
      continue;
    }
    if (char === '|' && !inCode) {
      cells.push(cleanCell(cell));
      cell = '';
      continue;
    }
    cell += char;
  }
  if (escaped) cell += '\\';
  cells.push(cleanCell(cell));
  return cells;
}

function cleanCell(value) {
  let text = String(value || '').trim().replace(/<br\s*\/?\s*>/gi, '\n');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)');
  text = text.replace(/<(https?:\/\/[^>|]+)\|([^>]+)>/g, '$2 ($1)');
  const wrappers = [['**', '**'], ['__', '__'], ['~~', '~~'], ['`', '`']];
  for (const [start, end] of wrappers) {
    if (text.startsWith(start) && text.endsWith(end) && text.length > start.length + end.length) {
      text = text.slice(start.length, -end.length).trim();
      break;
    }
  }
  return text || ' ';
}

function isDividerRow(cells, expectedColumns) {
  return cells.length === expectedColumns && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function parseTableAt(lines, start) {
  if (start + 2 >= lines.length || !String(lines[start]).includes('|')) return null;
  const header = splitMarkdownTableRow(lines[start]);
  if (header.length < 2 || header.length > MAX_TABLE_COLUMNS) return null;
  const divider = splitMarkdownTableRow(lines[start + 1]);
  if (!isDividerRow(divider, header.length)) return null;

  const rows = [header];
  let end = start + 2;
  while (end < lines.length && String(lines[end]).trim() && String(lines[end]).includes('|')) {
    const row = splitMarkdownTableRow(lines[end]);
    if (row.length !== header.length) return null;
    rows.push(row);
    end++;
  }
  if (rows.length < 2 || rows.length > MAX_TABLE_ROWS) return null;
  const characterCount = rows.flat().reduce((total, cell) => total + cell.length, 0);
  if (characterCount > MAX_TABLE_CHARS) return null;
  return { rows, end, characterCount };
}

function headerCell(text) {
  return {
    type: 'rich_text',
    elements: [{
      type: 'rich_text_section',
      elements: [{ type: 'text', text, style: { bold: true } }],
    }],
  };
}

function numericColumn(rows, columnIndex) {
  const values = rows.slice(1).map(row => row[columnIndex]).filter(value => value.trim());
  return values.length > 0 && values.every(value => /^[-+]?[$£€]?\(?[\d,.]+\)?%?$/.test(value));
}

function toTableBlock(rows) {
  return {
    type: 'table',
    column_settings: rows[0].map((cell, index) => ({
      is_wrapped: true,
      ...(numericColumn(rows, index) ? { align: 'right' } : {}),
    })),
    rows: rows.map((row, rowIndex) => row.map(cell => rowIndex === 0
      ? headerCell(cell)
      : { type: 'raw_text', text: cell })),
  };
}

function splitSectionText(text) {
  const remaining = String(text || '').trim();
  if (!remaining) return [];
  const chunks = [];
  let rest = remaining;
  while (rest.length > MAX_SECTION_CHARS) {
    let splitAt = rest.lastIndexOf('\n', MAX_SECTION_CHARS);
    if (splitAt < Math.floor(MAX_SECTION_CHARS / 2)) splitAt = MAX_SECTION_CHARS;
    chunks.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.map(chunk => ({ type: 'section', text: { type: 'mrkdwn', text: chunk } }));
}

function markdownTablesToBlocks(text) {
  const lines = String(text || '').split(/\r?\n/);
  const blocks = [];
  let prose = [];
  let inCodeFence = false;
  let convertedTables = 0;
  let tableCharacters = 0;

  const flushProse = () => {
    blocks.push(...splitSectionText(prose.join('\n')));
    prose = [];
  };

  for (let index = 0; index < lines.length;) {
    if (/^\s*```/.test(lines[index])) {
      inCodeFence = !inCodeFence;
      prose.push(lines[index]);
      index++;
      continue;
    }
    const table = inCodeFence ? null : parseTableAt(lines, index);
    if (!table) {
      prose.push(lines[index]);
      index++;
      continue;
    }
    if (tableCharacters + table.characterCount > MAX_TABLE_CHARS) return null;
    flushProse();
    blocks.push(toTableBlock(table.rows));
    convertedTables++;
    tableCharacters += table.characterCount;
    index = table.end;
  }
  flushProse();

  if (!convertedTables || blocks.length > MAX_MESSAGE_BLOCKS) return null;
  return blocks;
}

function formatSlackMessagePayload(text) {
  const fallback = String(text || '').trim();
  const blocks = markdownTablesToBlocks(fallback);
  return blocks ? { text: fallback, blocks } : { text: fallback };
}

module.exports = {
  SLACK_TABLE_FORMATTING_INSTRUCTION,
  splitMarkdownTableRow,
  markdownTablesToBlocks,
  formatSlackMessagePayload,
};

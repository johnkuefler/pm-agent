'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sourceRegion } = require('../helpers/server-source');
const { splitMarkdownTableRow, markdownTablesToBlocks,
  formatSlackMessagePayload } = require('../../src/surfaces/slack/table-format');
const { postSlackMessage, postSlackMessageReceipt } = require('../../src/surfaces/slack/web-api');

test('Slack pipe-table rows preserve escaped pipes and inline code pipes', () => {
  assert.deepEqual(splitMarkdownTableRow('| Client | Detail |'), ['Client', 'Detail']);
  assert.deepEqual(splitMarkdownTableRow('| Acme \\| West | `A | B` |'), ['Acme | West', 'A | B']);
});

test('Slack messages upgrade valid pipe tables into native table blocks', () => {
  const text = [
    'Here is the workload:',
    '',
    '| Person | Hours | Status |',
    '| --- | ---: | --- |',
    '| Santi | 32 | Available |',
    '| Maya | 41 | Booked |',
    '',
    'Santi has the most room.',
  ].join('\n');

  const payload = formatSlackMessagePayload(text);
  assert.equal(payload.text, text, 'the original final text remains the accessibility fallback');
  assert.equal(payload.blocks.length, 3);
  assert.equal(payload.blocks[0].type, 'section');
  assert.equal(payload.blocks[1].type, 'table');
  assert.equal(payload.blocks[1].rows.length, 3);
  assert.equal(payload.blocks[1].rows[0][0].elements[0].elements[0].style.bold, true);
  assert.equal(payload.blocks[1].rows[1][0].text, 'Santi');
  assert.equal(payload.blocks[1].column_settings[1].align, 'right');
  assert.equal(payload.blocks[2].text.text, 'Santi has the most room.');
});

test('Slack leaves ordinary, malformed, and code-fenced tables as plain text', () => {
  assert.equal(formatSlackMessagePayload('One short answer.').blocks, undefined);
  assert.equal(markdownTablesToBlocks('| A | B |\n| --- | --- |\n| only one cell |'), null);
  assert.equal(markdownTablesToBlocks('```\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```'), null);
});

test('Slack Web API delivery uses native table blocks without losing thread or fallback text', async () => {
  const calls = [];
  const text = '| Name | Due |\n| --- | --- |\n| Homepage | Friday |';
  const posted = await postSlackMessage('C123', text, '1712345.0001', {
    post: async (url, payload) => {
      calls.push({ url, payload });
      return { data: { ok: true, ts: '1712345.0002' } };
    },
  });

  assert.equal(posted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.text, text);
  assert.equal(calls[0].payload.thread_ts, '1712345.0001');
  assert.equal(calls[0].payload.blocks[0].type, 'table');
});

test('Slack direct-message delivery returns the durable channel and message receipt', async () => {
  const calls = [];
  const receipt = await postSlackMessageReceipt('UMALLORY', 'Exact proposal', undefined, {
    post: async (url, payload) => {
      calls.push({ url, payload });
      if (url.endsWith('/conversations.open')) return { data: { ok: true, channel: { id: 'DMALLORY' } } };
      return { data: { ok: true, channel: 'DMALLORY', ts: '1712345.0003' } };
    },
  });
  assert.deepEqual(receipt, { ok: true, channel: 'DMALLORY', ts: '1712345.0003', error: null });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].payload.channel, 'DMALLORY');
});

test('Slack table rendering happens only after the final financial egress guard', () => {
  const handler = sourceRegion('async function handleSlackImpl', 'async function getNoraBotUserId');
  const finalFinancialGuard = handler.lastIndexOf('if (!financialApproved && containsFinancialContent(reply))');
  const tableFormatting = handler.indexOf('formatSlackMessagePayload(segments[i])');
  const tablePrompt = handler.indexOf('SLACK_TABLE_FORMATTING_INSTRUCTION + diagnosisInstruction');
  const fittedPrompt = handler.indexOf('fitSlackSystemPrompt(slackStable, tail, urlBlock)');
  assert.ok(finalFinancialGuard >= 0);
  assert.ok(tableFormatting > finalFinancialGuard,
    'native blocks must be built from the final scrubbed segment, never from the raw model reply');
  assert.ok(tablePrompt >= 0 && fittedPrompt > tablePrompt,
    'the Slack-only prompt must teach the model the pipe-table shape before prompt fitting');
});

const { normalizeMemoryRecord, memoryIsActive } = require('../../intelligence/models');
const memoryLifecycle = require('../../intelligence/memory-lifecycle');

const INTERACTIVE_RECALL_STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'been', 'before', 'being', 'could', 'does', 'from',
  'have', 'here', 'into', 'just', 'like', 'more', 'nora', 'only', 'really', 'should',
  'slack', 'some', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'through', 'today', 'very', 'want', 'what', 'when', 'where', 'which', 'while', 'with',
  'would', 'your', 'youre', 'zoom',
]);

function createInteractiveMemoryRecall({
  loadMemory,
  isDbReady,
  writeThrough,
  db,
  markerKeyForFact,
}) {
  function interactiveRecallTokens(value) {
    return (String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])
      .filter(term => !INTERACTIVE_RECALL_STOPWORDS.has(term));
  }

  function rankLexicalMemories(items, queryText, limit = 8) {
    const terms = [...new Set(interactiveRecallTokens(queryText))].slice(-48);
    if (!terms.length || !Array.isArray(items) || !items.length) return [];
    const candidates = items
      .map(item => normalizeMemoryRecord(item))
      .filter(item => item.fact && memoryIsActive(item)
        && item.source !== 'opinion' && item.source !== 'learning' && !markerKeyForFact(item.fact))
      .map(item => {
        const text = `${item.fact} ${item.project || ''}`.toLowerCase();
        const tokens = new Set(interactiveRecallTokens(text));
        return { item, text, tokens };
      });
    if (!candidates.length) return [];
    const documentFrequency = new Map(terms.map(term => [term,
      candidates.reduce((count, candidate) => count + (candidate.tokens.has(term) ? 1 : 0), 0)]));
    const queryNormalized = terms.join(' ');
    const ranked = candidates.map(candidate => {
      const matched = terms.filter(term => candidate.tokens.has(term));
      const lexical = matched.reduce((score, term) => score
        + Math.log((candidates.length + 1) / ((documentFrequency.get(term) || 0) + 1)) + 1, 0);
      const project = String(candidate.item.project || '').trim().toLowerCase();
      const projectBoost = project.length >= 3 && queryNormalized.includes(project) ? 8 : 0;
      const score = lexical + projectBoost + matched.length
        + (Number(candidate.item.salience) || 0) * 0.5
        + (Number(candidate.item.emotional_weight) || 0) * 0.25
        + (Number(candidate.item.social_weight) || 0) * 0.25;
      return { ...candidate.item, _score: score, _matched_terms: matched.length,
        _recall_mode: 'local_lexical' };
    }).filter(item => item._matched_terms > 0 && item._score >= 2.5)
      .sort((left, right) => right._score - left._score
        || String(right.added || '').localeCompare(String(left.added || '')));
    const partition = memoryLifecycle.partitionMemory(ranked);
    return memoryLifecycle.selectTieredRecall(
      partition.working, partition.long_term, limit);
  }

  function retrieveInteractiveMemories(queryText, limit = 8) {
    const ranked = rankLexicalMemories(loadMemory(), queryText, limit);
    const ids = ranked.map(item => item.id).filter(Boolean);
    if (ids.length && isDbReady()) writeThrough('memory', () => db.bumpMemoryRecall(ids));
    return ranked;
  }

  return { interactiveRecallTokens, rankLexicalMemories, retrieveInteractiveMemories };
}

module.exports = { createInteractiveMemoryRecall };

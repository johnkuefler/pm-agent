const test = require('node:test');
const assert = require('node:assert/strict');
const dreamIdeaSeed = require('../../src/intelligence/dream-idea-seed');

test('dream idea seeds bind an exact stored spark and reveal later source drift', () => {
  const dream = {
    id: 'dream-1', date: '2026-07-16',
    reflection: { ideas: ['Try a phase-specific handoff check'] },
  };
  const seed = dreamIdeaSeed.seedFor(dream, 0);
  assert.equal(seed.id, 'dream-1:idea:0');
  assert.equal(dreamIdeaSeed.verifySnapshot(seed), true);
  assert.deepEqual(dreamIdeaSeed.resolve(seed, [dream]), seed);
  assert.throws(() => dreamIdeaSeed.resolve({ ...seed, content_commitment: '0'.repeat(64) }, [dream]), /commitment/);

  const experiment = { id: 'experiment-1', source_refs: [seed] };
  assert.equal(dreamIdeaSeed.list([dream], [experiment])[0].status, 'used');
  dream.reflection.ideas[0] = 'A rewritten idea';
  const audit = dreamIdeaSeed.audit(seed, [dream]);
  assert.equal(audit.source_exists, true);
  assert.equal(audit.content_commitment_verified, false);
});

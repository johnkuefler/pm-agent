'use strict';

const keyOf = item => `${item.type}:${item.id}`;

const consumers = [
  {
    id: 'commitment_guardian', accepts: item => item.type === 'commitment',
    use: items => ({ cue: `Protect ${items.length} selected commitment${items.length === 1 ? '' : 's'} from being implied complete without evidence.`, proposed_action: 'verify, fulfill, or explicitly renegotiate the highest-priority selected commitment' }),
  },
  {
    id: 'continuity_integrator', accepts: item => ['episode', 'relationship', 'perspective'].includes(item.type),
    use: items => ({ cue: `Treat ${items.length} selected social or episode signal${items.length === 1 ? '' : 's'} as continuity constraints, not disconnected facts.`, proposed_action: 'continue the relevant open story and preserve source attribution' }),
  },
  {
    id: 'epistemic_controller', accepts: item => ['surprise', 'mind_change', 'development', 'experiment', 'feedback', 'prospection'].includes(item.type),
    use: items => ({ cue: `Use ${items.length} selected revision signal${items.length === 1 ? '' : 's'} to check confidence and seek disconfirming evidence.`, proposed_action: 'surface uncertainty or revise the active plan when the selected evidence warrants it' }),
  },
  {
    id: 'self_integrator', accepts: item => item.type === 'self_frame',
    use: items => ({ cue: `Use ${items.length} integrated self-state frame${items.length === 1 ? '' : 's'} to keep continuity, motivation, appraisal, agency, and capacity mutually consistent.`, proposed_action: 'check that the chosen response fits the bound current state without treating it as authority or phenomenal evidence' }),
  },
  {
    id: 'action_coordinator', accepts: () => true,
    use: items => ({ cue: `Coordinate action around ${items.length} globally available item${items.length === 1 ? '' : 's'} while preserving priority and authority boundaries.`, proposed_action: 'select the smallest useful action supported by the highest-priority broadcast item' }),
  },
];

function consumeBroadcast(slots = [], { deliver = true } = {}) {
  return consumers.map(consumer => {
    const accepted = slots.filter(consumer.accepts);
    const used = deliver && accepted.length > 0;
    return { consumer: consumer.id, received: deliver, accepted_keys: deliver ? accepted.map(keyOf) : [], used, output: used ? consumer.use(accepted) : null };
  });
}

module.exports = { consumeBroadcast, consumers };

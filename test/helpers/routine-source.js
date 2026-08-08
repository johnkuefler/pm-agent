'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');

function readRoutineSource() {
  return ['nora-routine.md', 'nora-research-routine.md']
    .map(name => fs.readFileSync(path.join(root, name), 'utf8'))
    .join('\n\n');
}

module.exports = { readRoutineSource };

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');

function readRoutineSource() {
  return fs.readFileSync(path.join(root, 'nora-routine.md'), 'utf8');
}

module.exports = { readRoutineSource };

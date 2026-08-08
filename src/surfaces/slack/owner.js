'use strict';

function findJohnSlackId(memory = []) {
  for (const item of memory) {
    const match = /John Kuefler'?s Slack user ID is (U[A-Z0-9]{6,})/i.exec(item.fact || '');
    if (match) return match[1];
  }
  return null;
}

module.exports = { findJohnSlackId };

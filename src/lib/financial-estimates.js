'use strict';

function containsFinancialEstimate(text) {
  // Task intake must ask for effort. The old estimate-near-digits rule treated even
  // "estimate: 30 minutes" as money and replaced the whole clarification with a refusal.
  // Mask only explicit duration digits, preserving offsets and all other numbers.
  // Currency, rates, budgets and compensation are still checked on the ORIGINAL text
  // by the caller, so adding "hours" cannot hide an actual financial figure.
  const withoutDurations = String(text || '').replace(
    /\b\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(?:-|to|\u2013)\s*\d+(?:,\d{3})*(?:\.\d+)?)?\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|h|m)\b/gi,
    duration => duration.replace(/\d/g, ' '));
  return /\bestimate\b[^.\n]{0,40}\d/i.test(withoutDurations);
}

module.exports = { containsFinancialEstimate };

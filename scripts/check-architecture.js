'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILE = 'architecture-boundaries.json';
const MAX_DEFAULT_MODULE_LINES = 600;
const MAX_DEFAULT_MODULE_BYTES = 60000;
const ROUTE_CALL_PATTERN =
  /\b(?:app|router)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(/g;
const FACTORY_DEFINITION_PATTERN =
  /\b(?:function|const|let|var)\s+(register[A-Za-z0-9_]*(?:Route|Routes))\b/g;
const IMPORT_PATTERNS = [
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function toProjectPath(value) {
  return value.split(path.sep).join('/');
}

function countLines(source) {
  if (!source) return 0;
  return source.split(/\r?\n/).length;
}

function normalizedByteCount(source) {
  return Buffer.byteLength(source.replace(/\r\n/g, '\n'));
}

function listJavaScriptFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJavaScriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
  }
  return files;
}

function readConfiguration(rootDirectory) {
  const configPath = path.join(rootDirectory, CONFIG_FILE);
  let configuration;
  try {
    configuration = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${CONFIG_FILE}: ${error.message}`);
  }
  if (configuration.schema_version !== 1) {
    throw new Error(`${CONFIG_FILE} schema_version must be 1`);
  }
  const defaults = configuration.default_module_budget || {};
  if (!Number.isInteger(defaults.max_lines) || defaults.max_lines <= 0
    || !Number.isInteger(defaults.max_bytes) || defaults.max_bytes <= 0) {
    throw new Error(`${CONFIG_FILE} default_module_budget requires positive integer ceilings`);
  }
  if (defaults.max_lines > MAX_DEFAULT_MODULE_LINES
    || defaults.max_bytes > MAX_DEFAULT_MODULE_BYTES) {
    throw new Error(`${CONFIG_FILE} cannot raise the default ceiling above `
      + `${MAX_DEFAULT_MODULE_LINES} lines or ${MAX_DEFAULT_MODULE_BYTES} bytes`);
  }
  return configuration;
}

function relativeImportSpecifiers(source) {
  const specifiers = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith('.')) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function importTarget(rootDirectory, sourceFile, specifier) {
  const absoluteTarget = path.resolve(path.dirname(sourceFile), specifier);
  return toProjectPath(path.relative(rootDirectory, absoluteTarget))
    .replace(/(?:\/index)?(?:\.[cm]?js)?$/, '');
}

function startsIn(projectPath, directory) {
  return projectPath === directory || projectPath.startsWith(`${directory}/`);
}

function dependencyViolations(rootDirectory, projectFile, absoluteFile, source) {
  const violations = [];
  const sourceIsRoute = startsIn(projectFile, 'src/routes');
  const sourceIsIntelligence = startsIn(projectFile, 'src/intelligence');
  const sourceIsIntegration = startsIn(projectFile, 'src/integrations');

  for (const specifier of relativeImportSpecifiers(source)) {
    const target = importTarget(rootDirectory, absoluteFile, specifier);
    if (target === 'server' || target === 'db') {
      violations.push({
        rule: 'no-composition-root-import',
        file: projectFile,
        message: `imports ${specifier}; inject a narrow dependency instead`,
      });
      continue;
    }
    if (!sourceIsRoute && startsIn(target, 'src/routes')) {
      violations.push({
        rule: 'routes-are-edge-adapters',
        file: projectFile,
        message: `imports route layer via ${specifier}`,
      });
    }
    if (sourceIsIntelligence && startsIn(target, 'src/integrations')) {
      violations.push({
        rule: 'intelligence-is-provider-neutral',
        file: projectFile,
        message: `imports provider integration via ${specifier}`,
      });
    }
    if (sourceIsIntegration
      && (startsIn(target, 'src/intelligence') || startsIn(target, 'src/runtime'))) {
      violations.push({
        rule: 'integrations-use-injected-operations',
        file: projectFile,
        message: `imports implementation layer via ${specifier}`,
      });
    }
  }
  return violations;
}

function routeFactoryViolations(projectFile, source) {
  const routeCount = [...source.matchAll(ROUTE_CALL_PATTERN)].length;
  if (routeCount === 0) return [];
  if (!startsIn(projectFile, 'src/routes')) {
    return [{
      rule: 'routes-live-under-src-routes',
      file: projectFile,
      message: `contains ${routeCount} Express route declaration(s) outside src/routes`,
    }];
  }

  FACTORY_DEFINITION_PATTERN.lastIndex = 0;
  const factoryNames = [...source.matchAll(FACTORY_DEFINITION_PATTERN)].map(match => match[1]);
  const exportsAt = source.lastIndexOf('module.exports');
  const exportSource = exportsAt >= 0 ? source.slice(exportsAt) : '';
  if (factoryNames.length === 0 || !factoryNames.some(name => exportSource.includes(name))) {
    return [{
      rule: 'route-factory-export',
      file: projectFile,
      message: 'route modules must define and export a named register*Route(s) factory',
    }];
  }
  return [];
}

function assessArchitecture(rootDirectory = path.resolve(__dirname, '..')) {
  const root = path.resolve(rootDirectory);
  const configuration = readConfiguration(root);
  const defaultBudget = configuration.default_module_budget;
  const legacyBudgets = configuration.legacy_module_budgets || {};
  const inlineRouteBudgets = configuration.inline_route_budgets || {};
  const rootJavaScriptFiles = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => path.join(root, entry.name));
  const absoluteFiles = [
    ...rootJavaScriptFiles,
    ...listJavaScriptFiles(path.join(root, 'src')),
  ].filter(file => fs.existsSync(file));
  const violations = [];
  const files = {};

  for (const absoluteFile of absoluteFiles) {
    const projectFile = toProjectPath(path.relative(root, absoluteFile));
    const source = fs.readFileSync(absoluteFile, 'utf8');
    const measurement = {
      lines: countLines(source),
      bytes: normalizedByteCount(source),
      inline_routes: [...source.matchAll(ROUTE_CALL_PATTERN)].length,
    };
    files[projectFile] = measurement;
    const budget = legacyBudgets[projectFile] || defaultBudget;
    if (measurement.lines > budget.max_lines) {
      violations.push({
        rule: 'module-line-budget',
        file: projectFile,
        message: `${measurement.lines} lines exceeds ceiling ${budget.max_lines}; extract code`,
      });
    }
    if (measurement.bytes > budget.max_bytes) {
      violations.push({
        rule: 'module-byte-budget',
        file: projectFile,
        message: `${measurement.bytes} bytes exceeds ceiling ${budget.max_bytes}; extract code`,
      });
    }
    if (legacyBudgets[projectFile]
      && measurement.lines <= budget.max_lines
      && measurement.bytes <= budget.max_bytes
      && (measurement.lines < budget.max_lines || measurement.bytes < budget.max_bytes)) {
      const fitsDefaults = measurement.lines <= defaultBudget.max_lines
        && measurement.bytes <= defaultBudget.max_bytes;
      violations.push({
        rule: 'ratchet-legacy-budget',
        file: projectFile,
        message: fitsDefaults
          ? 'module now fits the default budget; remove its legacy budget'
          : `lower its ceilings to ${measurement.lines} lines and ${measurement.bytes} bytes`,
      });
    }
    if (projectFile.startsWith('src/')) {
      violations.push(...dependencyViolations(root, projectFile, absoluteFile, source));
    }
    if (projectFile !== 'server.js') {
      violations.push(...routeFactoryViolations(projectFile, source));
    }
  }

  for (const [projectFile, budget] of Object.entries(legacyBudgets)) {
    if (!Number.isInteger(budget.max_lines) || budget.max_lines <= 0
      || !Number.isInteger(budget.max_bytes) || budget.max_bytes <= 0) {
      violations.push({
        rule: 'valid-legacy-budget',
        file: projectFile,
        message: 'legacy line and byte ceilings must be positive integers',
      });
    }
    if (!files[projectFile]) {
      violations.push({
        rule: 'remove-stale-legacy-budget',
        file: projectFile,
        message: 'budget refers to a missing runtime module',
      });
    }
  }

  for (const [projectFile, ceiling] of Object.entries(inlineRouteBudgets)) {
    if (!Number.isInteger(ceiling) || ceiling < 0) {
      violations.push({
        rule: 'valid-inline-route-budget',
        file: projectFile,
        message: 'inline route ceiling must be a non-negative integer',
      });
      continue;
    }
    if (!files[projectFile]) {
      violations.push({
        rule: 'inline-route-budget-target',
        file: projectFile,
        message: 'inline route budget refers to a missing runtime module',
      });
      continue;
    }
    if (files[projectFile].inline_routes > ceiling) {
      violations.push({
        rule: 'inline-route-budget',
        file: projectFile,
        message: `${files[projectFile].inline_routes} inline routes exceeds ceiling ${ceiling}; `
          + 'move the route family to src/routes',
      });
    } else if (files[projectFile].inline_routes < ceiling) {
      violations.push({
        rule: 'ratchet-inline-route-budget',
        file: projectFile,
        message: `lower the inline route ceiling to ${files[projectFile].inline_routes}`,
      });
    }
  }

  return {
    valid: violations.length === 0,
    scanned_files: absoluteFiles.length,
    files,
    violations,
  };
}

function formatViolations(report) {
  if (report.valid) {
    return `Architecture check passed (${report.scanned_files} runtime modules scanned).`;
  }
  return [
    `Architecture check failed with ${report.violations.length} violation(s):`,
    ...report.violations.map(item => `- [${item.rule}] ${item.file}: ${item.message}`),
  ].join('\n');
}

function main() {
  try {
    const report = assessArchitecture();
    const output = `${formatViolations(report)}\n`;
    (report.valid ? process.stdout : process.stderr).write(output);
    if (!report.valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Architecture check could not run: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  CONFIG_FILE,
  MAX_DEFAULT_MODULE_BYTES,
  MAX_DEFAULT_MODULE_LINES,
  assessArchitecture,
  countLines,
  dependencyViolations,
  formatViolations,
  normalizedByteCount,
  relativeImportSpecifiers,
  routeFactoryViolations,
};

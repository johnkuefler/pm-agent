'use strict';

function createMcpStore({ fs, path, volumeDirectory, localDataDirectory, databaseReady,
  getCache, setCache, writeThrough, replaceAll } = {}) {
  const volumePath = path.join(volumeDirectory, 'nora-mcp.json');
  const localPath = path.join(localDataDirectory, 'nora-mcp.json');
  const filePath = () => fs.existsSync(volumeDirectory) ? volumePath : localPath;

  function load() {
    if (databaseReady()) return getCache();
    try { return JSON.parse(fs.readFileSync(filePath(), 'utf8')); }
    catch { return []; }
  }

  function save(list) {
    if (databaseReady()) {
      setCache(list);
      return writeThrough('mcp', () => replaceAll(list));
    }
    const target = filePath();
    const temporary = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(list, null, 2));
    fs.renameSync(temporary, target);
  }

  return { load, save };
}

module.exports = { createMcpStore };

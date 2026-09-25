const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const versionOf = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
function createTextbookFiles(registryFile) {
  let libraries = {};
  try { libraries = JSON.parse(fs.readFileSync(registryFile, 'utf8')); } catch { /* first run */ }
  const persist = () => { fs.mkdirSync(path.dirname(registryFile), { recursive: true }); fs.writeFileSync(registryFile, JSON.stringify(libraries)); };
  function rootFor(id) {
    const root = libraries[id];
    if (!root) throw new Error('找不到教材文件夹，请重新选择文件位置。');
    const canonical = fs.realpathSync(root);
    const key = p => process.platform === 'win32' ? p.toLowerCase() : p;
    if (key(canonical) !== key(root)) throw new Error('教材文件夹身份已变化，请重新选择文件位置。');
    return root;
  }
  function register(root, replaceId) {
    root = fs.realpathSync(root);
    if (!fs.statSync(root).isDirectory()) throw new Error('请选择教材文件夹。');
    const id = replaceId || Object.keys(libraries).find(k => libraries[k] === root) || crypto.randomUUID();
    libraries[id] = root; persist();
    return { id, name: path.basename(root) };
  }
  function resolve(id, relativePath) {
    const root = rootFor(id);
    if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) throw new Error('无效的教材相对路径。');
    const canonicalRoot = fs.realpathSync(root);
    const file = fs.realpathSync(path.resolve(canonicalRoot, relativePath));
    const rel = path.relative(canonicalRoot, file);
    if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) throw new Error('文件必须位于所选教材文件夹内。');
    return file;
  }
  function list(id) {
    const root = rootFor(id);
    const files = [];
    const walk = (dir) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.isSymbolicLink() || item.name.startsWith('.') || item.name === 'node_modules') continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) walk(full);
        else if (/\.(md|markdown)$/i.test(item.name)) files.push(path.relative(root, full).replaceAll('\\', '/'));
      }
    };
    walk(root); return files.sort();
  }
  function read(id, relativePath) {
    const file = resolve(id, relativePath);
    if (!/\.(md|markdown)$/i.test(file)) throw new Error('只支持 Markdown 文件。');
    const buffer = fs.readFileSync(file);
    if (buffer.length > 16 * 1024 * 1024) throw new Error('文件超过 16 MB，请拆分章节后打开。');
    return { content: buffer.toString('utf8'), version: versionOf(buffer) };
  }
  function save(id, relativePath, expectedVersion, content) {
    const file = resolve(id, relativePath);
    if (!/\.(md|markdown)$/i.test(file) || typeof content !== 'string') throw new Error('无效的 Markdown 文件。');
    if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new Error('文件超过 16 MB，未保存。');
    const temp = path.join(path.dirname(file), `.thoughtdag-${crypto.randomUUID()}.tmp`);
    const conflict = () => { throw new Error('文件已被外部修改，未覆盖。请保留草稿，重新读取后合并。'); };
    if (versionOf(fs.readFileSync(file)) !== expectedVersion) conflict();
    let fd;
    try {
      const buffer = Buffer.from(content, 'utf8');
      fd = fs.openSync(temp, 'wx', fs.statSync(file).mode);
      fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      // Re-check after preparing the replacement; a failed write leaves the
      // original intact. File identity must still be inside the selected root.
      if (resolve(id, relativePath) !== file || versionOf(fs.readFileSync(file)) !== expectedVersion) conflict();
      fs.renameSync(temp, file);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    return read(id, relativePath);
  }
  function image(id, relativePath) {
    const file = resolve(id, relativePath);
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif' }[path.extname(file).toLowerCase()];
    if (!mime) throw new Error('不支持此图片格式。');
    const buffer = fs.readFileSync(file);
    if (buffer.length > 24 * 1024 * 1024) throw new Error('图片超过 24 MB。');
    return `data:${mime};base64,${buffer.toString('base64')}`;
  }
  return { register, list, read, save, image };
}
module.exports = { createTextbookFiles };

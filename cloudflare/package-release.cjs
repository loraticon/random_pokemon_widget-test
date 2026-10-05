const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function zipFiles(directory, files, destination) {
  const headers = []; let offset = 0;
  const fd = fs.openSync(destination, 'w');
  try {
    for (const file of files) {
      const name = Buffer.from(file.split(path.sep).join('/'), 'utf8');
      const content = fs.readFileSync(path.join(directory, file));
      const packed = zlib.deflateRawSync(content);
      const crc = crc32(content);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
      local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
      fs.writeSync(fd, local); fs.writeSync(fd, name); fs.writeSync(fd, packed);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(33, 14);
      central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(content.length, 24);
      central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
      headers.push(central, name); offset += local.length + name.length + packed.length;
    }
    const central = Buffer.concat(headers);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
    fs.writeSync(fd, central); fs.writeSync(fd, end);
  } finally { fs.closeSync(fd); }
}
const installerFiles = ['worker.js', '먼저-읽어주세요.md'];
const installZip = path.join(root, 'cloudflare-개인설치.zip');
zipFiles(path.join(root, 'release', 'personal-worker'), installerFiles, installZip);
fs.copyFileSync(installZip, path.join(root, 'dist', 'downloads', '개인-Worker-설치.zip'));
function listFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) return listFiles(path.join(directory, entry.name), relative);
    if (!entry.isFile()) throw new Error('배포 파일에 링크를 포함할 수 없습니다: ' + relative);
    return [relative];
  });
}
zipFiles(path.join(root, 'dist'), listFiles(path.join(root, 'dist')), path.join(root, 'cloudflare-Pages-공용화면.zip'));
console.log('공용 Pages ZIP과 개인 Worker 설치 ZIP 갱신 완료');

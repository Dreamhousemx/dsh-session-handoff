const fs = require('fs')
const ASAR = 'D:/Dev Tools/DeepSeek Harness/resources/app.asar'
const pattern = process.argv[2]
const dirFilter = process.argv[3] || 'dsh-session'
const fd = fs.openSync(ASAR, 'r')
const h = Buffer.alloc(16); fs.readSync(fd, h, 0, 16, 0)
const hs = h.readUInt32LE(12)
const hb = Buffer.alloc(hs); fs.readSync(fd, hb, 0, hs, 16)
const header = JSON.parse(hb.toString('utf8').replace(/\0+$/, ''))
const dataOffset = 16 + hs
const files = []
;(function walk(n, p) {
  for (const [k, c] of Object.entries(n.files || {})) {
    const f = p + '/' + k
    if (c.files) walk(c, f)
    else files.push({ path: f, size: c.size, offset: c.offset })
  }
})(header, '')
const re = new RegExp(pattern)
for (const f of files) {
  if (!f.path.includes(dirFilter)) continue
  if (!/\.js$/.test(f.path)) continue
  const buf = Buffer.alloc(f.size)
  fs.readSync(fd, buf, 0, f.size, dataOffset + Number(f.offset))
  const text = buf.toString('utf8')
  if (!re.test(text)) continue
  console.log('=== ' + f.path)
  text.split('\n').forEach((line, i) => {
    if (re.test(line)) console.log('  ' + (i + 1) + ': ' + line.trim().slice(0, 220))
  })
}

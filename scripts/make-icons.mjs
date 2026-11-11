import sharp from 'sharp'
import fs from 'node:fs'
const svg = fs.readFileSync('public/icons/icon.svg')
const out = (n, s) => sharp(svg, { density: 300 }).resize(s, s).png().toFile(`public/icons/${n}.png`)
await out('icon-192', 192); await out('icon-512', 512); await out('apple-touch-icon', 180); await out('favicon-32', 32)
// maskable: full-bleed background + smaller glyph in safe zone
const mask = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#071419"/><g transform="translate(76 76) scale(0.7)">${svg.toString().replace(/<\/?svg[^>]*>/g,'').replace(/<defs>.*<\/defs>/,'').replace(/<rect[^>]*>/,'')}</g></svg>`
await sharp(Buffer.from(mask), { density: 300 }).resize(512, 512).png().toFile('public/icons/icon-maskable-512.png')

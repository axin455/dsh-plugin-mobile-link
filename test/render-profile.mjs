// Prints the desktop profile manifest with the local plugin registered.
// The caller writes stdout to package.json as UTF-8 **without BOM** (a BOM
// makes the host fail to parse its manifest).
import fs from 'node:fs'
import path from 'node:path'

const source = process.argv[2] || process.env.DSH_PROFILE_MANIFEST
const pluginPath = path.resolve(process.argv[3] || process.cwd())

if (!source) {
  console.error('usage: node test/render-profile.mjs <path/to/profile/package.json> [plugin-dir]')
  process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync(source, 'utf8'))
manifest.dependencies = manifest.dependencies || {}
manifest.dependencies['dsh-plugin-mobile-link'] = `link:${pluginPath.replace(/\\/g, '/')}`

const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
  ? manifest.dsh.profile.bundles.filter((name) => name !== 'dsh-plugin-mobile-gateway')
  : []
if (!bundles.includes('dsh-plugin-mobile-link')) bundles.push('dsh-plugin-mobile-link')
manifest.dsh.profile.bundles = bundles
// 官方 mobile-gateway 的隧道/配对校验会和本插件冲突，这里不再加载它。
if (manifest.dependencies['dsh-plugin-mobile-gateway']) {
  delete manifest.dependencies['dsh-plugin-mobile-gateway']
}

// stdout is written verbatim by the caller; keep diagnostics on stderr.
process.stdout.write(JSON.stringify(manifest, null, 2))
console.error('bundles:', bundles.join(', '))

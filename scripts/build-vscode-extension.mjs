import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = path.join(root, 'extensions', 'vscode');
const outputDir = path.join(root, 'dist', 'vscode');
const staging = path.join(outputDir, 'staging');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'package.json'), 'utf8'));
const vsix = path.join(outputDir, `agentdeck-vscode-${manifest.version}.vsix`);

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(path.join(staging, 'extension', 'dist'), { recursive: true });
await build({
  entryPoints: [path.join(extensionDir, 'src', 'extension.js')],
  outfile: path.join(staging, 'extension', 'dist', 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
});
fs.copyFileSync(path.join(extensionDir, 'package.json'), path.join(staging, 'extension', 'package.json'));
fs.copyFileSync(path.join(extensionDir, 'README.md'), path.join(staging, 'extension', 'README.md'));
fs.writeFileSync(path.join(staging, '[Content_Types].xml'), `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>\n`);
fs.writeFileSync(path.join(staging, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${manifest.name}" Version="${manifest.version}" Publisher="${manifest.publisher}" />
    <DisplayName>${manifest.displayName}</DisplayName>
    <Description xml:space="preserve">${manifest.description}</Description>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${manifest.engines.vscode}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>\n`);
fs.mkdirSync(outputDir, { recursive: true });
fs.rmSync(vsix, { force: true });
execFileSync('zip', ['-q', '-r', vsix, '.'], { cwd: staging });
fs.rmSync(staging, { recursive: true, force: true });
console.log(`[agentdeck] built ${path.relative(root, vsix)}`);

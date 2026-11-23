// Копирует библиотеки и шрифты из node_modules в static/vendor, чтобы сайт не зависел от CDN.
// Результат коммитится: сайт запускается одним Python, без Node.
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(siteDir, 'static', 'vendor');
// пакеты лежат в node_modules сайта (pnpm ставит симлинки); exports у lenis не открывает package.json
const pkgDir = (name) => join(siteDir, 'node_modules', name);

mkdirSync(join(out, 'fonts'), { recursive: true });

copyFileSync(join(pkgDir('lenis'), 'dist', 'lenis.min.js'), join(out, 'lenis.min.js'));
copyFileSync(join(pkgDir('canvas-confetti'), 'dist', 'confetti.browser.js'), join(out, 'confetti.browser.js'));

const fonts = [
  ['@fontsource/montserrat', 'Montserrat', 'montserrat', [400, 700, 900]],
  ['@fontsource/open-sans', 'Open Sans', 'open-sans', [400, 600]],
];
// Диапазоны как в @fontsource: браузер качает только нужный набор символов
const ranges = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  cyrillic: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
};

let css = '/* Сгенерировано scripts/vendor.mjs — не править руками */\n';
for (const [pkg, family, slug, weights] of fonts) {
  for (const weight of weights) {
    for (const subset of Object.keys(ranges)) {
      const file = `${slug}-${subset}-${weight}-normal.woff2`;
      copyFileSync(join(pkgDir(pkg), 'files', file), join(out, 'fonts', file));
      css += `@font-face{font-family:'${family}';font-style:normal;font-display:swap;font-weight:${weight};` +
        `src:url(fonts/${file}) format('woff2');unicode-range:${ranges[subset]}}\n`;
    }
  }
}
writeFileSync(join(out, 'fonts.css'), css);
console.log('vendor: lenis, confetti, шрифты →', out);

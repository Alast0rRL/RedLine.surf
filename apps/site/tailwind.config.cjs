/** Сборка: pnpm --filter @redline/site build → static/build/site.css */
module.exports = {
  content: ['./templates/**/*.html', './static/js/**/*.js'],
  darkMode: 'class',
  theme: {
    extend: {
      // Цвета из packages/redline-ui/src/tokens.css; <alpha-value> сохраняет модификаторы вида bg-redline-red/50
      colors: {
        'redline-red': 'rgb(var(--rl-red-500-rgb) / <alpha-value>)',
        'dark-bg': 'rgb(var(--rl-ink-950-rgb) / <alpha-value>)',
        'dark-gray': 'rgb(var(--rl-ink-900-rgb) / <alpha-value>)',
      },
      fontFamily: {
        montserrat: ['var(--rl-font-display)'],
        'open-sans': ['var(--rl-font-body)'],
      },
    },
  },
};

/** Индекс цвета заглушки аватара (data-color="0..7") — стабильный по строке. */
export function avatarColor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % 8;
}

/** Инициалы: «Мари» → «М», «Иван Петров» → «ИП», «@bob:server» → «B». */
export function initials(name) {
  const clean = name.replace(/^[@#!+]/, '').replace(/:.*$/, '').trim();
  const words = clean.split(/[\s_.-]+/u).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[1]] : [clean];
  return letters.map((w) => [...w][0] ?? '').join('').toUpperCase() || '?';
}

import DOMPurify from 'dompurify';

/**
 * Очистка formatted_body (org.matrix.custom.html) по белому списку из спецификации Matrix:
 * https://spec.matrix.org/latest/client-server-api/#mroommessage-msgtypes
 * <img> не пропускаем: mxc:// без авторизации всё равно не загрузить.
 */

const ALLOWED_TAGS = [
  'font', 'del', 's', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'p', 'a', 'ul', 'ol', 'sup', 'sub',
  'li', 'b', 'i', 'u', 'strong', 'em', 'strike', 'code', 'hr', 'br', 'div', 'table', 'thead', 'tbody', 'tr',
  'th', 'td', 'caption', 'pre', 'span', 'details', 'summary', 'mx-reply',
];
const ALLOWED_ATTR = ['href', 'data-mx-color', 'data-mx-bg-color', 'color', 'class', 'start', 'colspan', 'rowspan', 'data-mx-spoiler'];
const SAFE_HREF = /^(https?:|mailto:|matrix:|tel:)/i;
const COLOR = /^#[0-9a-f]{3,8}$/i;

let hooked = false;
function installHooks() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (!SAFE_HREF.test(href)) el.removeAttribute('href');
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    // цвета Matrix → inline style, только валидный hex
    const fg = el.getAttribute('data-mx-color') ?? (el.tagName === 'FONT' ? el.getAttribute('color') : null);
    const bg = el.getAttribute('data-mx-bg-color');
    const style: string[] = [];
    if (fg && COLOR.test(fg)) style.push(`color:${fg}`);
    if (bg && COLOR.test(bg)) style.push(`background-color:${bg}`);
    if (style.length) el.setAttribute('style', style.join(';'));
    // классы — только подсветка языка в <code>
    const cls = el.getAttribute('class');
    if (cls && !(el.tagName === 'CODE' && /^language-[\w-]+$/.test(cls))) el.removeAttribute('class');
  });
}

export function sanitizeMatrixHtml(html: string): string {
  installHooks();
  // style во входном HTML запрещён: его ставит только хук выше из проверенных data-mx-*
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
  });
  // ответы (mx-reply) показываем своим способом — цитату из formatted_body убираем
  return linkifyPhonesHtml(clean.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, ''));
}

// РФ: +7 / 7 / 8 и 10 цифр; международные: +код и 8–14 цифр. Разделители: пробел, дефис, скобки.
const PHONE_RE = /(?:\+7|[78])[\s-]*\(?\d{3}\)?[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)|\+\d{1,3}(?:[\s-]*\(?\d{2,4}\)?){2,5}(?!\d)/g;

export type PhonePart = { text: string; tel?: string };

/** Разбивает текст на куски; у телефонов есть tel (значение для href="tel:…"). */
export function splitPhones(text: string): PhonePart[] {
  const out: PhonePart[] = [];
  let last = 0;
  for (const m of text.matchAll(PHONE_RE)) {
    const idx = m.index ?? 0;
    if (idx < last || (idx > 0 && /[\w+]/.test(text[idx - 1]))) continue;
    const raw = m[0].replace(/[\s-]+$/, ''); // хвостовой разделитель к номеру не относится
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) continue;
    let tel: string;
    if (raw.startsWith('+')) tel = `+${digits}`;
    else if (digits.length === 11) tel = `+7${digits.slice(1)}`;
    else continue;
    if (idx > last) out.push({ text: text.slice(last, idx) });
    out.push({ text: raw, tel });
    last = idx + raw.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Оборачивает телефоны в уже очищенном HTML в ссылки tel:; a, code и pre не трогаем. */
export function linkifyPhonesHtml(html: string): string {
  if (!/\d{3}/.test(html)) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest('a, code, pre')) nodes.push(n as Text);
  }
  let changed = false;
  for (const node of nodes) {
    const parts = splitPhones(node.data);
    if (!parts.some((p) => p.tel)) continue;
    changed = true;
    const holder = doc.createElement('span');
    holder.innerHTML = parts.map((p) => (p.tel ? `<a href="tel:${esc(p.tel)}">${esc(p.text)}</a>` : esc(p.text))).join('');
    node.replaceWith(...Array.from(holder.childNodes));
  }
  return changed ? doc.body.innerHTML : html;
}

/** Ответы в body начинаются с «> <@user> текст» — срезаем фолбэк. */
export function stripReplyFallback(body: string): string {
  if (!body.startsWith('> ')) return body;
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('> ')) i++;
  if (lines[i] === '') i++;
  return lines.slice(i).join('\n');
}

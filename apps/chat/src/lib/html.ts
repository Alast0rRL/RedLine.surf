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
const SAFE_HREF = /^(https?:|mailto:|matrix:)/i;
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
  return clean.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, '');
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

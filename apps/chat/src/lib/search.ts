import { type MatrixEvent } from 'matrix-js-sdk';
import { isUndecryptable } from './events';
import { hasServerId, isTextMessage, plainBody } from './messageActions';

/** Регистр не важен, «ё» = «е». Длина строки не меняется, поэтому индексы совпадают с исходным текстом. */
export function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    let l = ch.toLowerCase();
    if (l.length !== ch.length) l = l.slice(0, ch.length);
    out += l === 'ё' ? 'е' : l;
  }
  return out;
}

/** id событий с текстом, подходящих под запрос, от старых к новым. */
export function findMatches(events: MatrixEvent[], query: string): string[] {
  const q = fold(query.trim());
  if (!q) return [];
  const out: string[] = [];
  for (const ev of events) {
    if (!hasServerId(ev) || !isTextMessage(ev) || isUndecryptable(ev)) continue;
    if (fold(plainBody(ev)).includes(q)) out.push(ev.getId()!);
  }
  return out;
}

/** Куски текста: совпадения помечены. */
export function splitMarks(text: string, query: string): { text: string; hit: boolean }[] {
  const q = fold(query.trim());
  if (!q) return [{ text, hit: false }];
  const f = fold(text);
  const out: { text: string; hit: boolean }[] = [];
  let from = 0;
  for (let i = f.indexOf(q); i >= 0; i = f.indexOf(q, from)) {
    if (i > from) out.push({ text: text.slice(from, i), hit: false });
    out.push({ text: text.slice(i, i + q.length), hit: true });
    from = i + q.length;
  }
  if (from < text.length) out.push({ text: text.slice(from), hit: false });
  return out.length ? out : [{ text, hit: false }];
}

/** То же для уже очищенного HTML: совпадения в текстовых узлах оборачиваются в <mark>. */
export function markHtml(html: string, query: string): string {
  if (!fold(query.trim())) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const node of nodes) {
    const parts = splitMarks(node.data, query);
    if (!parts.some((p) => p.hit)) continue;
    node.replaceWith(...parts.map((p) => {
      if (!p.hit) return doc.createTextNode(p.text);
      const m = doc.createElement('mark');
      m.textContent = p.text;
      return m;
    }));
  }
  return doc.body.innerHTML;
}

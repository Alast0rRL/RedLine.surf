import { getConfig } from '../config';

/** Логин в привычном виде: `@ded:redline.surf` → `ded@redline.surf`. */
export function formatLogin(userId: string): string {
  const m = /^@([^:]+):(.+)$/.exec(userId);
  return m ? `${m[1]}@${m[2]}` : userId;
}

/**
 * Что человек ввёл в поле «кого пригласить» → Matrix ID на нашем сервере.
 * Понимает `ded@redline.surf`, `@ded:redline.surf`, `@ded` и просто `ded`.
 * Чужие серверы не принимаем: федерации нет.
 */
export function parseLogin(input: string): { userId: string } | { error: string } {
  const server = getConfig().serverName;
  let v = input.trim().toLowerCase();
  if (!v) return { error: 'Введите логин' };
  let local: string;
  let domain = server;
  const email = /^([^@:\s]+)@([^@:\s]+)$/.exec(v);
  const mxid = /^@?([^@:\s]+)(?::([^@:\s]+))?$/.exec(v);
  if (email) [, local, domain] = email;
  else if (mxid) {
    local = mxid[1];
    if (mxid[2]) domain = mxid[2];
  } else return { error: `«${input.trim()}» не похоже на логин. Пример: example@${server}` };
  if (domain !== server) return { error: `Пригласить можно только людей с ${server}` };
  if (!/^[a-z0-9._=-]+$/.test(local)) return { error: `«${input.trim()}» не похоже на логин. Пример: example@${server}` };
  v = `@${local}:${server}`;
  return { userId: v };
}

/** Несколько логинов через запятую или пробел. */
export function parseLogins(input: string): { userIds: string[] } | { error: string } {
  const parts = input.split(/[\s,;]+/).filter(Boolean);
  if (!parts.length) return { error: 'Введите логин' };
  const ids: string[] = [];
  for (const p of parts) {
    const r = parseLogin(p);
    if ('error' in r) return r;
    if (!ids.includes(r.userId)) ids.push(r.userId);
  }
  return { userIds: ids };
}

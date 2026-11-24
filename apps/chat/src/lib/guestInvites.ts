import type { MatrixClient } from 'matrix-js-sdk';
import { freeUsername, loadLinks, loadMemberLinks, saveMemberLinks } from './invites';
import { newPerson, rememberPinUsers, type PersonalLink } from './pin';

export interface GuestInvite {
  token: string;
  label: string;
  user: string;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
}

export interface GuestInfo {
  user: string;
  invitedBy: string;
  inviteName: string;
  createdAt: number;
}

export interface InviteOverview {
  invites: GuestInvite[];
  guests: GuestInfo[];
  guest: boolean;
}

async function api<T>(method: string, path: string, body: unknown, token: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/invites/${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Нет связи с сервером');
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error || 'Не удалось выполнить запрос');
  return data;
}

export function loadInviteOverview(token: string): Promise<InviteOverview> {
  return api('GET', '', undefined, token);
}

export function loadGuests(token: string): Promise<GuestInfo[]> {
  return api<{ guests: GuestInfo[] }>('GET', 'guests', undefined, token).then((r) => r.guests);
}

function createToken(token: string, name: string, user: string): Promise<GuestInvite> {
  return api('POST', '', { name, user }, token);
}

function revokeToken(token: string, inviteToken: string): Promise<{ ok: boolean }> {
  return api('DELETE', `revoke/${encodeURIComponent(inviteToken)}`, undefined, token);
}

export async function createMemberInvite(client: MatrixClient, nameInput: string): Promise<PersonalLink> {
  const token = client.getAccessToken();
  if (!token) throw new Error('Нет связи с сервером');
  const name = nameInput.trim().slice(0, 40);
  if (!name) throw new Error('Введите имя');
  const [mine, adminLinks] = await Promise.all([loadMemberLinks(client), loadLinks(client).catch(() => [])]);
  const user = await freeUsername(client, name, [...mine, ...adminLinks]);
  const issued = await createToken(token, name, user);
  const link: PersonalLink = { ...newPerson(name, user), token: issued.token };
  try {
    await saveMemberLinks(client, [...mine.filter((l) => l.token !== link.token && l.user !== user), link]);
  } catch (e) {
    await revokeToken(token, issued.token).catch(() => undefined);
    throw e;
  }
  rememberPinUsers([user]);
  return link;
}

export async function revokeMemberInvite(client: MatrixClient, inviteToken: string): Promise<void> {
  const token = client.getAccessToken();
  if (!token) throw new Error('Нет связи с сервером');
  await revokeToken(token, inviteToken);
  const links = await loadMemberLinks(client).catch(() => []);
  await saveMemberLinks(client, links.filter((l) => l.token !== inviteToken)).catch(() => undefined);
}

export async function claimGuest(token: string, link: PersonalLink, created: boolean): Promise<void> {
  const key = `rl.guest-claim:${link.user}`;
  let pending = false;
  try {
    pending = localStorage.getItem(key) === 'pending';
  } catch {
    pending = false;
  }
  if (!created && !pending) return;
  try {
    await api('POST', 'claim', { token: link.token, user: link.user }, token);
    try {
      localStorage.removeItem(key);
    } catch {
      return;
    }
  } catch {
    try {
      localStorage.setItem(key, 'pending');
    } catch {
      return;
    }
  }
}

export function promoteGuest(token: string, user: string): Promise<{ user: string; guest: boolean }> {
  return api('POST', 'promote', { user }, token);
}

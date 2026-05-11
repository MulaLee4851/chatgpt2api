"use client";

import localforage from "localforage";

import type { UserKeyLimits, UserKeyPermissions, UserKeyUsage } from "@/lib/api";

export type AuthRole = "admin" | "user";

export type StoredAuthSession = {
  key: string;
  role: AuthRole;
  subjectId: string;
  name: string;
  permissions: UserKeyPermissions;
  limits: UserKeyLimits;
  usage: UserKeyUsage;
};

export const AUTH_KEY_STORAGE_KEY = "chatgpt2api_auth_key";
export const AUTH_SESSION_STORAGE_KEY = "chatgpt2api_auth_session";

const authStorage = localforage.createInstance({
  name: "chatgpt2api",
  storeName: "auth",
});

function normalizeSession(value: unknown, fallbackKey = ""): StoredAuthSession | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<StoredAuthSession>;
  const key = String(candidate.key || fallbackKey || "").trim();
  const role = candidate.role === "admin" || candidate.role === "user" ? candidate.role : null;
  if (!key || !role) {
    return null;
  }

  const permissionsCandidate = candidate.permissions;
  const permissions =
    permissionsCandidate && typeof permissionsCandidate === "object"
      ? {
          chat: Boolean((permissionsCandidate as Partial<UserKeyPermissions>).chat),
          image: Boolean((permissionsCandidate as Partial<UserKeyPermissions>).image),
        }
      : { chat: true, image: true };

  const limitsCandidate = candidate.limits;
  const limits =
    limitsCandidate && typeof limitsCandidate === "object"
      ? {
          expires_at: String((limitsCandidate as Partial<UserKeyLimits>).expires_at || "").trim() || null,
          max_tokens:
            (limitsCandidate as Partial<UserKeyLimits>).max_tokens == null
              ? null
              : Math.max(0, Number((limitsCandidate as Partial<UserKeyLimits>).max_tokens) || 0),
          max_images:
            (limitsCandidate as Partial<UserKeyLimits>).max_images == null
              ? null
              : Math.max(0, Number((limitsCandidate as Partial<UserKeyLimits>).max_images) || 0),
        }
      : { expires_at: null, max_tokens: null, max_images: null };

  const usageCandidate = candidate.usage;
  const usage =
    usageCandidate && typeof usageCandidate === "object"
      ? {
          used_tokens: Math.max(0, Number((usageCandidate as Partial<UserKeyUsage>).used_tokens) || 0),
          used_images: Math.max(0, Number((usageCandidate as Partial<UserKeyUsage>).used_images) || 0),
        }
      : { used_tokens: 0, used_images: 0 };

  return {
    key,
    role,
    subjectId: String(candidate.subjectId || "").trim(),
    name: String(candidate.name || "").trim(),
    permissions,
    limits,
    usage,
  };
}

export function getDefaultRouteForRole(role: AuthRole) {
  return role === "admin" ? "/accounts" : "/image";
}

export async function getStoredAuthKey() {
  if (typeof window === "undefined") {
    return "";
  }
  const value = await authStorage.getItem<string>(AUTH_KEY_STORAGE_KEY);
  return String(value || "").trim();
}

export async function getStoredAuthSession() {
  if (typeof window === "undefined") {
    return null;
  }

  const [storedKey, storedSession] = await Promise.all([
    authStorage.getItem<string>(AUTH_KEY_STORAGE_KEY),
    authStorage.getItem<StoredAuthSession>(AUTH_SESSION_STORAGE_KEY),
  ]);

  const normalizedSession = normalizeSession(storedSession, String(storedKey || ""));
  if (normalizedSession) {
    if (normalizedSession.key !== String(storedKey || "").trim()) {
      await authStorage.setItem(AUTH_KEY_STORAGE_KEY, normalizedSession.key);
    }
    return normalizedSession;
  }

  if (String(storedKey || "").trim()) {
    await clearStoredAuthSession();
  }
  return null;
}

export async function setStoredAuthSession(session: StoredAuthSession) {
  const normalizedSession = normalizeSession(session);
  if (!normalizedSession) {
    await clearStoredAuthSession();
    return;
  }

  await Promise.all([
    authStorage.setItem(AUTH_KEY_STORAGE_KEY, normalizedSession.key),
    authStorage.setItem(AUTH_SESSION_STORAGE_KEY, normalizedSession),
  ]);
}

export async function setStoredAuthKey(authKey: string) {
  const normalizedAuthKey = String(authKey || "").trim();
  if (!normalizedAuthKey) {
    await clearStoredAuthSession();
    return;
  }
  await authStorage.setItem(AUTH_KEY_STORAGE_KEY, normalizedAuthKey);
}

export async function clearStoredAuthSession() {
  if (typeof window === "undefined") {
    return;
  }
  await Promise.all([
    authStorage.removeItem(AUTH_KEY_STORAGE_KEY),
    authStorage.removeItem(AUTH_SESSION_STORAGE_KEY),
  ]);
}

export async function clearStoredAuthKey() {
  await clearStoredAuthSession();
}

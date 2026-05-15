"use client";

import { login } from "@/lib/api";
import { isRequestError } from "@/lib/request";
import { clearStoredAuthSession, getStoredAuthSession, setStoredAuthSession, type StoredAuthSession } from "@/store/auth";

export async function getValidatedAuthSession(): Promise<StoredAuthSession | null> {
  const storedSession = await getStoredAuthSession();
  if (!storedSession) {
    return null;
  }

  try {
    const data = await login(storedSession.key);
    const nextSession: StoredAuthSession = {
      key: storedSession.key,
      role: data.role,
      subjectId: data.subject_id,
      name: data.name,
      permissions: data.permissions,
      limits: data.limits,
      usage: data.usage,
    };
    await setStoredAuthSession(nextSession);
    return nextSession;
  } catch (error) {
    if (isRequestError(error) && (error.status === 401 || error.status === 403)) {
      await clearStoredAuthSession();
      return null;
    }
    return storedSession;
  }
}

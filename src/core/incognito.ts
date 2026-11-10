/**
 * Incognito chats: throwaway conversations that live only in memory.
 *
 * An incognito id never gets a session record, a Library file or a flue.db
 * row: `src/db.ts` routes every Flue store to an in-memory database for ids
 * with this prefix, so the conversation, its submissions and its attachments
 * die with the process and are never written to disk.
 */
export const INCOGNITO_PREFIX = 'inco_';

export const isIncognitoId = (id: string): boolean => id.startsWith(INCOGNITO_PREFIX);

export const newIncognitoId = (): string => `${INCOGNITO_PREFIX}${crypto.randomUUID()}`;

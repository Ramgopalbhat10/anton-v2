/** An incognito id never gets a session record, a Library file or a flue.db row: `src/db/adapter.ts` keeps its Flue stores in memory. */
export const INCOGNITO_PREFIX = 'inco_';

export const isIncognitoId = (id: string): boolean => id.startsWith(INCOGNITO_PREFIX);

export const newIncognitoId = (): string => `${INCOGNITO_PREFIX}${crypto.randomUUID()}`;

import type { HeadersData } from './types.js';

export const hasHeader = (headers: HeadersData | undefined, name: string): boolean => {
  const lower = name.toLowerCase();

  return Object.keys(headers ?? {}).some(key => key.toLowerCase() === lower);
};

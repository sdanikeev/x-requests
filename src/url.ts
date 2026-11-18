export const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

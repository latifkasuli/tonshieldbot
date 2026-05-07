export type JsonParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

export const parseUrl = (rawInput: string): URL | null => {
  try {
    return new URL(rawInput);
  } catch {
    return null;
  }
};

export const parseJson = (rawInput: string): JsonParseResult => {
  try {
    return { ok: true, value: JSON.parse(rawInput) as unknown };
  } catch {
    return { ok: false };
  }
};

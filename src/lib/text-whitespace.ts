export const pythonSpaceClass = "[\\u001c-\\u001f\\p{White_Space}]";

// Match Python str.split(), including U+001C..U+001F and U+0085 but not U+FEFF.
export const pythonSpace = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;

  return (code >= 28 && code <= 31) || /\p{White_Space}/u.test(character);
};

export const strip = (value: string): string => {
  const characters = Array.from(value);
  const start = characters.findIndex((character) => !pythonSpace(character));

  return start < 0 ? "" : characters.slice(start, characters.findLastIndex((character) => !pythonSpace(character)) + 1).join("");
};

import assigned from "../../../../resources/profile/unicode-assigned-15.1.json";

// DerivedAge15.1 includes assigned private-use and surrogate ranges. Its exact
// source/hash/license and the normalization-stability argument are in resources.
export const assignedInUnicode151 = (point: number): boolean => {
  let low = 0;
  let high = assigned.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const [start = 0, end = -1] = assigned[middle] ?? [];

    if (point < start) high = middle - 1;
    else if (point > end) low = middle + 1;
    else return true;
  }

  return false;
};

// UAX15 rev54 §3: normalization of old assigned strings is stable in newer
// Unicode versions. Old-unassigned characters have no decomposition and CCC0;
// keep them as unchanged barriers, not input to the engine's newer mappings.
export const nfkc151 = (text: string): string => {
  let result = "";
  let run = "";

  for (const character of text) {
    if (assignedInUnicode151(character.codePointAt(0) ?? -1)) run += character;
    else {
      result += run.normalize("NFKC") + character;
      run = "";
    }
  }

  return result + run.normalize("NFKC");
};

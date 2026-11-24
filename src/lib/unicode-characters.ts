import properties from "../../resources/profile/unicode-properties-15.1.json";

// Use frozen Unicode 15.1 categories in both Profile readers and the editor.
export const inRanges = (ranges: readonly (readonly number[])[], point: number): boolean => {
  let left = 0;
  let right = ranges.length - 1;

  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const [start = 0, end = -1] = ranges[middle] ?? [];

    if (point < start) right = middle - 1;
    else if (point > end) left = middle + 1;
    else return true;
  }

  return false;
};

export const decimalDigit = (character: string): boolean => inRanges(properties.decimal, character.codePointAt(0) ?? -1);

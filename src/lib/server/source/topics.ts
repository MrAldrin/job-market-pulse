import { pythonWordClass as W } from "../shared/text.ts";

// Fixed broad collection labels. They never admit or reject an ad.
const definitions = [
  ["data science", "data scienW*|datavitenW*|dataviterW*|dataanalytikerW*|data analystW*|statistiW*"],
  ["AI / machine learning", "ai|ki|ml|machine learning|maskinlæring|kunstig intelligens"],
  ["programming", "python|programmerW*|utviklerW*|systemutviklW*|developerW*|software|backendW*|frontendW*|fullstackW*"],
  ["databases / data engineering", "sql|databaseW*|data engineerW*|dataingeniørW*|dataplattformW*"],
] as const;

const patterns = definitions.map(([name, pattern]) => [name, new RegExp(`(?<!${W})(?:${pattern.replaceAll("W", W)})(?!${W})`, "iu")] as const);

export const sourceTopics = (value: string): readonly string[] => {
  const text = value.replace(/[İı]/gu, "i");

  return patterns.flatMap(([name, pattern]) => pattern.test(text) ? [name] : []);
};

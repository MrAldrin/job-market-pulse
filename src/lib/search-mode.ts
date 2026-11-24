export const searchModes = {
  passive: { label: "Just looking", help: "Recommend Exceptional jobs only." },
  active: { label: "Actively looking", help: "Recommend Exceptional and Strong jobs." },
} as const;

export type SearchMode = keyof typeof searchModes;

export const searchModeNotificationHelp = "Phone notifications, if enabled, alert you to new Exceptional jobs in either mode.";

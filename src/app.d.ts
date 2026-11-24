declare global {
  type PulseAppearance = "system" | "light" | "dark";

  interface Window {
    pulseAppearance?: { get: () => Promise<PulseAppearance>; set: (value: PulseAppearance) => Promise<void> };
  }

  namespace App {
    interface Locals {
      canGiveFeedback: boolean;
      canEditSettings: boolean;
      canRunRefresh: boolean;
    }
  }
}

export {};

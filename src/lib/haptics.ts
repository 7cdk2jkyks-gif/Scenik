import { isNativePlatform } from "@/lib/native";

export type ScenikHaptic = "success" | "selection" | "start" | "save" | "completion";

const webPatterns: Record<ScenikHaptic, number | number[]> = {
  success: [10, 35, 14],
  selection: 8,
  start: 12,
  save: 10,
  completion: [12, 45, 18],
};

/** Fire-and-forget feedback for deliberate, high-value actions only. */
export async function playHaptic(kind: ScenikHaptic): Promise<void> {
  try {
    if (isNativePlatform()) {
      const { Haptics, ImpactStyle, NotificationType } = await import("@capacitor/haptics");
      if (kind === "success" || kind === "completion") {
        await Haptics.notification({ type: NotificationType.Success });
      } else if (kind === "selection") {
        await Haptics.selectionChanged();
      } else {
        await Haptics.impact({ style: ImpactStyle.Light });
      }
      return;
    }

    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(webPatterns[kind]);
    }
  } catch {
    // Feedback is an enhancement and must never interrupt an action.
  }
}

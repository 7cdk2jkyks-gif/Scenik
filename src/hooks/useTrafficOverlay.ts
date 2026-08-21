import { useCallback, useState } from "react";

export function useTrafficOverlay(initiallyVisible = true) {
  const [showTraffic, setShowTraffic] = useState(initiallyVisible);
  const toggleTraffic = useCallback(() => setShowTraffic((visible) => !visible), []);
  return { showTraffic, toggleTraffic };
}

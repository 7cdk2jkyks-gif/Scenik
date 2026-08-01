let nativeAuthJustCompleted = false;

export function markNativeAuthCompleted(): void {
  nativeAuthJustCompleted = true;
}

export function consumeNativeAuthCompleted(): boolean {
  const completed = nativeAuthJustCompleted;
  nativeAuthJustCompleted = false;
  return completed;
}
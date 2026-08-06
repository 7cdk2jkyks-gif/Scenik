import process from "node:process";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isInternalTestUser(userId: string): boolean {
  return (process.env.SCENIK_INTERNAL_TEST_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => UUID_PATTERN.test(value))
    .includes(userId);
}

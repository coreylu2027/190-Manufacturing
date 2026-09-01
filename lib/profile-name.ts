import { z } from "zod";

export const shopNameSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(50).regex(/^[\p{L}][\p{L}'’-]*$/u, "Enter only one first name"),
  lastInitial: z.string().trim().length(1, "Enter one last initial").regex(/^\p{L}$/u, "Last initial must be a letter"),
});

export function formatShopName(firstName: string, lastInitial: string) {
  const trimmedFirstName = firstName.trim();
  const normalizedFirstName = `${trimmedFirstName.charAt(0).toLocaleUpperCase()}${trimmedFirstName.slice(1)}`;
  return `${normalizedFirstName} ${lastInitial.trim().toLocaleUpperCase()}.`;
}

export function isShopName(value: string) {
  return /^[\p{L}][\p{L}'’-]*\s+\p{L}\.$/u.test(value.trim());
}

import { z } from "zod";

export const SHOP_STORAGE_LOCATIONS = [
  "Clarke 1", "Clarke 2", "Clarke 3", "Clarke 4", "Clarke 5", "Clarke 6", "Clarke 7", "Clarke 8",
  "Kwolek 1-1", "Kwolek 1-2", "Kwolek 1-3", "Kwolek 1-4", "Kwolek 1-5", "Kwolek 1-6", "Kwolek 1-7", "Kwolek 1-8",
  "Kwolek 2-1", "Kwolek 2-2", "Kwolek 2-3", "Kwolek 2-4", "Kwolek 2-5", "Kwolek 2-6", "Kwolek 2-7", "Kwolek 2-8",
  "Hopper 1", "Hopper 2", "Hopper 3", "Hopper 4", "Hopper 5", "Hopper 6", "Hopper 7", "Hopper 8",
  "Jemison 1-1", "Jemison 1-2", "Jemison 1-3", "Jemison 1-4", "Jemison 1-5", "Jemison 1-6", "Jemison 1-7", "Jemison 1-8",
  "Jemison 2-1", "Jemison 2-2", "Jemison 2-3", "Jemison 2-4", "Jemison 2-5", "Jemison 2-6", "Jemison 2-7", "Jemison 2-8",
  "Shelf 1", "Shelf 2", "Shelf 3",
] as const;

export const ROBOT_LOCATION = "On Robot" as const;
export const STORAGE_LOCATIONS = [...SHOP_STORAGE_LOCATIONS, ROBOT_LOCATION] as const;

export type StorageLocation = (typeof STORAGE_LOCATIONS)[number];

export const STORAGE_LOCATION_GROUPS = [
  { name: "Clarke", locations: SHOP_STORAGE_LOCATIONS.slice(0, 8) },
  { name: "Kwolek", locations: SHOP_STORAGE_LOCATIONS.slice(8, 24) },
  { name: "Hopper", locations: SHOP_STORAGE_LOCATIONS.slice(24, 32) },
  { name: "Jemison", locations: SHOP_STORAGE_LOCATIONS.slice(32, 48) },
  { name: "Shelf", locations: SHOP_STORAGE_LOCATIONS.slice(48, 51) },
] as const;

export const storageLocationSchema = z.enum(STORAGE_LOCATIONS);

export function isStorageLocation(value: unknown): value is StorageLocation {
  return storageLocationSchema.safeParse(value).success;
}

export function canUseOnRobotLocation(qcPassed: boolean, finishingComplete: boolean) {
  return qcPassed && finishingComplete;
}

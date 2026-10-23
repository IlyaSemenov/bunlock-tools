export { parseBunLock } from "bunlock-lockfile"
export {
  analyzeDuplicatePackages,
  analyzeDuplicatePackagesWithUpdates,
  dedupeLockText,
  formatDuplicatesReport,
  RegistryError,
  updateAndDedupeLockText,
} from "./dedupe"

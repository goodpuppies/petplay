export type ActiveControllerIndexOptions = {
  cachedIndex: number | null;
  roleIndex: number;
  invalidIndex: number;
  maxDeviceCount: number;
  isActiveControllerForRole: (index: number) => boolean;
};

/**
 * Keep a valid controller selection stable, but recover when OpenVR leaves an
 * inactive controller (for example a Quest hand-tracking device) assigned to
 * the hand role after another controller set becomes active.
 */
export function selectActiveControllerIndex(
  options: ActiveControllerIndexOptions,
): number {
  const {
    cachedIndex,
    roleIndex,
    invalidIndex,
    maxDeviceCount,
    isActiveControllerForRole,
  } = options;

  const isUsableIndex = (index: number | null): index is number =>
    index != null && index !== invalidIndex && Number.isInteger(index) && index >= 0 &&
    index < maxDeviceCount;

  if (isUsableIndex(cachedIndex) && isActiveControllerForRole(cachedIndex)) {
    return cachedIndex;
  }

  if (
    roleIndex !== cachedIndex && isUsableIndex(roleIndex) &&
    isActiveControllerForRole(roleIndex)
  ) {
    return roleIndex;
  }

  for (let index = 0; index < maxDeviceCount; index++) {
    if (
      index !== cachedIndex && index !== roleIndex && isActiveControllerForRole(index)
    ) {
      return index;
    }
  }

  return invalidIndex;
}

/**
 * Applies the grid's latest selection for visible rows without discarding
 * selections that are temporarily hidden by search or filters.
 */
export function mergeVisibleSelection(
  currentIds: readonly number[],
  visibleIds: readonly number[],
  selectedVisibleIds: readonly number[],
) {
  const visible = new Set(visibleIds);
  return [...new Set([
    ...currentIds.filter((id) => !visible.has(id)),
    ...selectedVisibleIds,
  ])];
}

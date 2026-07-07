export function portFor(basePort: number, slot: number, slotSize: number): number {
  return basePort + slot * slotSize;
}

export function allocateSlot(
  takenSlots: Set<number>,
  minSlot = 1
): number {
  let slot = minSlot;
  while (takenSlots.has(slot)) slot++;
  return slot;
}

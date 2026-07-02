import net from "node:net";

/** Host port for a service at a given fork slot. Slot 0 is the baseline. */
export function portFor(basePort: number, slot: number, slotSize: number): number {
  return basePort + slot * slotSize;
}

/** True if the TCP port can be bound on localhost right now. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1" }, () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Pick the lowest slot >= minSlot whose ports (for every given basePort) are
 * neither reserved by existing instances nor currently bound on the host.
 */
export async function allocateSlot(opts: {
  basePorts: number[];
  slotSize: number;
  takenSlots: Set<number>;
  minSlot: number;
  maxSlot?: number;
}): Promise<number> {
  const { basePorts, slotSize, takenSlots, minSlot, maxSlot = 64 } = opts;
  for (let slot = minSlot; slot <= maxSlot; slot++) {
    if (takenSlots.has(slot)) continue;
    let ok = true;
    for (const base of basePorts) {
      if (!(await isPortFree(portFor(base, slot, slotSize)))) {
        ok = false;
        break;
      }
    }
    if (ok) return slot;
  }
  throw new Error(`No free port slot found in range ${minSlot}..${maxSlot}.`);
}

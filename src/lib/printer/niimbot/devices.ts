import type { DeviceEntry, DeviceRegistry, MediaDescriptor } from '@thermal-label/contracts';

/**
 * Device + media registry for the Niimbot family.
 *
 * There is no `@thermal-label/niimbot-core` package yet, so the
 * registry lives here in the same shape the other `*-core` packages
 * export. The wire protocol itself comes from `@mmote/niimbluelib`
 * (see `./printer.ts`); this module deliberately does NOT import it,
 * so `registry.ts` can list Niimbot devices without pulling the
 * driver into the main bundle.
 *
 * GATT values match niimbluelib's `BleDefaultConfiguration`. The
 * library resolves the characteristic at runtime by its properties
 * (notify + writeWithoutResponse); the UUID below is informational.
 */

const NIIMBOT_GATT = {
  serviceUuid: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  txCharacteristicUuid: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
} as const;

/** The D110 / D110_M heads are both 96 dots at 203 dpi (≈12 mm). */
const D110_DPI = 203;
const D110_HEAD_DOTS = 96;

export const DEVICES = {
  D110: {
    key: 'D110',
    name: 'D110',
    family: 'niimbot',
    transports: {
      'bluetooth-gatt': { ...NIIMBOT_GATT, namePrefix: 'D110' },
    },
    engines: [
      {
        role: 'primary',
        protocol: 'niimbot-d110',
        dpi: D110_DPI,
        headDots: D110_HEAD_DOTS,
        mediaCompatibility: ['d110'],
      },
    ],
    hardwareQuirks:
      'USB-C is charge-only — Bluetooth LE is the only data path. Prints without an RFID-tagged roll on firmware 13.x.',
    support: { status: 'untested' },
  },
  D110_M: {
    key: 'D110_M',
    name: 'D110_M',
    modelNames: ['D110M'],
    family: 'niimbot',
    transports: {
      'bluetooth-gatt': { ...NIIMBOT_GATT, namePrefix: 'D110' },
    },
    engines: [
      {
        role: 'primary',
        protocol: 'niimbot-b1',
        dpi: D110_DPI,
        headDots: D110_HEAD_DOTS,
        mediaCompatibility: ['d110'],
      },
    ],
    hardwareQuirks:
      'Often shipped in place of the D110. Some firmware (4.23) refuses to print without an RFID-tagged roll; outdated firmware has been reported to brick — update via the Niimbot app first.',
    support: { status: 'untested' },
  },
} as const satisfies Record<string, DeviceEntry>;

export type NiimbotDeviceKey = keyof typeof DEVICES;

export const DEVICE_REGISTRY: DeviceRegistry = {
  schemaVersion: 1,
  driver: 'niimbot',
  devices: Object.values(DEVICES),
};

/** Protocol tags this runtime can drive — every niimbluelib print task we route to. */
export const PROTOCOLS: ReadonlySet<string> = new Set(['niimbot-d110', 'niimbot-b1']);

/**
 * Map a niimbluelib `PrinterModel` name (from `getModelMetadata()`)
 * to a registry entry. Returns undefined for models we don't list yet.
 */
export function findDeviceByModel(model: string | undefined): DeviceEntry | undefined {
  if (!model) return undefined;
  return (DEVICES as Record<string, DeviceEntry>)[model];
}

function d110Label(widthMm: number, heightMm: number): MediaDescriptor {
  // Rolls wider than the 12 mm head print a centred 12 mm band.
  const sideMm = Math.max(0, (widthMm - 12) / 2);
  return {
    id: `niimbot-${widthMm}x${heightMm}`,
    name: `${widthMm} × ${heightMm} mm`,
    widthMm,
    heightMm,
    type: 'die-cut',
    category: 'die-cut',
    cornerRadiusMm: 1,
    defaultOrientation: 'horizontal',
    targetModels: ['d110'],
    ...(sideMm > 0
      ? { printMargins: { leftMm: sideMm, rightMm: sideMm, topMm: 0, bottomMm: 0 } }
      : {}),
  };
}

const MEDIA_LIST: readonly MediaDescriptor[] = [
  d110Label(12, 22),
  d110Label(12, 30),
  d110Label(12, 40),
  d110Label(12, 50),
  d110Label(14, 30),
  d110Label(14, 40),
  d110Label(14, 50),
  d110Label(15, 30),
  d110Label(15, 40),
  d110Label(15, 50),
];

export const MEDIA: Readonly<Record<string, MediaDescriptor>> = Object.fromEntries(
  MEDIA_LIST.map(m => [String(m.id), m]),
);

export const DEFAULT_MEDIA: MediaDescriptor = MEDIA['niimbot-12x40']!;

/**
 * Find a registry media entry matching physical dimensions (mm),
 * tolerating the rounding RFID / paper-info reports carry.
 */
export function findMediaBySize(widthMm: number, heightMm: number): MediaDescriptor | undefined {
  return MEDIA_LIST.find(
    m => Math.abs(m.widthMm - widthMm) < 1 && Math.abs((m.heightMm ?? 0) - heightMm) < 1,
  );
}

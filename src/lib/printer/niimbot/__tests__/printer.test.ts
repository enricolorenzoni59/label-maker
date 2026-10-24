import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeartbeatData, PrinterInfo, CombinedRfidInfo } from '@mmote/niimbluelib';

import { DEVICES, MEDIA } from '../devices';
import { WebNiimbotPrinter, type NiimbotClient } from '../printer';

type Listener = () => void;

function fakeClient(overrides: { heartbeat?: HeartbeatData; rfid?: CombinedRfidInfo } = {}) {
  const calls: string[] = [];
  const listeners = new Map<string, Set<Listener>>();
  const task = {
    printInit: vi.fn(async () => void calls.push('printInit')),
    printPage: vi.fn(async () => void calls.push('printPage')),
    waitForPageFinished: vi.fn(async () => void calls.push('waitForPageFinished')),
    waitForFinished: vi.fn(async () => void calls.push('waitForFinished')),
    printEnd: vi.fn(async () => {
      calls.push('printEnd');
      return true;
    }),
  };
  const protocol = {
    newPrintTask: vi.fn(() => task),
  };
  let heartbeat: HeartbeatData = overrides.heartbeat ?? { lidClosed: true, paperInserted: true };
  const info: PrinterInfo = {
    softwareVersion: '13.14',
    hardwareVersion: '13.10',
    batteryPercents: 75,
    settings: { powerSound: true, connectionSound: true },
  };
  const client = {
    protocol,
    isConnected: () => true,
    disconnect: vi.fn(async () => undefined),
    getModelMetadata: () => ({ densityMin: 1, densityMax: 3, densityDefault: 2 }),
    getPrintTaskType: () => 'D110',
    getPrinterInfo: () => info,
    getRfidInfo: () => overrides.rfid ?? {},
    getHeartbeatData: () => heartbeat,
    startHeartbeat: vi.fn(() => void calls.push('startHeartbeat')),
    stopHeartbeat: vi.fn(() => void calls.push('stopHeartbeat')),
    on: (event: string, fn: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    off: (event: string, fn: Listener) => listeners.get(event)?.delete(fn),
  };
  return {
    client: client as unknown as NiimbotClient,
    calls,
    task,
    protocol,
    setHeartbeat(next: HeartbeatData) {
      heartbeat = next;
      listeners.get('heartbeat')?.forEach(fn => fn());
    },
  };
}

const IMAGE = { width: 320, height: 96, data: new Uint8Array(320 * 96 * 4).fill(255) };

const TAGGED_ROLL: CombinedRfidInfo = {
  labelRfidInfo: {
    tagPresent: true,
    uuid: '88 1d 7a 3b',
    barCode: '6972842743589',
    serialNumber: 'PZ1G4012345',
    allPaper: 160,
    usedPaper: 12,
    consumablesType: 1,
  },
  paperInfo: { valid: false },
};

describe('WebNiimbotPrinter', () => {
  beforeEach(() => window.localStorage.clear());

  it('runs the print task with the heartbeat paused around it', async () => {
    const fake = fakeClient();
    const printer = new WebNiimbotPrinter(DEVICES.D110, fake.client);
    await printer.print(IMAGE, MEDIA['niimbot-12x40'], { copies: 2, density: 'dark' });

    expect(fake.calls).toEqual([
      'stopHeartbeat',
      'printInit',
      'printPage',
      'waitForPageFinished',
      'waitForFinished',
      'printEnd',
      'startHeartbeat',
    ]);
    expect(fake.protocol.newPrintTask).toHaveBeenCalledWith(
      'D110',
      expect.objectContaining({ totalPages: 2, density: 3 }),
    );
    const [encoded, quantity] = fake.task.printPage.mock.calls[0] as unknown as [
      { cols: number; rows: number },
      number,
    ];
    expect(encoded.cols).toBe(96);
    expect(encoded.rows).toBe(320);
    expect(quantity).toBe(2);
  });

  it('ends the job and resumes the heartbeat when printing fails', async () => {
    const fake = fakeClient();
    fake.task.printPage.mockRejectedValueOnce(new Error('timeout'));
    const printer = new WebNiimbotPrinter(DEVICES.D110, fake.client);
    await expect(printer.print(IMAGE, MEDIA['niimbot-12x40'])).rejects.toThrow('timeout');
    expect(fake.calls.slice(-2)).toEqual(['printEnd', 'startHeartbeat']);
  });

  it('maps light / normal density onto the model range', async () => {
    const fake = fakeClient();
    const printer = new WebNiimbotPrinter(DEVICES.D110, fake.client);
    await printer.print(IMAGE, undefined, { density: 'light' });
    await printer.print(IMAGE, undefined, { density: 'normal' });
    const densities = fake.protocol.newPrintTask.mock.calls.map(
      c => (c as unknown as [string, { density: number }])[1].density,
    );
    expect(densities).toEqual([1, 2]);
  });

  it('reports lid / paper state from the heartbeat and pushes updates', () => {
    const fake = fakeClient();
    const printer = new WebNiimbotPrinter(DEVICES.D110, fake.client);
    const seen: string[][] = [];
    const unsubscribe = printer.onStatus(s => seen.push(s.errors.map(e => e.code)));

    fake.setHeartbeat({ lidClosed: false, paperInserted: false });
    unsubscribe();
    fake.setHeartbeat({ lidClosed: true, paperInserted: true });

    expect(seen).toEqual([['cover_open', 'no_media']]);
  });

  it('builds a ready status with battery and firmware details', async () => {
    const printer = new WebNiimbotPrinter(DEVICES.D110, fakeClient().client);
    const status = await printer.getStatus();
    expect(status.ready).toBe(true);
    expect(status.battery?.fraction).toBe(0.75);
    expect(status.details).toContainEqual({ label: 'Firmware', value: '13.14' });
  });

  it('detects media from RFID paper info when dimensions are reported', async () => {
    const fake = fakeClient({
      rfid: { paperInfo: { valid: true, paperWidth: 12, paperHeight: 40 } },
    });
    const status = await new WebNiimbotPrinter(DEVICES.D110, fake.client).getStatus();
    expect(status.detectedMedia?.id).toBe('niimbot-12x40');
  });

  it('previews at head resolution and flags assumed media', async () => {
    const printer = new WebNiimbotPrinter(DEVICES.D110, fakeClient().client);
    const preview = await printer.createPreview(IMAGE);
    expect(preview.assumed).toBe(true);
    expect(preview.planes[0]!.bitmap.heightPx).toBe(96);
  });

  it('learns a tagged roll from a print and detects it on the next connection', async () => {
    const first = new WebNiimbotPrinter(DEVICES.D110, fakeClient({ rfid: TAGGED_ROLL }).client);
    expect((await first.getStatus()).detectedMedia).toBeUndefined();
    await first.print(IMAGE, { ...MEDIA['niimbot-12x40']! });

    const second = new WebNiimbotPrinter(DEVICES.D110, fakeClient({ rfid: TAGGED_ROLL }).client);
    const status = await second.getStatus();
    expect(status.detectedMedia?.id).toBe('niimbot-12x40');
    expect(status.details).toContainEqual({ label: 'Roll barcode', value: '6972842743589' });
  });

  it('does not learn from a failed print or an untagged roll', async () => {
    const failing = fakeClient({ rfid: TAGGED_ROLL });
    failing.task.printPage.mockRejectedValueOnce(new Error('timeout'));
    await expect(
      new WebNiimbotPrinter(DEVICES.D110, failing.client).print(IMAGE, MEDIA['niimbot-12x30']),
    ).rejects.toThrow();
    await new WebNiimbotPrinter(DEVICES.D110, fakeClient().client).print(
      IMAGE,
      MEDIA['niimbot-12x30'],
    );

    const status = await new WebNiimbotPrinter(
      DEVICES.D110,
      fakeClient({ rfid: TAGGED_ROLL }).client,
    ).getStatus();
    expect(status.detectedMedia).toBeUndefined();
  });
});
